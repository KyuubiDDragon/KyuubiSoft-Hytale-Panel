package com.kyuubisoft.api.websocket;

import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.math.vector.Transform;
import com.hypixel.hytale.math.vector.Vector3d;
import com.hypixel.hytale.math.vector.Vector3f;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/**
 * Periodic broadcaster of player_position events.
 *
 * The panel's LiveMap.vue and Replay recorder both subscribe to
 * "player_position" WebSocket frames. Until this ticker was wired in they
 * were running in simulator mode against fake samples — this class makes
 * them work against real Hytale data.
 *
 * <h3>Hytale API access</h3>
 * <ul>
 *   <li>Position + rotation come from {@link PlayerRef#getTransform()} which
 *       is part of the public, stable Hytale core API used elsewhere in the
 *       plugin (see PlayersHandler).</li>
 *   <li>World name is resolved via {@link PlayerRef#getWorldUuid()} +
 *       {@link Universe#getWorld(UUID)}.</li>
 *   <li>Ping (latency) is <b>not</b> part of the stable Hytale core API as of
 *       writing — there is no {@code PlayerRef#getPing()} or similar. We
 *       attempt reflection over a known list of candidate method names
 *       ({@code getPing}, {@code getLatency}, {@code getLatencyMs},
 *       {@code getRtt}). If none of them exist we leave latencyMs null
 *       rather than fabricating a value.</li>
 * </ul>
 *
 * <h3>Test hook</h3>
 * When the JVM is started with {@code -DKYUUBI_DEBUG_POSITIONS=1} every
 * outgoing tick is logged on stdout for debugging by the panel team.
 */
public class PositionTicker {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final String DEBUG_PROP = "KYUUBI_DEBUG_POSITIONS";
    private static final String[] PING_METHOD_CANDIDATES = {
        "getPing", "getLatency", "getLatencyMs", "getRtt", "getPingMs",
    };

    private final EventBroadcaster broadcaster;
    private final long intervalMs;
    private final boolean debug;

    private ScheduledExecutorService executor;
    private ScheduledFuture<?> task;

    public PositionTicker(EventBroadcaster broadcaster, long intervalMs) {
        this.broadcaster = broadcaster;
        this.intervalMs = intervalMs;
        this.debug = "1".equals(System.getProperty(DEBUG_PROP))
                  || "true".equalsIgnoreCase(System.getProperty(DEBUG_PROP));
    }

    public void start() {
        if (intervalMs <= 0) {
            LOGGER.info("PositionTicker disabled (interval <= 0)");
            return;
        }
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "KyuubiSoft-PositionTicker");
            t.setDaemon(true);
            return t;
        });
        task = executor.scheduleAtFixedRate(this::tick, intervalMs, intervalMs, TimeUnit.MILLISECONDS);
        LOGGER.info("PositionTicker started, interval=" + intervalMs + "ms, debug=" + debug);
    }

    public void shutdown() {
        if (task != null) task.cancel(false);
        if (executor != null) executor.shutdownNow();
    }

    void tick() {
        try {
            Universe universe = Universe.get();
            if (universe == null) return;
            List<PlayerRef> players = universe.getPlayers();
            if (players == null || players.isEmpty()) return;

            for (PlayerRef player : players) {
                broadcastFor(player, universe);
            }
        } catch (Throwable t) {
            // Defensive: never let a ticker exception kill the scheduler thread.
            LOGGER.warning("PositionTicker tick failed: " + t.getMessage());
        }
    }

    private void broadcastFor(PlayerRef player, Universe universe) {
        if (player == null) return;

        String name;
        String uuid;
        try {
            name = player.getUsername();
            uuid = player.getUuid().toString();
        } catch (Throwable t) {
            return; // can't identify, skip
        }

        // World resolution — defensive try/catch; world may be null during transitions.
        String worldName = null;
        try {
            UUID worldUuid = player.getWorldUuid();
            if (worldUuid != null) {
                World w = universe.getWorld(worldUuid);
                if (w != null) worldName = w.getName();
            }
        } catch (Throwable ignored) { }

        // Position + rotation from the transform.
        Double x = null, y = null, z = null, yaw = null, pitch = null;
        try {
            Transform transform = player.getTransform();
            if (transform != null) {
                Vector3d pos = transform.getPosition();
                if (pos != null) {
                    x = pos.getX();
                    y = pos.getY();
                    z = pos.getZ();
                }
                Vector3f rot = transform.getRotation();
                if (rot != null) {
                    // Hytale's rotation vector uses Y for yaw, X for pitch — matches
                    // the convention in PlayersHandler.createPlayerDetails().
                    yaw = (double) rot.getY();
                    pitch = (double) rot.getX();
                }
            }
        } catch (Throwable ignored) { }

        // Skip the broadcast entirely when we have no spatial data — the
        // panel would just plot the player at the origin which is worse than
        // omitting it.
        if (x == null || y == null || z == null) {
            if (debug) {
                System.out.println("[KYUUBI_DEBUG_POSITIONS] skip " + name + ": no transform");
            }
            return;
        }

        Integer latencyMs = extractPing(player);

        if (debug) {
            System.out.println("[KYUUBI_DEBUG_POSITIONS] " + name + " uuid=" + uuid
                + " world=" + worldName + " x=" + x + " y=" + y + " z=" + z
                + " yaw=" + yaw + " pitch=" + pitch + " ping=" + latencyMs);
        }

        broadcaster.broadcastPlayerPosition(name, uuid, worldName, x, y, z, yaw, pitch, latencyMs);
    }

    /**
     * Reflection-based ping extraction.
     *
     * No public Hytale API exposes player latency at the time of writing, so
     * we probe a handful of plausible accessor names. The result is parsed as
     * a non-negative integer; on failure we return null so the consumer can
     * treat it as "unknown" rather than "0 ms".
     */
    private Integer extractPing(PlayerRef player) {
        for (String methodName : PING_METHOD_CANDIDATES) {
            try {
                var method = player.getClass().getMethod(methodName);
                Object result = method.invoke(player);
                if (result instanceof Number) {
                    int val = ((Number) result).intValue();
                    if (val >= 0) return val;
                }
            } catch (NoSuchMethodException ignored) {
                // Try next candidate.
            } catch (Throwable ignored) {
                // Method exists but call failed (security, IllegalArgument, …). Give up
                // silently — there's no panel-side fallback for ping today.
            }
        }
        return null;
    }
}
