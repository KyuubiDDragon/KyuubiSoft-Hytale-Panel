package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.kyuubisoft.api.metrics.WorldPerf;

import java.util.*;

/**
 * Handler for world-related API endpoints
 */
public class WorldsHandler {

    /**
     * GET /api/worlds
     * Returns all available worlds
     */
    public WorldsResponse getAllWorlds() {
        Universe universe = Universe.get();
        Map<String, World> worldMap = universe.getWorlds();

        List<WorldData> worldDataList = new ArrayList<>();
        for (World world : worldMap.values()) {
            worldDataList.add(createWorldData(world));
        }

        return new WorldsResponse(worldDataList.size(), worldDataList);
    }

    /**
     * GET /api/worlds/{name}
     * Returns information about a specific world
     */
    public WorldData getWorld(String worldName) {
        Universe universe = Universe.get();
        World world = universe.getWorld(worldName);

        if (world == null) {
            return null;
        }

        return createWorldData(world);
    }

    /**
     * GET /api/worlds/{name}/stats
     * Returns detailed statistics for a world
     */
    public WorldStats getWorldStats(String worldName) {
        Universe universe = Universe.get();
        World world = universe.getWorld(worldName);

        if (world == null) {
            return null;
        }

        return createWorldStats(world);
    }

    /**
     * GET /api/worlds/{name}/perf
     * Tick metrics (TPS, tick time over 10 s / 1 min / 5 min) of one world;
     * null when the world does not exist or is not running.
     */
    public WorldPerf.Snapshot getWorldPerf(String worldName) {
        World world = Universe.get().getWorld(worldName);
        return world == null ? null : WorldPerf.snapshot(world);
    }

    private WorldData createWorldData(World world) {
        WorldData data = new WorldData();
        data.name = world.getName();

        // Hytale 2026-05 API exposes per-world counts/state directly instead of
        // scanning the whole universe.
        try {
            data.playerCount = world.getPlayerCount();
        } catch (Exception e) {
            data.playerCount = 0;
        }
        try {
            data.isTicking = world.isTicking();
        } catch (Exception e) {
            data.isTicking = true;
        }

        return data;
    }

    private WorldStats createWorldStats(World world) {
        WorldStats stats = new WorldStats();
        stats.name = world.getName();

        try {
            stats.playerCount = world.getPlayerCount();
        } catch (Exception e) {
            stats.playerCount = 0;
        }
        try {
            stats.isTicking = world.isTicking();
        } catch (Exception e) {
            stats.isTicking = true;
        }
        // Current tick of this world's simulation loop — useful as a liveness/age signal.
        try {
            stats.currentTick = world.getTick();
        } catch (Exception e) {
            stats.currentTick = -1;
        }

        // Entity and loaded-chunk counts straight from the world's stores
        // (plain counters, readable from any thread). -1 = not available.
        WorldPerf.Snapshot perf = WorldPerf.snapshot(world);
        stats.loadedChunks = perf != null ? perf.loadedChunks : -1;
        stats.entityCount = perf != null ? perf.entities : -1;
        // Block entities are not counted separately by the server.
        stats.tileEntityCount = -1;
        stats.perf = perf;

        return stats;
    }

    // Response classes

    public static class WorldsResponse {
        public final int count;
        public final List<WorldData> worlds;

        public WorldsResponse(int count, List<WorldData> worlds) {
            this.count = count;
            this.worlds = worlds;
        }
    }

    public static class WorldData {
        public String name;
        public int playerCount;
        public boolean isTicking;
    }

    public static class WorldStats extends WorldData {
        public long currentTick;
        public int loadedChunks;
        public int entityCount;
        public int tileEntityCount;
        /** Tick metrics of this world; omitted while it is not running. */
        public WorldPerf.Snapshot perf;
    }
}
