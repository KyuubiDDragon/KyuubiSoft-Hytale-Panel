package com.kyuubisoft.api.commands;

import com.hypixel.hytale.logger.HytaleLogger;
import com.hypixel.hytale.server.core.command.system.CommandManager;
import com.kyuubisoft.api.websocket.EventBroadcaster;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;

/**
 * Owns the threads behind the command endpoints: command execution with
 * captured output, the command registry export and console-style completion.
 * Also watches the registry and broadcasts {@code commands_changed} when a
 * plugin adds or removes commands, so the panel refreshes its cached copy.
 *
 * <p>Nothing runs on Netty or world threads; every call returns a future.</p>
 */
public final class CommandService {

    private static final HytaleLogger LOGGER = HytaleLogger.get("KyuubiSoftAPI");
    private static final long WATCH_INTERVAL_SECONDS = 10;
    public static final int MAX_COMPLETIONS = 50;
    public static final int MAX_COMPLETION_LINE = 512;

    private final ScheduledExecutorService pool;
    private final CommandRunner runner;
    private volatile String lastRevision;

    public CommandService() {
        AtomicInteger threads = new AtomicInteger();
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(2, task -> {
            Thread thread = new Thread(task, "KyuubiSoftAPI-Commands-" + threads.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
        executor.setRemoveOnCancelPolicy(true);
        this.pool = executor;
        // Commands run where the server runs them, on the common pool.
        this.runner = new CommandRunner(pool, ForkJoinPool.commonPool());
    }

    /** Starts the registry watcher; changes are broadcast to the panel's WebSocket. */
    public void start(EventBroadcaster broadcaster) {
        pool.scheduleWithFixedDelay(() -> watchRegistry(broadcaster),
                WATCH_INTERVAL_SECONDS, WATCH_INTERVAL_SECONDS, TimeUnit.SECONDS);
    }

    public void shutdown() {
        pool.shutdownNow();
    }

    /** Command manager, or null before the command system is up. */
    static CommandManager manager() {
        try {
            return CommandManager.get();
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * Runs a command that already passed {@link CommandRunner#validate}.
     *
     * @return null when the command system is not available
     */
    public CompletableFuture<CommandResult> execute(String command, String actor, boolean echoToConsole, Long timeoutMs) {
        CommandManager manager = manager();
        if (manager == null) return null;
        return runner.run(manager, command, actor, echoToConsole, CommandRunner.clampTimeout(timeoutMs));
    }

    /**
     * Registry export, or only {@code {revision, unchanged:true}} when the
     * caller already has {@code ifRevision}.
     */
    public CompletableFuture<Object> registry(String ifRevision) {
        return CompletableFuture.supplyAsync(() -> {
            CommandManager manager = manager();
            if (manager == null) throw new IllegalStateException("Command system not available");
            if (ifRevision != null && !ifRevision.isBlank()) {
                String current = CommandCatalog.revision(manager);
                if (current.equals(ifRevision.trim())) return new Unchanged(current);
            }
            return CommandCatalog.export(manager);
        }, pool);
    }

    /**
     * Suggestions for the last token of {@code line}, exactly like the server
     * console's tab completion (sub commands, argument values such as player
     * names, {@code --option} names).
     */
    public CompletableFuture<Completion> complete(String line) {
        return CompletableFuture.supplyAsync(() -> {
            CommandManager manager = manager();
            if (manager == null) throw new IllegalStateException("Command system not available");
            List<String> words = new ArrayList<>(Arrays.asList(line.stripLeading().split("\\s+", -1)));
            int wordIndex = words.size() - 1;
            List<String> suggestions = manager.suggestCompletions(new PanelCommandSender(null, false), words, wordIndex);
            List<String> capped = suggestions.size() > MAX_COMPLETIONS ? suggestions.subList(0, MAX_COMPLETIONS) : suggestions;
            return new Completion(wordIndex, words.get(wordIndex), List.copyOf(capped), suggestions.size() > MAX_COMPLETIONS);
        }, pool);
    }

    private void watchRegistry(EventBroadcaster broadcaster) {
        try {
            CommandManager manager = manager();
            if (manager == null) return;
            String revision = CommandCatalog.revision(manager);
            String previous = lastRevision;
            lastRevision = revision;
            if (previous != null && !previous.equals(revision) && broadcaster != null) {
                int count = CommandCatalog.rootCommands(manager).size();
                broadcaster.broadcastCommandsChanged(revision, count);
            }
        } catch (RuntimeException | LinkageError e) {
            // A registration racing the snapshot; the next run catches up. Must
            // not escape, or the scheduler would stop running this task.
            LOGGER.at(Level.FINE).withCause(e).log("Command registry check failed");
        }
    }

    /** Reply to {@code GET /api/commands?ifRevision=…} when nothing changed. */
    static final class Unchanged {
        final String revision;
        final boolean unchanged = true;

        Unchanged(String revision) {
            this.revision = revision;
        }
    }

    /** Reply to {@code GET /api/commands/complete}. */
    public static final class Completion {
        final int wordIndex;
        final String prefix;
        final List<String> suggestions;
        final boolean truncated;

        Completion(int wordIndex, String prefix, List<String> suggestions, boolean truncated) {
            this.wordIndex = wordIndex;
            this.prefix = prefix;
            this.suggestions = suggestions;
            this.truncated = truncated;
        }
    }
}
