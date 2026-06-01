package com.kyuubisoft.api.websocket;

import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.io.PacketHandler;
import com.hypixel.hytale.protocol.packets.connection.PongType;
import com.hypixel.hytale.metrics.metric.HistoricMetric;
import com.hypixel.hytale.math.vector.Transform;
import com.hypixel.hytale.math.vector.Rotation3f;
import org.joml.Vector3d;

import java.util.Collection;
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
 * "player_position" WebSocket frames.
 *
 * <h3>Hytale 2026-05 API access</h3>
 * <ul>
 *   <li>Position comes from {@link Transform#getPosition()} which now returns an
 *       {@link org.joml.Vector3d}; rotation from {@link Transform#getRotation()}
 *       which returns a {@link Rotation3f} exposing {@code yaw()}/{@code pitch()}.</li>
 *   <li>World name via {@link PlayerRef#getWorldUuid()} + {@link Universe#getWorld(UUID)}.</li>
 *   <li>Latency is read from {@link PacketHandler#getPingInfo(PongType)} →
 *       {@link HistoricMetric}. (The previous reflection probe for
 *       {@code getPing()}/{@code getLatency()} never matched and always returned
 *       null on this API.)</li>
 * </ul>
 *
 * <h3>Test hook</h3>
 * Start the JVM with {@code -DKYUUBI_DEBUG_POSITIONS=1} to log every tick.
 */
public class PositionTicker {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final String DEBUG_PROP = "KYUUBI_DEBUG_POSITIONS";
    // Probe order for ping: Direct is the real network round-trip; fall back to others.
    private static final PongType[] PING_TYPES = { PongType.Direct, PongType.Tick, PongType.Raw };

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
            Collection<PlayerRef> players = universe.getPlayers();
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

        // World resolution — defensive; world may be null during transitions.
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
                    x = pos.x();
                    y = pos.y();
                    z = pos.z();
                }
                Rotation3f rot = transform.getRotation();
                if (rot != null) {
                    yaw = (double) rot.yaw();
                    pitch = (double) rot.pitch();
                }
            }
        } catch (Throwable ignored) { }

        // Skip the broadcast entirely when we have no spatial data.
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
     * Read the player's latency from the connection's ping metrics.
     *
     * The {@link HistoricMetric} stores nanosecond samples; we convert to
     * milliseconds and clamp to a plausible range. Returns null when no ping
     * sample is available yet (e.g. the player just connected).
     */
    private Integer extractPing(PlayerRef player) {
        try {
            PacketHandler handler = player.getPacketHandler();
            if (handler == null) return null;
            for (PongType type : PING_TYPES) {
                PacketHandler.PingInfo info;
                try {
                    info = handler.getPingInfo(type);
                } catch (Throwable t) {
                    continue;
                }
                if (info == null) continue;
                HistoricMetric metric = info.getPingMetricSet();
                if (metric == null) continue;

                long last = metric.getLastValue();
                Integer ms = normalizeToMs(last);
                if (ms != null) return ms;

                // Fall back to the average over the most recent window.
                double avg = metric.getAverage(PacketHandler.PingInfo.ONE_MINUTE_INDEX);
                ms = normalizeToMs((long) avg);
                if (ms != null) return ms;
            }
        } catch (Throwable ignored) {
            // No ping accessor / not connected — treat as unknown.
        }
        return null;
    }

    /**
     * Convert a raw ping-metric value to milliseconds using the metric's actual
     * unit. {@code PacketHandler.PingInfo.TIME_UNIT} is MICROSECONDS on this API
     * (verified via javap), so a real ~18 ms ping is stored as ~18000 — the old
     * "nanoseconds-if-big-else-milliseconds" heuristic mis-read that as 18000 ms.
     * Using TIME_UNIT keeps this correct even if Hytale changes the unit. Clamp
     * to [0, 60000] ms.
     */
    private Integer normalizeToMs(long raw) {
        if (raw <= 0) return null;
        long ms = PacketHandler.PingInfo.TIME_UNIT.toMillis(raw);
        if (ms < 0 || ms > 60_000L) return null;
        return (int) ms;
    }
}
