package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.command.system.CommandManager;
import com.hypixel.hytale.server.core.console.ConsoleSender;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/**
 * Executes Hytale server commands in-process as the server console.
 *
 * <p>Player-action endpoints (heal, kill, teleport, gamemode, …) are implemented
 * by dispatching the server's own, fully-tested commands through
 * {@link CommandManager#handleCommand} as {@link ConsoleSender#INSTANCE}. This is
 * deliberately preferred over hand-rolled ECS writes: it reuses the exact
 * behaviour (and client/network sync) the vanilla commands already implement,
 * and the command strings mirror the ones the panel previously sent over the
 * Docker console — so syntax stays in one place.</p>
 *
 * <p>The dispatch is asynchronous ({@code handleCommand} returns a
 * {@link CompletableFuture}); we wait up to {@link #COMMAND_TIMEOUT_MS} for it to
 * settle so the HTTP caller gets a synchronous-feeling result. A timeout is
 * treated as "queued" (success) rather than failure, because the command was
 * accepted by the dispatcher.</p>
 */
public final class CommandExecutor {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final long COMMAND_TIMEOUT_MS = 3000;

    private CommandExecutor() {
    }

    /**
     * Dispatch a single console command. The leading slash is optional and
     * stripped — the command dispatcher expects the bare "name args" form.
     *
     * @return a PlayersHandler.ActionResult describing the outcome
     */
    public static PlayersHandler.ActionResult run(String command) {
        if (command == null || command.isBlank()) {
            return new PlayersHandler.ActionResult(false, "Empty command");
        }
        String normalized = command.startsWith("/") ? command.substring(1) : command;

        try {
            CommandManager manager = CommandManager.get();
            if (manager == null) {
                return new PlayersHandler.ActionResult(false, "Command system not available");
            }

            CompletableFuture<Void> future = manager.handleCommand(ConsoleSender.INSTANCE, normalized);
            if (future != null) {
                try {
                    future.get(COMMAND_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                } catch (java.util.concurrent.TimeoutException timeout) {
                    // Accepted by the dispatcher but still running on the world thread.
                    LOGGER.fine("Command still running after timeout: " + normalized);
                    return new PlayersHandler.ActionResult(true, "Command queued: " + normalized);
                }
            }
            return new PlayersHandler.ActionResult(true, "Executed: " + normalized);
        } catch (Throwable t) {
            // Unwrap ExecutionException for a cleaner message.
            Throwable cause = (t instanceof java.util.concurrent.ExecutionException && t.getCause() != null)
                    ? t.getCause() : t;
            LOGGER.warning("Command failed (" + normalized + "): " + cause.getMessage());
            return new PlayersHandler.ActionResult(false, "Command failed: " + cause.getMessage());
        }
    }
}
