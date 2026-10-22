package com.kyuubisoft.api.commands;

import com.hypixel.hytale.logger.HytaleLogger;
import com.hypixel.hytale.server.core.command.system.CommandManager;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Level;

/**
 * Runs one panel command and turns what happened into a {@link CommandResult}:
 * input checks, a {@link PanelCommandSender} that captures the answer, the
 * outcome from {@link CommandDispatcher}, a reply deadline and a short wait
 * for messages a command sends right after it finished.
 *
 * <p>Nothing here blocks: the reply future completes on a timer or command
 * thread, and the HTTP layer writes the response from there.</p>
 */
public final class CommandRunner {

    private static final HytaleLogger LOGGER = HytaleLogger.get("KyuubiSoftAPI");

    static final int MAX_COMMAND_LENGTH = 4096;
    static final long DEFAULT_TIMEOUT_MS = 5_000;
    static final long MIN_TIMEOUT_MS = 500;
    static final long MAX_TIMEOUT_MS = 30_000;
    /** Commands often send their last message from a world thread just after they returned. */
    static final long LATE_MESSAGE_GRACE_MS = 200;

    static final String NOT_FOUND_PREFIX = CommandDispatcher.MESSAGE_NOT_FOUND;
    // Ids the server uses when it refuses a command line, and for errors a
    // command reports itself before returning normally (no player given, …).
    static final String PARSING_ERROR_PREFIX = "server.commands.parsing.error.";
    static final String COMMAND_ERROR_PREFIX = "server.commands.errors.";

    private final ScheduledExecutorService timers;
    private final Executor commandExecutor;

    /**
     * @param timers          deadline and grace timers
     * @param commandExecutor where commands run; the server itself uses the common pool
     */
    public CommandRunner(ScheduledExecutorService timers, Executor commandExecutor) {
        this.timers = timers;
        this.commandExecutor = commandExecutor;
    }

    /** Why a command line is refused before it reaches the server, or null if it may run. */
    public static String validate(String command) {
        if (command == null || command.isBlank()) return "Command is required";
        if (command.length() > MAX_COMMAND_LENGTH) return "Command is longer than " + MAX_COMMAND_LENGTH + " characters";
        if (containsControlCharacters(command)) return "Command must be a single line without control characters";
        return null;
    }

    /**
     * C0 and C1 controls, DEL and the Unicode line/paragraph separators. The
     * panel rejects these already; checked here again so a second line can
     * never reach the command system through this endpoint.
     */
    public static boolean containsControlCharacters(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x20 || c == 0x7F || (c >= 0x80 && c <= 0x9F) || c == ' ' || c == ' ') return true;
        }
        return false;
    }

    /** Trimmed line without the leading "/" the command system does not expect. */
    static String normalize(String command) {
        String line = command.trim();
        return line.startsWith("/") ? line.substring(1).trim() : line;
    }

    static long clampTimeout(Long requested) {
        if (requested == null || requested <= 0) return DEFAULT_TIMEOUT_MS;
        return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, requested));
    }

    /**
     * Runs a validated command line. The future completes with the outcome, at
     * the latest after {@code timeoutMs} with {@link CommandOutcome#RUNNING}.
     */
    public CompletableFuture<CommandResult> run(CommandManager manager, String command, String actor,
                                                boolean echoToConsole, long timeoutMs) {
        String line = normalize(command);
        PanelCommandSender sender = new PanelCommandSender(actor, echoToConsole);
        long started = System.nanoTime();
        CompletableFuture<CommandResult> reply = new CompletableFuture<>();
        AtomicBoolean replied = new AtomicBoolean();
        AtomicReference<CommandOutcome> known = new AtomicReference<>();

        Runnable finish = () -> {
            if (!replied.compareAndSet(false, true)) return;
            sender.seal();
            CommandOutcome outcome = known.get() != null ? known.get() : CommandOutcome.RUNNING;
            reply.complete(buildResult(outcome, line, sender, started));
        };

        ScheduledFuture<?> deadline = timers.schedule(finish, timeoutMs, TimeUnit.MILLISECONDS);
        CommandDispatcher.dispatch(manager, sender, line, commandExecutor).whenComplete((outcome, error) -> {
            CommandOutcome value = outcome != null ? outcome : CommandOutcome.FAILED;
            known.set(value);
            if (replied.get()) {
                LOGGER.at(Level.INFO).log("%s command finished after its reply was sent: %s -> %s",
                        sender.getUsername(), line, value);
                return;
            }
            deadline.cancel(false);
            if (value != CommandOutcome.DONE) {
                finish.run();
                return;
            }
            try {
                timers.schedule(finish, LATE_MESSAGE_GRACE_MS, TimeUnit.MILLISECONDS);
            } catch (RejectedExecutionException shuttingDown) {
                finish.run();
            }
        });
        return reply;
    }

    /** Outcome adjusted by the message ids the sender received, plus a short error text. */
    static CommandResult buildResult(CommandOutcome outcome, String line, PanelCommandSender sender, long startedNanos) {
        PanelCommandSender.Captured captured = sender.snapshot();
        CommandOutcome refined = refine(outcome, captured);
        long durationMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
        return new CommandResult(refined, line, sender.getUsername(), captured, errorText(refined, line, captured), durationMs);
    }

    /**
     * A command that only reports its own error (for example "no player given")
     * still returns normally; the error message ids reveal it. They also
     * classify the outcome when dispatch had to fall back to the server's
     * dispatcher, which hides it.
     */
    static CommandOutcome refine(CommandOutcome outcome, PanelCommandSender.Captured captured) {
        if (outcome != CommandOutcome.DONE && outcome != CommandOutcome.RUNNING) return outcome;
        if (captured.hasMessageIdWithPrefix(NOT_FOUND_PREFIX)) return CommandOutcome.NOT_FOUND;
        if (captured.hasMessageIdWithPrefix(PARSING_ERROR_PREFIX)) return CommandOutcome.REJECTED;
        if (captured.hasMessageIdWithPrefix(COMMAND_ERROR_PREFIX)) return CommandOutcome.REJECTED;
        if (captured.hasMessageIdWithPrefix(CommandDispatcher.MESSAGE_ERROR)) return CommandOutcome.FAILED;
        return outcome;
    }

    static String errorText(CommandOutcome outcome, String line, PanelCommandSender.Captured captured) {
        String first = captured.firstLine();
        return switch (outcome) {
            case DONE, RUNNING -> null;
            case NOT_FOUND -> "Unknown command: " + CommandDispatcher.rootName(line);
            case REJECTED -> first != null ? first : "Command rejected";
            case FAILED -> first != null ? first : "Command failed";
        };
    }
}
