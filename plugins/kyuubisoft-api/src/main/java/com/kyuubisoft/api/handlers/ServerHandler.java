package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.HytaleServer;
import com.hypixel.hytale.server.core.HytaleServerConfig;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.common.util.java.ManifestUtil;
import com.kyuubisoft.api.metrics.CpuSampler;
import com.kyuubisoft.api.metrics.WorldPerf;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.time.Instant;
import java.util.List;

/**
 * Handler for server-related API endpoints
 */
public class ServerHandler {

    /** Hytale's default tick rate, used only while no world runs yet. */
    private static final int DEFAULT_TARGET_TPS = 30;

    /** Epoch millis when the server process (this JVM) started. */
    public static long processStartMillis() {
        return ManagementFactory.getRuntimeMXBean().getStartTime();
    }

    /** Seconds since the server process started. */
    public static long uptimeSeconds() {
        return ManagementFactory.getRuntimeMXBean().getUptime() / 1000;
    }

    /** MaxPlayers from the server's own config; -1 when it is not loaded. */
    public static int maxPlayers() {
        try {
            HytaleServer server = HytaleServer.get();
            HytaleServerConfig config = server != null ? server.getConfig() : null;
            return config != null ? config.getMaxPlayers() : -1;
        } catch (RuntimeException e) {
            return -1;
        }
    }

    /**
     * GET /api/server/info
     * Returns general server information
     */
    public ServerInfo getServerInfo() {
        ServerInfo info = new ServerInfo();

        // Version info
        try {
            info.version = ManifestUtil.getImplementationVersion();
            info.patchline = ManifestUtil.getPatchline();
        } catch (Exception e) {
            info.version = "unknown";
            info.patchline = "unknown";
        }

        // Player counts
        try {
            info.onlinePlayers = Universe.get().getPlayers().size();
        } catch (Exception e) {
            info.onlinePlayers = 0;
        }
        info.maxPlayers = maxPlayers();

        // World count
        try {
            info.worldCount = Universe.get().getWorlds().size();
        } catch (Exception e) {
            info.worldCount = 0;
        }

        // Uptime of the server process, not of this plugin.
        info.uptimeSeconds = uptimeSeconds();
        info.startedAt = Instant.ofEpochMilli(processStartMillis()).toString();

        ServerTps tps = getTps();
        info.tps = tps.tps;
        info.mspt = tps.mspt;
        info.targetTps = tps.targetTps;
        info.tpsWorld = tps.world;

        return info;
    }

    /**
     * GET /api/server/tps
     * Tick metrics of every running world plus the headline value: the world
     * with the lowest TPS relative to its target (10 s average).
     */
    public ServerTps getTps() {
        List<WorldPerf.Snapshot> worlds = WorldPerf.snapshotAll();
        WorldPerf.Snapshot slowest = WorldPerf.slowest(worlds);
        ServerTps result = new ServerTps();
        result.worlds = worlds;
        if (slowest != null) {
            result.world = slowest.world;
            result.tps = slowest.tps;
            result.mspt = slowest.mspt;
            result.targetTps = slowest.targetTps;
        } else {
            result.tps = null;
            result.mspt = null;
            result.targetTps = DEFAULT_TARGET_TPS;
        }
        return result;
    }

    /**
     * GET /api/server/performance
     * Returns server performance metrics
     */
    public PerformanceInfo getPerformance() {
        PerformanceInfo perf = new PerformanceInfo();

        ServerTps tps = getTps();
        perf.tps = tps.tps;
        perf.mspt = tps.mspt;
        perf.targetTps = tps.targetTps;
        perf.tpsWorld = tps.world;
        perf.worlds = tps.worlds;

        // Entities and loaded chunks summed over all running worlds.
        int entities = 0;
        int chunks = 0;
        for (WorldPerf.Snapshot world : tps.worlds) {
            if (world.entities > 0) entities += world.entities;
            if (world.loadedChunks > 0) chunks += world.loadedChunks;
        }
        perf.totalEntities = entities;
        perf.totalLoadedChunks = chunks;

        // CPU usage from the background sampler (the MXBean read can block).
        // A negative load means "no sample yet": omitted, not -100 %.
        perf.cpuUsage = percentOrNull(CpuSampler.systemLoad());
        perf.processCpuUsage = percentOrNull(CpuSampler.processLoad());

        // All live threads of the JVM, not just this plugin's thread group.
        perf.threadCount = ManagementFactory.getThreadMXBean().getThreadCount();

        return perf;
    }

    /** A 0..1 load as a percentage with two decimals; null when unknown. */
    static Double percentOrNull(double load) {
        if (Double.isNaN(load) || load < 0) return null;
        return Math.round(load * 100.0 * 100.0) / 100.0;
    }

    /**
     * GET /api/server/memory
     * Returns detailed memory statistics
     */
    public MemoryInfo getMemory() {
        MemoryInfo mem = new MemoryInfo();

        MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
        MemoryUsage heapUsage = memoryBean.getHeapMemoryUsage();
        MemoryUsage nonHeapUsage = memoryBean.getNonHeapMemoryUsage();

        // Heap memory
        mem.heapUsed = bytesToMB(heapUsage.getUsed());
        mem.heapMax = bytesToMB(heapUsage.getMax());
        mem.heapCommitted = bytesToMB(heapUsage.getCommitted());

        // Non-heap memory
        mem.nonHeapUsed = bytesToMB(nonHeapUsage.getUsed());
        mem.nonHeapCommitted = bytesToMB(nonHeapUsage.getCommitted());

        // Percentage
        if (heapUsage.getMax() > 0) {
            mem.heapUsagePercent = Math.round((double) heapUsage.getUsed() / heapUsage.getMax() * 100.0 * 10.0) / 10.0;
        }

        // Runtime memory info
        Runtime runtime = Runtime.getRuntime();
        mem.totalMemory = bytesToMB(runtime.totalMemory());
        mem.freeMemory = bytesToMB(runtime.freeMemory());
        mem.maxMemory = bytesToMB(runtime.maxMemory());

        return mem;
    }

    private double bytesToMB(long bytes) {
        return Math.round(bytes / 1024.0 / 1024.0 * 100.0) / 100.0;
    }

    // Response classes

    public static class ServerInfo {
        public String version;
        public String patchline;
        public int onlinePlayers;
        /** From the server config; -1 when unknown. */
        public int maxPlayers;
        public int worldCount;
        /** Since the server process started. */
        public long uptimeSeconds;
        public String startedAt;
        /** 10 s average TPS of {@link #tpsWorld}; null while no world runs. */
        public Double tps;
        /** 10 s average tick time of {@link #tpsWorld} in ms (compute time, not the interval). */
        public Double mspt;
        public int targetTps;
        /** World the headline TPS belongs to: the one with the lowest TPS relative to its target. */
        public String tpsWorld;
    }

    public static class ServerTps {
        /** World with the lowest TPS relative to its target; null without worlds. */
        public String world;
        public Double tps;
        public Double mspt;
        public int targetTps;
        public List<WorldPerf.Snapshot> worlds;
    }

    public static class PerformanceInfo {
        public Double tps;
        public Double mspt;
        public int targetTps;
        public String tpsWorld;
        public int totalEntities;
        public int totalLoadedChunks;
        /** System CPU load in percent; omitted while unknown. */
        public Double cpuUsage;
        /** CPU load of the server process in percent; omitted while unknown. */
        public Double processCpuUsage;
        public int threadCount;
        public List<WorldPerf.Snapshot> worlds;
    }

    public static class MemoryInfo {
        public double heapUsed;
        public double heapMax;
        public double heapCommitted;
        public double heapUsagePercent;
        public double nonHeapUsed;
        public double nonHeapCommitted;
        public double totalMemory;
        public double freeMemory;
        public double maxMemory;
    }
}
