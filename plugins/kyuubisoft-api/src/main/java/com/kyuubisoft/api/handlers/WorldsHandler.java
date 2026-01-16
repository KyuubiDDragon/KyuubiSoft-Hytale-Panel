package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.universe.PlayerRef;
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

        // Count players in this world
        try {
            Universe universe = Universe.get();
            List<PlayerRef> allPlayers = universe.getPlayers();
            int playerCount = 0;
            for (PlayerRef player : allPlayers) {
                try {
                    UUID worldUuid = player.getWorldUuid();
                    if (worldUuid != null) {
                        World playerWorld = universe.getWorld(worldUuid);
                        if (playerWorld != null && playerWorld.getName().equals(world.getName())) {
                            playerCount++;
                        }
                    }
                } catch (Exception e) {
                    // Ignore
                }
            }
            data.playerCount = playerCount;
        } catch (Exception e) {
            data.playerCount = 0;
        }

        // Try to get world properties
        try {
            data.isTicking = true; // Assume true if world exists
        } catch (Exception e) {
            data.isTicking = true;
        }

        return data;
    }

    private WorldStats createWorldStats(World world) {
        WorldStats stats = new WorldStats();
        stats.name = world.getName();

        // Count players
        try {
            Universe universe = Universe.get();
            List<PlayerRef> allPlayers = universe.getPlayers();
            int playerCount = 0;
            for (PlayerRef player : allPlayers) {
                try {
                    UUID worldUuid = player.getWorldUuid();
                    if (worldUuid != null) {
                        World playerWorld = universe.getWorld(worldUuid);
                        if (playerWorld != null && playerWorld.getName().equals(world.getName())) {
                            playerCount++;
                        }
                    }
                } catch (Exception e) {
                    // Ignore
                }
            }
            stats.playerCount = playerCount;
        } catch (Exception e) {
            stats.playerCount = 0;
        }

        // Try to get additional stats (may vary by server version)
        try {
            stats.loadedChunks = -1; // TODO: Get actual count when API available
            stats.entityCount = -1;
            stats.tileEntityCount = -1;
        } catch (Exception e) {
            // Stats not available
        }

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
        public int loadedChunks;
        public int entityCount;
        public int tileEntityCount;
    }
}
