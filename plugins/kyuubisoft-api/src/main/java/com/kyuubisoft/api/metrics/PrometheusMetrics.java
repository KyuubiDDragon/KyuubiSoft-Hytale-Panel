package com.kyuubisoft.api.metrics;

import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.kyuubisoft.api.handlers.ServerHandler;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.ThreadMXBean;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.ToDoubleFunction;
import java.util.logging.Logger;

/**
 * Prometheus metrics collector for Hytale server.
 * Outputs metrics in Prometheus text exposition format without external dependencies.
 */
public class PrometheusMetrics {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    // Counters for player events
    private final AtomicLong playerJoins = new AtomicLong(0);
    private final AtomicLong playerLeaves = new AtomicLong(0);

    public PrometheusMetrics() {
        LOGGER.info("Prometheus metrics initialized (native implementation)");
    }

    /**
     * Generate Prometheus text format metrics output.
     */
    public String generateMetrics() {
        StringBuilder sb = new StringBuilder();

        // TPS metrics. The unlabeled gauges keep their 2.0 names and describe
        // the world with the lowest TPS relative to its target; the labeled
        // hytale_world_* series below cover every world and window.
        List<WorldPerf.Snapshot> worlds = WorldPerf.snapshotAll();
        WorldPerf.Snapshot headline = WorldPerf.slowest(worlds);
        if (headline != null) {
            WorldPerf.Window shortest = headline.windows.isEmpty() ? null : headline.windows.get(0);
            WorldPerf.Window minute = headline.window("1m") != null ? headline.window("1m") : shortest;
            appendGauge(sb, "hytale_tps_current", "TPS, 10 s average (slowest world)", headline.tps);
            if (minute != null) {
                appendGauge(sb, "hytale_tps_average", "TPS, 1 min average (slowest world)", minute.tpsAvg);
                appendGauge(sb, "hytale_tps_min", "Lowest TPS within 1 min (slowest world)", minute.tpsMin);
                appendGauge(sb, "hytale_tps_max", "Highest TPS within 1 min (slowest world)", minute.tpsMax);
                appendGauge(sb, "hytale_mspt_average", "Tick time in ms, 1 min average (slowest world)", minute.tickMsAvg);
            }
            appendGauge(sb, "hytale_tps_target", "Target TPS (slowest world)", headline.targetTps);
            appendGauge(sb, "hytale_mspt_current", "Tick time in ms, 10 s average (slowest world)", headline.mspt);
        }
        appendWorldPerf(sb, worlds);

        // Player metrics
        int onlinePlayers = 0;
        Map<String, Integer> playersPerWorld = new HashMap<>();
        try {
            Universe universe = Universe.get();
            // Hytale 2026-05 API: Universe.getPlayers() now returns Collection<PlayerRef>
            // (was List<PlayerRef> in older versions).
            Collection<PlayerRef> players = universe.getPlayers();
            onlinePlayers = players.size();

            for (PlayerRef player : players) {
                try {
                    UUID worldUuid = player.getWorldUuid();
                    if (worldUuid != null) {
                        World world = universe.getWorld(worldUuid);
                        if (world != null) {
                            String worldName = world.getName();
                            playersPerWorld.merge(worldName, 1, Integer::sum);
                        }
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}

        appendGauge(sb, "hytale_players_online", "Number of players online", onlinePlayers);
        int maxPlayers = ServerHandler.maxPlayers();
        if (maxPlayers >= 0) {
            appendGauge(sb, "hytale_players_max", "Maximum players allowed (server config)", maxPlayers);
        }

        // Players per world
        if (!playersPerWorld.isEmpty()) {
            sb.append("# HELP hytale_players_world Number of players per world\n");
            sb.append("# TYPE hytale_players_world gauge\n");
            for (Map.Entry<String, Integer> entry : playersPerWorld.entrySet()) {
                sb.append("hytale_players_world{world=\"")
                  .append(escapeLabel(entry.getKey()))
                  .append("\"} ")
                  .append(entry.getValue())
                  .append("\n");
            }
        }

        // Player join/leave counters
        appendCounter(sb, "hytale_player_joins_total", "Total player joins since start", playerJoins.get());
        appendCounter(sb, "hytale_player_leaves_total", "Total player leaves since start", playerLeaves.get());

        // World metrics
        int worldsLoaded = 0;
        try {
            Universe universe = Universe.get();
            worldsLoaded = universe.getWorlds().size();
        } catch (Exception ignored) {}
        appendGauge(sb, "hytale_worlds_loaded", "Number of worlds loaded", worldsLoaded);

        // JVM Memory metrics
        MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
        MemoryUsage heapUsage = memoryBean.getHeapMemoryUsage();
        MemoryUsage nonHeapUsage = memoryBean.getNonHeapMemoryUsage();

        appendGauge(sb, "jvm_memory_heap_used_bytes", "Heap memory used", heapUsage.getUsed());
        appendGauge(sb, "jvm_memory_heap_max_bytes", "Heap memory max",
            heapUsage.getMax() > 0 ? heapUsage.getMax() : heapUsage.getCommitted());
        appendGauge(sb, "jvm_memory_heap_committed_bytes", "Heap memory committed", heapUsage.getCommitted());
        appendGauge(sb, "jvm_memory_nonheap_used_bytes", "Non-heap memory used", nonHeapUsage.getUsed());
        appendGauge(sb, "jvm_memory_nonheap_committed_bytes", "Non-heap memory committed", nonHeapUsage.getCommitted());

        // Memory pools
        List<MemoryPoolMXBean> memoryPools = ManagementFactory.getMemoryPoolMXBeans();
        if (!memoryPools.isEmpty()) {
            sb.append("# HELP jvm_memory_pool_used_bytes Memory pool usage\n");
            sb.append("# TYPE jvm_memory_pool_used_bytes gauge\n");
            for (MemoryPoolMXBean pool : memoryPools) {
                MemoryUsage usage = pool.getUsage();
                if (usage != null) {
                    sb.append("jvm_memory_pool_used_bytes{pool=\"")
                      .append(escapeLabel(pool.getName()))
                      .append("\"} ")
                      .append(usage.getUsed())
                      .append("\n");
                }
            }

            sb.append("# HELP jvm_memory_pool_max_bytes Memory pool maximum\n");
            sb.append("# TYPE jvm_memory_pool_max_bytes gauge\n");
            for (MemoryPoolMXBean pool : memoryPools) {
                MemoryUsage usage = pool.getUsage();
                if (usage != null && usage.getMax() > 0) {
                    sb.append("jvm_memory_pool_max_bytes{pool=\"")
                      .append(escapeLabel(pool.getName()))
                      .append("\"} ")
                      .append(usage.getMax())
                      .append("\n");
                }
            }
        }

        // GC metrics
        List<GarbageCollectorMXBean> gcBeans = ManagementFactory.getGarbageCollectorMXBeans();
        if (!gcBeans.isEmpty()) {
            sb.append("# HELP jvm_gc_collection_count_total GC collection count\n");
            sb.append("# TYPE jvm_gc_collection_count_total counter\n");
            for (GarbageCollectorMXBean gc : gcBeans) {
                if (gc.getCollectionCount() >= 0) {
                    sb.append("jvm_gc_collection_count_total{gc=\"")
                      .append(escapeLabel(gc.getName()))
                      .append("\"} ")
                      .append(gc.getCollectionCount())
                      .append("\n");
                }
            }

            sb.append("# HELP jvm_gc_collection_time_seconds_total GC collection time\n");
            sb.append("# TYPE jvm_gc_collection_time_seconds_total counter\n");
            for (GarbageCollectorMXBean gc : gcBeans) {
                if (gc.getCollectionTime() >= 0) {
                    sb.append("jvm_gc_collection_time_seconds_total{gc=\"")
                      .append(escapeLabel(gc.getName()))
                      .append("\"} ")
                      .append(gc.getCollectionTime() / 1000.0)
                      .append("\n");
                }
            }
        }

        // Thread metrics
        ThreadMXBean threadBean = ManagementFactory.getThreadMXBean();
        appendGauge(sb, "jvm_threads_current", "Current thread count", threadBean.getThreadCount());
        appendGauge(sb, "jvm_threads_daemon", "Daemon thread count", threadBean.getDaemonThreadCount());
        appendGauge(sb, "jvm_threads_peak", "Peak thread count", threadBean.getPeakThreadCount());

        // CPU metrics from the background sampler (the MXBean read can block).
        // A negative load means "no sample yet" and is left out, not exported as -1.
        double processLoad = CpuSampler.processLoad();
        double systemLoad = CpuSampler.systemLoad();
        if (processLoad >= 0) appendGauge(sb, "process_cpu_usage", "Process CPU usage (0-1)", processLoad);
        if (systemLoad >= 0) appendGauge(sb, "system_cpu_usage", "System CPU usage (0-1)", systemLoad);

        // Uptime of the server process, not of this plugin.
        appendGauge(sb, "hytale_uptime_seconds", "Server uptime in seconds", ServerHandler.uptimeSeconds());

        return sb.toString();
    }

    /** Per-world tick metrics, entities and loaded chunks. */
    private void appendWorldPerf(StringBuilder sb, List<WorldPerf.Snapshot> worlds) {
        if (worlds.isEmpty()) return;

        sb.append("# HELP hytale_world_tps World TPS per window (server formula)\n");
        sb.append("# TYPE hytale_world_tps gauge\n");
        for (WorldPerf.Snapshot w : worlds) {
            for (WorldPerf.Window win : w.windows) {
                appendWindowSample(sb, "hytale_world_tps", w.world, win.window, "avg", win.tpsAvg);
                appendWindowSample(sb, "hytale_world_tps", w.world, win.window, "min", win.tpsMin);
                appendWindowSample(sb, "hytale_world_tps", w.world, win.window, "max", win.tpsMax);
            }
        }

        sb.append("# HELP hytale_world_tick_ms Time a world tick took to compute, in milliseconds\n");
        sb.append("# TYPE hytale_world_tick_ms gauge\n");
        for (WorldPerf.Snapshot w : worlds) {
            for (WorldPerf.Window win : w.windows) {
                appendWindowSample(sb, "hytale_world_tick_ms", w.world, win.window, "avg", win.tickMsAvg);
                appendWindowSample(sb, "hytale_world_tick_ms", w.world, win.window, "min", win.tickMsMin);
                appendWindowSample(sb, "hytale_world_tick_ms", w.world, win.window, "max", win.tickMsMax);
            }
        }

        appendWorldGauge(sb, "hytale_world_tps_target", "Target TPS of the world", worlds, w -> w.targetTps);
        appendWorldGauge(sb, "hytale_world_entities", "Entities in the world", worlds, w -> w.entities);
        appendWorldGauge(sb, "hytale_world_chunks_loaded", "Loaded chunks of the world", worlds, w -> w.loadedChunks);

        long entities = 0;
        long chunks = 0;
        for (WorldPerf.Snapshot w : worlds) {
            if (w.entities > 0) entities += w.entities;
            if (w.loadedChunks > 0) chunks += w.loadedChunks;
        }
        appendGauge(sb, "hytale_entities_total", "Entities in all worlds", entities);
        appendGauge(sb, "hytale_chunks_loaded_total", "Loaded chunks in all worlds", chunks);
    }

    private void appendWindowSample(StringBuilder sb, String name, String world, String window, String stat, double value) {
        sb.append(name)
          .append("{world=\"").append(escapeLabel(world))
          .append("\",window=\"").append(escapeLabel(window))
          .append("\",stat=\"").append(stat)
          .append("\"} ")
          .append(formatValue(value))
          .append("\n");
    }

    private void appendWorldGauge(StringBuilder sb, String name, String help, List<WorldPerf.Snapshot> worlds,
                                  ToDoubleFunction<WorldPerf.Snapshot> value) {
        sb.append("# HELP ").append(name).append(" ").append(help).append("\n");
        sb.append("# TYPE ").append(name).append(" gauge\n");
        for (WorldPerf.Snapshot w : worlds) {
            double v = value.applyAsDouble(w);
            if (v < 0) continue; // -1 = not available
            sb.append(name)
              .append("{world=\"").append(escapeLabel(w.world)).append("\"} ")
              .append(formatValue(v))
              .append("\n");
        }
    }

    private void appendGauge(StringBuilder sb, String name, String help, double value) {
        sb.append("# HELP ").append(name).append(" ").append(help).append("\n");
        sb.append("# TYPE ").append(name).append(" gauge\n");
        sb.append(name).append(" ").append(formatValue(value)).append("\n");
    }

    private void appendGauge(StringBuilder sb, String name, String help, long value) {
        sb.append("# HELP ").append(name).append(" ").append(help).append("\n");
        sb.append("# TYPE ").append(name).append(" gauge\n");
        sb.append(name).append(" ").append(value).append("\n");
    }

    private void appendCounter(StringBuilder sb, String name, String help, long value) {
        sb.append("# HELP ").append(name).append(" ").append(help).append("\n");
        sb.append("# TYPE ").append(name).append(" counter\n");
        sb.append(name).append(" ").append(value).append("\n");
    }

    private String formatValue(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            return "0";
        }
        // Format to avoid scientific notation for small numbers
        if (value == (long) value) {
            return String.valueOf((long) value);
        }
        return String.format("%.6f", value).replaceAll("0+$", "").replaceAll("\\.$", "");
    }

    private String escapeLabel(String value) {
        return value.replace("\\", "\\\\")
                   .replace("\"", "\\\"")
                   .replace("\n", "\\n");
    }

    /**
     * Increment player join counter.
     */
    public void incrementPlayerJoins() {
        playerJoins.incrementAndGet();
    }

    /**
     * Increment player leave counter.
     */
    public void incrementPlayerLeaves() {
        playerLeaves.incrementAndGet();
    }
}
