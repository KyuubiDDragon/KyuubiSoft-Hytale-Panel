package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.common.util.java.ManifestUtil;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.time.Instant;

/**
 * Handler for server-related API endpoints
 */
public class ServerHandler {

    private static final long SERVER_START_TIME = System.currentTimeMillis();

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
            info.maxPlayers = 100; // TODO: Get from config when available
        } catch (Exception e) {
            info.onlinePlayers = 0;
            info.maxPlayers = 100;
        }

        // World count
        try {
            info.worldCount = Universe.get().getWorlds().size();
        } catch (Exception e) {
            info.worldCount = 0;
        }

        // Uptime
        info.uptimeSeconds = (System.currentTimeMillis() - SERVER_START_TIME) / 1000;
        info.startedAt = Instant.ofEpochMilli(SERVER_START_TIME).toString();

        // TPS (we'll estimate based on timing if actual TPS not available)
        info.tps = 20.0; // Default to ideal TPS
        info.mspt = 50.0; // Default to ideal MSPT (1000ms / 20 ticks)

        return info;
    }

    /**
     * GET /api/server/performance
     * Returns server performance metrics
     */
    public PerformanceInfo getPerformance() {
        PerformanceInfo perf = new PerformanceInfo();

        // TPS/MSPT
        perf.tps = 20.0; // TODO: Get actual TPS when API available
        perf.mspt = 50.0;

        // Entity count (total across all worlds)
        try {
            perf.totalEntities = -1; // TODO: Count entities when API available
        } catch (Exception e) {
            perf.totalEntities = -1;
        }

        // Loaded chunks (total)
        try {
            perf.totalLoadedChunks = -1; // TODO: Count chunks when API available
        } catch (Exception e) {
            perf.totalLoadedChunks = -1;
        }

        // CPU usage (JVM)
        try {
            com.sun.management.OperatingSystemMXBean osBean =
                    (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
            perf.cpuUsage = Math.round(osBean.getCpuLoad() * 100.0 * 100.0) / 100.0;
            perf.processCpuUsage = Math.round(osBean.getProcessCpuLoad() * 100.0 * 100.0) / 100.0;
        } catch (Exception e) {
            perf.cpuUsage = -1;
            perf.processCpuUsage = -1;
        }

        // Thread count
        perf.threadCount = Thread.activeCount();

        return perf;
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
        public int maxPlayers;
        public int worldCount;
        public long uptimeSeconds;
        public String startedAt;
        public double tps;
        public double mspt;
    }

    public static class PerformanceInfo {
        public double tps;
        public double mspt;
        public int totalEntities;
        public int totalLoadedChunks;
        public double cpuUsage;
        public double processCpuUsage;
        public int threadCount;
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
