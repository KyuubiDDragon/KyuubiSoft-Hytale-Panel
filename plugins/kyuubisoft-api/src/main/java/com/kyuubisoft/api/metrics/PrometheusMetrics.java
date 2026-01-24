package com.kyuubisoft.api.metrics;

import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.ThreadMXBean;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;

/**
 * Prometheus metrics collector for Hytale server.
 * Outputs metrics in Prometheus text exposition format without external dependencies.
 */
public class PrometheusMetrics {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static PrometheusMetrics instance;

    private final TpsTracker tpsTracker;
    private final long serverStartTime;

    // Counters for player events
    private final AtomicLong playerJoins = new AtomicLong(0);
    private final AtomicLong playerLeaves = new AtomicLong(0);

    public PrometheusMetrics(TpsTracker tpsTracker) {
        instance = this;
        this.tpsTracker = tpsTracker;
        this.serverStartTime = System.currentTimeMillis();
        LOGGER.info("Prometheus metrics initialized (native implementation)");
    }

    public static PrometheusMetrics getInstance() {
        return instance;
    }

    /**
     * Generate Prometheus text format metrics output.
     */
    public String generateMetrics() {
        StringBuilder sb = new StringBuilder();

        // TPS metrics
        TpsTracker.TpsSnapshot tps = tpsTracker.getSnapshot();
        appendGauge(sb, "hytale_tps_current", "Current server TPS", tps.current());
        appendGauge(sb, "hytale_tps_average", "Average TPS over last minute", tps.average());
        appendGauge(sb, "hytale_tps_min", "Minimum TPS over last minute", tps.min());
        appendGauge(sb, "hytale_tps_max", "Maximum TPS over last minute", tps.max());
        appendGauge(sb, "hytale_tps_target", "Target TPS", tps.target());
        appendGauge(sb, "hytale_mspt_current", "Current milliseconds per tick", tps.msptCurrent());
        appendGauge(sb, "hytale_mspt_average", "Average milliseconds per tick", tps.msptAverage());

        // Player metrics
        int onlinePlayers = 0;
        Map<String, Integer> playersPerWorld = new HashMap<>();
        try {
            Universe universe = Universe.get();
            List<PlayerRef> players = universe.getPlayers();
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
        appendGauge(sb, "hytale_players_max", "Maximum players allowed", 100); // TODO: Get from config

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

        // CPU metrics
        try {
            com.sun.management.OperatingSystemMXBean osBean =
                (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
            appendGauge(sb, "process_cpu_usage", "Process CPU usage (0-1)", osBean.getProcessCpuLoad());
            appendGauge(sb, "system_cpu_usage", "System CPU usage (0-1)", osBean.getCpuLoad());
        } catch (Exception e) {
            appendGauge(sb, "process_cpu_usage", "Process CPU usage (0-1)", -1);
            appendGauge(sb, "system_cpu_usage", "System CPU usage (0-1)", -1);
        }

        // Uptime
        long uptimeSeconds = (System.currentTimeMillis() - serverStartTime) / 1000;
        appendGauge(sb, "hytale_uptime_seconds", "Server uptime in seconds", uptimeSeconds);

        return sb.toString();
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
