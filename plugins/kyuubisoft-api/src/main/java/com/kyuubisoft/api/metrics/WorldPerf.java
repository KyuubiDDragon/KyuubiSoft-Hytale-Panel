package com.kyuubisoft.api.metrics;

import com.hypixel.hytale.metrics.metric.HistoricMetric;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.universe.world.commands.world.perf.WorldPerfCommand;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Real tick metrics per world, computed the way the server computes them for
 * {@code /world perf}.
 *
 * <p>Every world ticks on its own thread with its own target rate (30 TPS by
 * default) and records how long each tick took over the last 10 s, 1 min and
 * 5 min. TPS follows from that tick time: a tick that finishes within the
 * tick budget counts as the full target rate, a slower one as
 * {@code 1 s / tick time}. So the slowest tick gives the minimum TPS and the
 * fastest the maximum.</p>
 *
 * <p>Stateless: it reads the server's own history on demand, so there is no
 * sampler to start and nothing that survives a plugin reload. The histories
 * are plain counters the world thread updates; reading them from another
 * thread can be a tick behind, which is fine for monitoring (the server's own
 * telemetry reads them the same way).</p>
 */
public final class WorldPerf {

    private static final double NANOS_PER_MS = 1_000_000.0;

    private WorldPerf() {
    }

    /** Snapshot of every running world; empty while the universe is not up. */
    public static List<Snapshot> snapshotAll() {
        List<Snapshot> result = new ArrayList<>();
        Universe universe = Universe.get();
        if (universe == null) return result;
        for (World world : universe.getWorlds().values()) {
            Snapshot snapshot = snapshot(world);
            if (snapshot != null) result.add(snapshot);
        }
        return result;
    }

    /** Snapshot of one world, or null when it is not running. */
    public static Snapshot snapshot(World world) {
        if (world == null || !world.isAlive()) return null;

        int targetTps = world.getTps();
        long tickStepNanos = world.getTickStepNanos();
        HistoricMetric metric = world.getBufferedTickLengthMetricSet();

        List<Window> windows = new ArrayList<>();
        if (metric != null) {
            long[] periods = metric.getPeriodsNanos();
            for (int i = 0; i < periods.length; i++) {
                windows.add(window(metric, i, periods[i], targetTps, tickStepNanos));
            }
        }

        return new Snapshot(
                world.getName(),
                targetTps,
                round3(tickStepNanos / NANOS_PER_MS),
                windows,
                safePlayerCount(world),
                safeEntityCount(world),
                safeLoadedChunks(world));
    }

    /**
     * The headline value across worlds: the world with the lowest TPS relative
     * to its target over the shortest window. Each world has its own thread,
     * so this is the world whose players feel lag first. Null without worlds.
     */
    public static Snapshot slowest(List<Snapshot> snapshots) {
        Snapshot slowest = null;
        double lowestRatio = Double.MAX_VALUE;
        for (Snapshot s : snapshots) {
            double ratio = s.targetTps > 0 ? s.tps / s.targetTps : 1.0;
            if (ratio < lowestRatio) {
                lowestRatio = ratio;
                slowest = s;
            }
        }
        return slowest;
    }

    private static Window window(HistoricMetric metric, int index, long periodNanos, int targetTps, long tickStepNanos) {
        double avgNanos = metric.getAverage(index);
        long minNanos = metric.calculateMin(index);
        long maxNanos = metric.calculateMax(index);
        // A world that has not ticked in this window yet reports no samples.
        if (avgNanos <= 0 || minNanos == Long.MAX_VALUE || maxNanos == Long.MIN_VALUE) {
            return new Window(label(periodNanos), targetTps, targetTps, targetTps, 0, 0, 0);
        }
        return new Window(
                label(periodNanos),
                round2(WorldPerfCommand.tpsFromDelta(avgNanos, tickStepNanos)),
                // The slowest tick gives the lowest TPS and vice versa.
                round2(WorldPerfCommand.tpsFromDelta(maxNanos, tickStepNanos)),
                round2(WorldPerfCommand.tpsFromDelta(minNanos, tickStepNanos)),
                round3(avgNanos / NANOS_PER_MS),
                round3(minNanos / NANOS_PER_MS),
                round3(maxNanos / NANOS_PER_MS));
    }

    /** "10s", "1m", "5m" for the server's default windows. */
    static String label(long periodNanos) {
        long seconds = TimeUnit.NANOSECONDS.toSeconds(periodNanos);
        if (seconds >= 60 && seconds % 60 == 0) return (seconds / 60) + "m";
        return seconds + "s";
    }

    private static int safePlayerCount(World world) {
        try {
            return world.getPlayerCount();
        } catch (RuntimeException e) {
            return -1;
        }
    }

    // Plain counters without a thread assertion; the server's telemetry reads
    // them from its own thread as well.
    private static int safeEntityCount(World world) {
        try {
            return world.getEntityStore().getStore().getEntityCount();
        } catch (RuntimeException e) {
            return -1;
        }
    }

    private static int safeLoadedChunks(World world) {
        try {
            return world.getChunkStore().getLoadedChunksCount();
        } catch (RuntimeException e) {
            return -1;
        }
    }

    private static double round2(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    private static double round3(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    /** Tick statistics of one window ("10s", "1m", "5m"). */
    public static final class Window {
        public final String window;
        public final double tpsAvg;
        public final double tpsMin;
        public final double tpsMax;
        /** Time a tick took to compute, in milliseconds (not the tick interval). */
        public final double tickMsAvg;
        public final double tickMsMin;
        public final double tickMsMax;

        Window(String window, double tpsAvg, double tpsMin, double tpsMax,
               double tickMsAvg, double tickMsMin, double tickMsMax) {
            this.window = window;
            this.tpsAvg = tpsAvg;
            this.tpsMin = tpsMin;
            this.tpsMax = tpsMax;
            this.tickMsAvg = tickMsAvg;
            this.tickMsMin = tickMsMin;
            this.tickMsMax = tickMsMax;
        }
    }

    /** Tick metrics and load of one world. */
    public static final class Snapshot {
        public final String world;
        public final int targetTps;
        /** Time available per tick at the target rate (1000 / targetTps). */
        public final double tickBudgetMs;
        /** Average TPS over the shortest window (10 s). */
        public final double tps;
        /** Average tick time over the shortest window, in milliseconds. */
        public final double mspt;
        public final List<Window> windows;
        public final int players;
        public final int entities;
        public final int loadedChunks;

        Snapshot(String world, int targetTps, double tickBudgetMs, List<Window> windows,
                 int players, int entities, int loadedChunks) {
            this.world = world;
            this.targetTps = targetTps;
            this.tickBudgetMs = tickBudgetMs;
            this.windows = List.copyOf(windows);
            Window first = windows.isEmpty() ? null : windows.get(0);
            this.tps = first != null ? first.tpsAvg : targetTps;
            this.mspt = first != null ? first.tickMsAvg : 0;
            this.players = players;
            this.entities = entities;
            this.loadedChunks = loadedChunks;
        }

        /** The window with this label, or null. */
        public Window window(String label) {
            for (Window w : windows) {
                if (w.window.equals(label)) return w;
            }
            return null;
        }
    }
}
