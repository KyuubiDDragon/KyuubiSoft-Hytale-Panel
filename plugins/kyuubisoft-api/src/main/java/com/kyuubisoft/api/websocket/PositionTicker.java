package com.kyuubisoft.api.websocket;

import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.io.PacketHandler;
import com.hypixel.hytale.protocol.packets.connection.PongType;
import com.hypixel.hytale.metrics.metric.HistoricMetric;
import com.hypixel.hytale.math.vector.Transform;
import com.hypixel.hytale.math.vector.Rotation3f;
import com.kyuubisoft.api.util.WorldThread;
import org.joml.Vector3d;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
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
 * <h3>How positions are read</h3>
 * <ul>
 *   <li>Nothing is read while no WebSocket client is connected.</li>
 *   <li>Each world's players are copied on that world's own thread
 *       ({@link WorldThread}): the world thread writes position and rotation
 *       in place, so a copy taken elsewhere could mix x/y/z of two ticks.
 *       A world that is still busy with the previous copy is skipped.</li>
 *   <li>Yaw and pitch are the head rotation, i.e. where the player looks
 *       (the body rotation trails behind).</li>
 *   <li>Latency is read from {@link PacketHandler#getPingInfo(PongType)} →
 *       {@link HistoricMetric}.</li>
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
    // World name -> snapshot still queued on that world's thread.
    private final Map<String, CompletableFuture<?>> pending = new ConcurrentHashMap<>();

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
        pending.clear();
    }

    void tick() {
        try {
            if (!broadcaster.hasClients()) return;
            Universe universe = Universe.get();
            if (universe == null) return;

            for (World world : universe.getWorlds().values()) {
                if (!world.isAlive() || world.getPlayerCount() == 0) continue;
                String name = world.getName();
                CompletableFuture<?> previous = pending.get(name);
                if (previous != null && !previous.isDone()) continue; // world is lagging

                // Only the copy runs on the world thread; ping lookup, JSON
                // and sending happen back on the ticker thread.
                CompletableFuture<?> snapshot = WorldThread.supply(world, () -> copyPositions(world))
                        .thenAcceptAsync(this::broadcastAll, executor)
                        .whenComplete((ignored, error) -> {
                            if (error != null && debug) {
                                System.out.println("[KYUUBI_DEBUG_POSITIONS] world " + name + " skipped: " + error);
                            }
                        });
                pending.put(name, snapshot);
            }
            // Forget worlds that were removed.
            pending.keySet().removeIf(name -> universe.getWorld(name) == null);
        } catch (Throwable t) {
            // Defensive: never let a ticker exception kill the scheduler thread.
            LOGGER.warning("PositionTicker tick failed: " + t.getMessage());
        }
    }

    /** Runs on the world thread: copy every player's position and head rotation. */
    private static List<Sample> copyPositions(World world) {
        List<Sample> samples = new ArrayList<>();
        String worldName = world.getName();
        for (PlayerRef player : world.getPlayerRefs()) {
            if (player == null) continue;
            Transform transform = player.getTransform();
            Vector3d pos = transform != null ? transform.getPosition() : null;
            if (pos == null) continue;
            Rotation3f head = player.getHeadRotation();
            samples.add(new Sample(player, player.getUsername(), player.getUuid().toString(), worldName,
                    pos.x(), pos.y(), pos.z(),
                    head != null ? (double) head.yaw() : null,
                    head != null ? (double) head.pitch() : null));
        }
        return samples;
    }

    private void broadcastAll(List<Sample> samples) {
        for (Sample s : samples) {
            Integer latencyMs = extractPing(s.player);
            if (debug) {
                System.out.println("[KYUUBI_DEBUG_POSITIONS] " + s.name + " uuid=" + s.uuid
                    + " world=" + s.world + " x=" + s.x + " y=" + s.y + " z=" + s.z
                    + " yaw=" + s.yaw + " pitch=" + s.pitch + " ping=" + latencyMs);
            }
            broadcaster.broadcastPlayerPosition(s.name, s.uuid, s.world, s.x, s.y, s.z, s.yaw, s.pitch, latencyMs);
        }
    }

    /**
     * Read the player's latency from the connection's ping metrics.
     *
     * The {@link HistoricMetric} stores samples in {@code PingInfo.TIME_UNIT};
     * we convert to milliseconds and clamp to a plausible range. Returns null when no ping
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

    /** One player's position, copied on the world thread. */
    private record Sample(PlayerRef player, String name, String uuid, String world,
                          double x, double y, double z, Double yaw, Double pitch) {
    }
}
