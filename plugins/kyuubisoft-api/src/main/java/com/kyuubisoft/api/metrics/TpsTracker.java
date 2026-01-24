package com.kyuubisoft.api.metrics;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

/**
 * Tracks TPS (Ticks Per Second) and MSPT (Milliseconds Per Tick) over time.
 * Provides current, average, min, and max values over a rolling window.
 */
public class TpsTracker {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final double TARGET_TPS = 20.0;
    private static final double TARGET_MSPT = 50.0; // 1000ms / 20 ticks
    private static final int SAMPLE_WINDOW_SIZE = 60; // 60 seconds of samples

    private static TpsTracker instance;

    private final ScheduledExecutorService scheduler;
    private final double[] tpsSamples;
    private final double[] msptSamples;
    private int sampleIndex = 0;
    private int sampleCount = 0;

    private long lastTickTime;
    private long tickCount = 0;
    private final AtomicReference<Double> currentTps = new AtomicReference<>(TARGET_TPS);
    private final AtomicReference<Double> currentMspt = new AtomicReference<>(TARGET_MSPT);

    // Tracking tick timing
    private long lastMeasurementTime;
    private long ticksSinceLastMeasurement = 0;

    public TpsTracker() {
        instance = this;
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "TpsTracker");
            t.setDaemon(true);
            return t;
        });
        this.tpsSamples = new double[SAMPLE_WINDOW_SIZE];
        this.msptSamples = new double[SAMPLE_WINDOW_SIZE];
        this.lastTickTime = System.nanoTime();
        this.lastMeasurementTime = System.currentTimeMillis();

        // Fill with default values
        for (int i = 0; i < SAMPLE_WINDOW_SIZE; i++) {
            tpsSamples[i] = TARGET_TPS;
            msptSamples[i] = TARGET_MSPT;
        }
    }

    public static TpsTracker getInstance() {
        return instance;
    }

    /**
     * Start the TPS tracking scheduler.
     * Samples TPS every second.
     */
    public void start() {
        LOGGER.info("Starting TPS Tracker...");

        // Sample TPS every second
        scheduler.scheduleAtFixedRate(this::sampleTps, 1, 1, TimeUnit.SECONDS);
    }

    /**
     * Called when a server tick occurs.
     * This should be hooked into the server's tick loop.
     */
    public void onTick() {
        long now = System.nanoTime();
        long elapsed = now - lastTickTime;
        lastTickTime = now;
        tickCount++;
        ticksSinceLastMeasurement++;

        // Calculate MSPT for this tick
        double mspt = elapsed / 1_000_000.0;
        currentMspt.set(mspt);

        // Calculate instantaneous TPS (capped at 20)
        double tps = Math.min(TARGET_TPS, 1000.0 / mspt);
        currentTps.set(tps);
    }

    /**
     * Sample the current TPS for the rolling window.
     */
    private void sampleTps() {
        try {
            long now = System.currentTimeMillis();
            long elapsed = now - lastMeasurementTime;
            lastMeasurementTime = now;

            // Calculate TPS based on ticks in the last second
            double tps;
            double mspt;

            if (elapsed > 0 && ticksSinceLastMeasurement > 0) {
                // Ticks per second = ticks / (elapsed ms / 1000)
                tps = Math.min(TARGET_TPS, (ticksSinceLastMeasurement * 1000.0) / elapsed);
                // MSPT = elapsed time / ticks
                mspt = (double) elapsed / ticksSinceLastMeasurement;
            } else {
                // No ticks occurred, estimate from current values
                tps = currentTps.get();
                mspt = currentMspt.get();
            }

            // Reset tick counter
            ticksSinceLastMeasurement = 0;

            // Store in rolling window
            tpsSamples[sampleIndex] = tps;
            msptSamples[sampleIndex] = mspt;
            sampleIndex = (sampleIndex + 1) % SAMPLE_WINDOW_SIZE;
            if (sampleCount < SAMPLE_WINDOW_SIZE) {
                sampleCount++;
            }

            // Update current values
            currentTps.set(tps);
            currentMspt.set(mspt);

        } catch (Exception e) {
            LOGGER.warning("Error sampling TPS: " + e.getMessage());
        }
    }

    /**
     * Get the current TPS value.
     */
    public double getCurrentTps() {
        return round(currentTps.get());
    }

    /**
     * Get the current MSPT value.
     */
    public double getCurrentMspt() {
        return round(currentMspt.get());
    }

    /**
     * Get the target TPS (usually 20).
     */
    public double getTargetTps() {
        return TARGET_TPS;
    }

    /**
     * Get the average TPS over the sample window.
     */
    public double getAverageTps() {
        if (sampleCount == 0) return TARGET_TPS;

        double sum = 0;
        for (int i = 0; i < sampleCount; i++) {
            sum += tpsSamples[i];
        }
        return round(sum / sampleCount);
    }

    /**
     * Get the minimum TPS over the sample window.
     */
    public double getMinTps() {
        if (sampleCount == 0) return TARGET_TPS;

        double min = Double.MAX_VALUE;
        for (int i = 0; i < sampleCount; i++) {
            if (tpsSamples[i] < min) {
                min = tpsSamples[i];
            }
        }
        return round(min);
    }

    /**
     * Get the maximum TPS over the sample window.
     */
    public double getMaxTps() {
        if (sampleCount == 0) return TARGET_TPS;

        double max = Double.MIN_VALUE;
        for (int i = 0; i < sampleCount; i++) {
            if (tpsSamples[i] > max) {
                max = tpsSamples[i];
            }
        }
        return round(max);
    }

    /**
     * Get the average MSPT over the sample window.
     */
    public double getAverageMspt() {
        if (sampleCount == 0) return TARGET_MSPT;

        double sum = 0;
        for (int i = 0; i < sampleCount; i++) {
            sum += msptSamples[i];
        }
        return round(sum / sampleCount);
    }

    /**
     * Get total tick count since server start.
     */
    public long getTotalTickCount() {
        return tickCount;
    }

    /**
     * Get TPS statistics as a snapshot.
     */
    public TpsSnapshot getSnapshot() {
        return new TpsSnapshot(
            getCurrentTps(),
            getAverageTps(),
            getMinTps(),
            getMaxTps(),
            TARGET_TPS,
            getCurrentMspt(),
            getAverageMspt(),
            tickCount
        );
    }

    /**
     * Shutdown the tracker.
     */
    public void shutdown() {
        scheduler.shutdown();
        try {
            if (!scheduler.awaitTermination(5, TimeUnit.SECONDS)) {
                scheduler.shutdownNow();
            }
        } catch (InterruptedException e) {
            scheduler.shutdownNow();
        }
    }

    private double round(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    /**
     * Immutable snapshot of TPS statistics.
     */
    public record TpsSnapshot(
        double current,
        double average,
        double min,
        double max,
        double target,
        double msptCurrent,
        double msptAverage,
        long totalTicks
    ) {}
}
