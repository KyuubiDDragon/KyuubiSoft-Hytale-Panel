package com.kyuubisoft.api.websocket;

import com.kyuubisoft.api.metrics.WorldPerf;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/**
 * Sends one {@code tps_update} per running world every interval (default
 * 5 s) while a WebSocket client is connected. The panel's TPS alarm and TPS
 * history are fed from these frames.
 */
public class TpsTicker {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    private final EventBroadcaster broadcaster;
    private final long intervalMs;
    private ScheduledExecutorService executor;

    public TpsTicker(EventBroadcaster broadcaster, long intervalMs) {
        this.broadcaster = broadcaster;
        this.intervalMs = intervalMs;
    }

    public void start() {
        if (intervalMs <= 0) {
            LOGGER.info("TpsTicker disabled (tpsBroadcastIntervalMs <= 0)");
            return;
        }
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "KyuubiSoft-TpsTicker");
            t.setDaemon(true);
            return t;
        });
        executor.scheduleAtFixedRate(this::tick, intervalMs, intervalMs, TimeUnit.MILLISECONDS);
        LOGGER.info("TpsTicker started, interval=" + intervalMs + "ms");
    }

    public void shutdown() {
        if (executor != null) executor.shutdownNow();
    }

    void tick() {
        try {
            if (!broadcaster.hasClients()) return;
            for (WorldPerf.Snapshot world : WorldPerf.snapshotAll()) {
                broadcaster.broadcastTpsUpdate(world);
            }
        } catch (Throwable t) {
            // Never let an exception cancel the schedule.
            LOGGER.warning("TpsTicker tick failed: " + t.getMessage());
        }
    }
}
