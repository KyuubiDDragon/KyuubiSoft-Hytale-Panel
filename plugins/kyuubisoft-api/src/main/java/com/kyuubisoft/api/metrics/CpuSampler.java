package com.kyuubisoft.api.metrics;

import java.lang.management.ManagementFactory;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/**
 * CPU load, sampled in the background.
 *
 * <p>Reading the CPU load from the OS MXBean can block for seconds on some
 * systems (measured: several seconds per call on Windows), which must never
 * happen on a Netty thread. One daemon thread refreshes the values every few
 * seconds; requests only read the last sample. The plugin starts it in
 * {@code start()} and stops it in {@code shutdown()}, which also clears the
 * values, so nothing carries over a plugin reload.</p>
 */
public final class CpuSampler {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final long INTERVAL_SECONDS = 5;

    private static ScheduledExecutorService executor;
    // Load in 0..1; negative while unknown.
    private static volatile double systemLoad = -1;
    private static volatile double processLoad = -1;

    private CpuSampler() {
    }

    public static synchronized void start() {
        if (executor != null) return;
        final com.sun.management.OperatingSystemMXBean os;
        try {
            os = (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        } catch (ClassCastException e) {
            LOGGER.info("CPU load not available on this JVM");
            return;
        }
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "KyuubiSoft-CpuSampler");
            t.setDaemon(true);
            return t;
        });
        // Fixed delay: a slow read never piles up behind itself.
        executor.scheduleWithFixedDelay(() -> {
            try {
                systemLoad = os.getCpuLoad();
                processLoad = os.getProcessCpuLoad();
            } catch (Throwable t) {
                systemLoad = -1;
                processLoad = -1;
            }
        }, 0, INTERVAL_SECONDS, TimeUnit.SECONDS);
    }

    public static synchronized void stop() {
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        systemLoad = -1;
        processLoad = -1;
    }

    /** System-wide CPU load in 0..1, or a negative value while unknown. */
    public static double systemLoad() {
        return systemLoad;
    }

    /** CPU load of the server process in 0..1, or a negative value while unknown. */
    public static double processLoad() {
        return processLoad;
    }
}
