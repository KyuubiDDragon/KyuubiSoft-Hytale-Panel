package com.kyuubisoft.api.handlers;

import com.kyuubisoft.api.KyuubiSoftAPI;
import com.kyuubisoft.api.commands.CommandResult;
import com.kyuubisoft.api.commands.CommandRunner;
import com.kyuubisoft.api.commands.CommandService;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.logging.Logger;

/**
 * Executes Hytale server commands in-process for the player-action endpoints.
 *
 * <p>Player-action endpoints (heal, kill, teleport, gamemode, …) are implemented
 * by dispatching the server's own, fully-tested commands. This is deliberately
 * preferred over hand-rolled ECS writes: it reuses the exact behaviour (and
 * client/network sync) the vanilla commands already implement, and the command
 * strings mirror the ones the panel previously sent over the Docker console —
 * so syntax stays in one place.</p>
 *
 * <p>Commands run through {@link CommandService} as {@code Panel:player-action},
 * so the result is the command's real outcome: an unknown command, wrong syntax
 * or an error the command reports is a failure with the server's message, not
 * a success. Blocks the calling thread for up to {@link #COMMAND_TIMEOUT_MS};
 * call it from a worker thread, never from Netty or a world thread. A command
 * still running then is reported as queued (success).</p>
 */
public final class CommandExecutor {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final long COMMAND_TIMEOUT_MS = 3000;
    // The runner replies by its own deadline; this only covers a lost reply.
    private static final long REPLY_MARGIN_MS = 2000;
    private static final String ACTOR = "player-action";

    private CommandExecutor() {
    }

    /**
     * Dispatch a single command. The leading slash is optional and stripped —
     * the command dispatcher expects the bare "name args" form.
     *
     * @return a PlayersHandler.ActionResult describing the outcome
     */
    public static PlayersHandler.ActionResult run(String command) {
        String problem = CommandRunner.validate(command);
        if (problem != null) {
            return new PlayersHandler.ActionResult(false, problem);
        }

        KyuubiSoftAPI plugin = KyuubiSoftAPI.getInstance();
        CommandService service = plugin != null ? plugin.getCommandService() : null;
        CompletableFuture<CommandResult> pending = service != null
                ? service.execute(command, ACTOR, false, COMMAND_TIMEOUT_MS)
                : null;
        if (pending == null) {
            return new PlayersHandler.ActionResult(false, "Command system not available");
        }

        try {
            CommandResult result = pending.get(COMMAND_TIMEOUT_MS + REPLY_MARGIN_MS, TimeUnit.MILLISECONDS);
            if (!result.ok) {
                return new PlayersHandler.ActionResult(false, result.error != null ? result.error : "Command failed");
            }
            String prefix = "RUNNING".equals(result.status) ? "Command queued: " : "Executed: ";
            return new PlayersHandler.ActionResult(true, prefix + result.command);
        } catch (TimeoutException timeout) {
            // Accepted by the dispatcher but still running on the world thread.
            LOGGER.fine("Command still running after timeout: " + command);
            return new PlayersHandler.ActionResult(true, "Command queued: " + command);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return new PlayersHandler.ActionResult(false, "Command interrupted");
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause() != null ? failed.getCause() : failed;
            LOGGER.warning("Command failed (" + command + "): " + cause.getMessage());
            return new PlayersHandler.ActionResult(false, "Command failed: " + cause.getMessage());
        }
    }
}
