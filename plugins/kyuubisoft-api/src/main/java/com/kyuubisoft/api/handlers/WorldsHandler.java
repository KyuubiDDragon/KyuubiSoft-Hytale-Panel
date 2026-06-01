package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;

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

        // Loaded chunk / entity counts are not exposed as cheap aggregate getters
        // by the current Hytale API; left as -1 ("unknown") rather than guessed.
        stats.loadedChunks = -1;
        stats.entityCount = -1;
        stats.tileEntityCount = -1;

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
    }
}
