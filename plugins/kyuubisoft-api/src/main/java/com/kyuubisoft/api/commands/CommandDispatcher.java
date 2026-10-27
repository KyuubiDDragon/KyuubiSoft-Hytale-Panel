package com.kyuubisoft.api.commands;

import com.hypixel.hytale.logger.HytaleLogger;
import com.hypixel.hytale.server.core.Message;
import com.hypixel.hytale.server.core.command.system.AbstractCommand;
import com.hypixel.hytale.server.core.command.system.CommandManager;
import com.hypixel.hytale.server.core.command.system.CommandSender;
import com.hypixel.hytale.server.core.command.system.ParseResult;
import com.hypixel.hytale.server.core.command.system.ParserContext;
import com.hypixel.hytale.server.core.command.system.Tokenizer;
import com.hypixel.hytale.server.core.command.system.exceptions.CommandException;

import java.util.List;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;
import java.util.logging.Level;

/**
 * Runs a command line the way the server's dispatcher does (same tokenizer,
 * parser, permission checks and messages to the sender) but keeps track of how
 * it ended. {@code CommandManager.handleCommand} completes its future normally
 * for an unknown command, a syntax error or a missing permission; this
 * dispatcher reports those as {@link CommandOutcome#NOT_FOUND} and
 * {@link CommandOutcome#REJECTED}.
 *
 * <p>Same approach as KyuubiSoft Core's {@code CommandUtils.dispatch}. If the
 * server's command internals ever change incompatibly (a linkage error before
 * the command itself started), the line is handed to {@code handleCommand}
 * instead and the outcome is derived from the message ids the sender received
 * (see {@link CommandRunner}).</p>
 */
final class CommandDispatcher {

    private static final HytaleLogger LOGGER = HytaleLogger.get("KyuubiSoftAPI");

    static final String MESSAGE_NOT_FOUND = "server.modules.command.notFound";
    static final String MESSAGE_ERROR = "server.modules.command.error";

    private CommandDispatcher() {
    }

    /**
     * Starts the command on {@code executor}. The returned future never
     * completes exceptionally and completes on whichever thread the command
     * finishes on; never block a world or Netty thread on it.
     */
    static CompletableFuture<CommandOutcome> dispatch(CommandManager manager, CommandSender sender,
                                                      String line, Executor executor) {
        CompletableFuture<CommandOutcome> result = new CompletableFuture<>();
        try {
            executor.execute(() -> run(manager, sender, line, result));
        } catch (RuntimeException e) {
            LOGGER.at(Level.WARNING).log("Could not start command %s: %s", line, e.getMessage());
            result.complete(CommandOutcome.FAILED);
        }
        return result;
    }

    private static void run(CommandManager manager, CommandSender sender, String line,
                            CompletableFuture<CommandOutcome> result) {
        Thread thread = Thread.currentThread();
        String oldName = thread.getName();
        thread.setName(oldName + " -- Running: " + line);
        // Once the command itself runs, a failure must never start it again.
        boolean started = false;
        try {
            AbstractCommand command = manager.resolveCommand(rootName(line));
            if (command == null) {
                sender.sendMessage(Message.translation(MESSAGE_NOT_FOUND).param("cmd", line));
                result.complete(CommandOutcome.NOT_FOUND);
                return;
            }
            LOGGER.at(Level.INFO).log("%s executed command: %s", sender.getUsername(), line);
            ParseResult parse = new ParseResult();
            List<String> tokens = Tokenizer.parseArguments(line, parse);
            if (rejected(parse, sender, result)) return;
            ParserContext context = ParserContext.of(tokens, line, parse);
            if (rejected(parse, sender, result)) return;
            started = true;
            CompletableFuture<Void> running = command.acceptCall(sender, context, parse);
            if (rejected(parse, sender, result)) return;
            if (running == null) {
                result.complete(CommandOutcome.DONE);
                return;
            }
            running.whenComplete((ignored, error) -> {
                if (error == null) {
                    result.complete(CommandOutcome.DONE);
                    return;
                }
                Throwable cause = unwrap(error);
                // A command that fails its future with a CommandException has
                // already told the sender why, like the server assumes as well.
                if (!(cause instanceof CommandException) && !(cause instanceof CancellationException)) {
                    LOGGER.at(Level.SEVERE).withCause(error).log("Failed to execute command %s for %s", line, sender.getUsername());
                    sender.sendMessage(Message.translation(MESSAGE_ERROR)
                            .param("cmd", line).param("msg", String.valueOf(cause.getMessage())));
                }
                result.complete(CommandOutcome.FAILED);
            });
        } catch (CommandException e) {
            e.sendTranslatedMessage(sender);
            result.complete(CommandOutcome.FAILED);
        } catch (LinkageError e) {
            if (started) {
                // Thrown by the command's own code (e.g. a mod missing an optional class).
                fail(sender, line, e, result);
                return;
            }
            LOGGER.at(Level.WARNING).log("Command dispatch fell back to CommandManager.handleCommand: %s", e);
            manager.handleCommand(sender, line).whenComplete((ignored, error) ->
                    result.complete(error == null ? CommandOutcome.DONE : CommandOutcome.FAILED));
        } catch (Throwable t) {
            fail(sender, line, t, result);
        } finally {
            thread.setName(oldName);
        }
    }

    private static void fail(CommandSender sender, String line, Throwable t, CompletableFuture<CommandOutcome> result) {
        LOGGER.at(Level.SEVERE).withCause(t).log("Failed to execute command %s for %s", line, sender.getUsername());
        sender.sendMessage(Message.translation(MESSAGE_ERROR)
                .param("cmd", line).param("msg", String.valueOf(t.getMessage())));
        result.complete(CommandOutcome.FAILED);
    }

    private static boolean rejected(ParseResult parse, CommandSender sender, CompletableFuture<CommandOutcome> result) {
        if (!parse.failed()) return false;
        parse.sendMessages(sender);
        result.complete(CommandOutcome.REJECTED);
        return true;
    }

    private static Throwable unwrap(Throwable error) {
        Throwable t = error;
        while (t instanceof CompletionException && t.getCause() != null && t.getCause() != t) t = t.getCause();
        return t;
    }

    /** Lower-cased name of the command a line starts with (how the server registers names). */
    static String rootName(String line) {
        int space = line.indexOf(' ');
        return (space < 0 ? line : line.substring(0, space)).toLowerCase(Locale.ROOT);
    }
}
