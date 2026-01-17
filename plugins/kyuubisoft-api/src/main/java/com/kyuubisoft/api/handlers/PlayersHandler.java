package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.math.vector.Transform;
import com.hypixel.hytale.math.vector.Vector3d;
import com.hypixel.hytale.math.vector.Vector3f;

import java.util.*;
import java.util.HashMap;
import java.util.Map;

/**
 * Handler for player-related API endpoints
 */
public class PlayersHandler {

    /**
     * GET /api/players
     * Returns all online players across all worlds
     */
    public PlayersResponse getAllPlayers() {
        Universe universe = Universe.get();
        List<PlayerRef> players = universe.getPlayers();

        List<PlayerData> playerDataList = new ArrayList<>();
        for (PlayerRef player : players) {
            playerDataList.add(createPlayerData(player));
        }

        return new PlayersResponse(playerDataList.size(), playerDataList);
    }

    /**
     * GET /api/players/{world}
     * Returns all players in a specific world
     */
    public PlayersResponse getPlayersInWorld(String worldName) {
        Universe universe = Universe.get();
        World world = universe.getWorld(worldName);

        if (world == null) {
            return new PlayersResponse(0, Collections.emptyList());
        }

        List<PlayerData> playerDataList = new ArrayList<>();
        List<PlayerRef> players = universe.getPlayers();

        for (PlayerRef player : players) {
            // Check if player is in this world
            try {
                UUID worldUuid = player.getWorldUuid();
                if (worldUuid != null) {
                    World playerWorld = universe.getWorld(worldUuid);
                    if (playerWorld != null && playerWorld.getName().equals(worldName)) {
                        playerDataList.add(createPlayerData(player));
                    }
                }
            } catch (Exception e) {
                // Player may be transitioning between worlds
            }
        }

        return new PlayersResponse(playerDataList.size(), playerDataList);
    }

    /**
     * GET /api/players/{name}/details
     * Returns detailed information about a specific player
     */
    public PlayerDetails getPlayerDetails(String playerName) {
        Universe universe = Universe.get();
        List<PlayerRef> players = universe.getPlayers();

        for (PlayerRef player : players) {
            if (player.getUsername().equalsIgnoreCase(playerName)) {
                return createPlayerDetails(player);
            }
        }

        return null; // Player not found
    }

    private PlayerData createPlayerData(PlayerRef player) {
        PlayerData data = new PlayerData();
        data.uuid = player.getUuid().toString();
        data.name = player.getUsername();

        try {
            UUID worldUuid = player.getWorldUuid();
            if (worldUuid != null) {
                World world = Universe.get().getWorld(worldUuid);
                if (world != null) {
                    data.world = world.getName();
                }
            }
        } catch (Exception e) {
            data.world = "unknown";
        }

        // Get position from transform
        try {
            Transform transform = player.getTransform();
            if (transform != null) {
                Vector3d pos = transform.getPosition();
                if (pos != null) {
                    data.position = new Position(pos.getX(), pos.getY(), pos.getZ());
                }
            }
        } catch (Exception e) {
            data.position = null;
        }

        return data;
    }

    private PlayerDetails createPlayerDetails(PlayerRef player) {
        PlayerDetails details = new PlayerDetails();
        details.uuid = player.getUuid().toString();
        details.name = player.getUsername();

        try {
            UUID worldUuid = player.getWorldUuid();
            if (worldUuid != null) {
                World world = Universe.get().getWorld(worldUuid);
                if (world != null) {
                    details.world = world.getName();
                }
            }
        } catch (Exception e) {
            details.world = "unknown";
        }

        // Position and rotation from transform
        try {
            Transform transform = player.getTransform();
            if (transform != null) {
                Vector3d pos = transform.getPosition();
                if (pos != null) {
                    details.position = new Position(pos.getX(), pos.getY(), pos.getZ());
                }

                Vector3f rot = transform.getRotation();
                if (rot != null) {
                    details.yaw = rot.getY();
                    details.pitch = rot.getX();
                }
            }
        } catch (Exception e) {
            details.position = null;
        }

        // Try to get additional stats (may not be available depending on server version)
        try {
            details.gamemode = "unknown"; // TODO: Get actual gamemode when API available
            details.health = 20.0; // TODO: Get actual health
            details.maxHealth = 20.0;
        } catch (Exception e) {
            // Stats not available
        }

        return details;
    }

    /**
     * GET /api/players/{name}/inventory
     * Returns the player's inventory items
     */
    public PlayerInventory getPlayerInventory(String playerName) {
        Universe universe = Universe.get();
        List<PlayerRef> players = universe.getPlayers();

        for (PlayerRef player : players) {
            if (player.getUsername().equalsIgnoreCase(playerName)) {
                return createPlayerInventory(player);
            }
        }

        return null; // Player not found
    }

    private PlayerInventory createPlayerInventory(PlayerRef player) {
        PlayerInventory inventory = new PlayerInventory();
        inventory.uuid = player.getUuid().toString();
        inventory.name = player.getUsername();
        inventory.items = new ArrayList<>();
        inventory.totalSlots = 36;
        inventory.usedSlots = 0;

        // TODO: When Hytale API exposes inventory access, implement real inventory reading
        // For now, we return an empty inventory structure
        // Future implementation would look like:
        // PlayerInventoryAccess inv = player.getInventory();
        // for (int i = 0; i < inv.getSize(); i++) {
        //     ItemStack item = inv.getItem(i);
        //     if (item != null) {
        //         inventory.items.add(new InventoryItem(i, item.getId(), item.getAmount()));
        //         inventory.usedSlots++;
        //     }
        // }

        return inventory;
    }

    /**
     * GET /api/players/{name}/appearance
     * Returns the player's appearance/skin information
     */
    public PlayerAppearance getPlayerAppearance(String playerName) {
        Universe universe = Universe.get();
        List<PlayerRef> players = universe.getPlayers();

        for (PlayerRef player : players) {
            if (player.getUsername().equalsIgnoreCase(playerName)) {
                return createPlayerAppearance(player);
            }
        }

        return null; // Player not found
    }

    private PlayerAppearance createPlayerAppearance(PlayerRef player) {
        PlayerAppearance appearance = new PlayerAppearance();
        appearance.uuid = player.getUuid().toString();
        appearance.name = player.getUsername();

        // TODO: When Hytale API exposes appearance/customization data, implement real reading
        // For now, we return basic structure with placeholder data
        // Future implementation would look like:
        // PlayerCustomization custom = player.getCustomization();
        // appearance.skinId = custom.getSkinId();
        // appearance.bodyType = custom.getBodyType();
        // etc.

        appearance.skinId = null;
        appearance.modelType = "default";
        appearance.customization = new AppearanceCustomization();

        return appearance;
    }

    // Response classes

    public static class PlayersResponse {
        public final int count;
        public final List<PlayerData> players;

        public PlayersResponse(int count, List<PlayerData> players) {
            this.count = count;
            this.players = players;
        }
    }

    public static class PlayerData {
        public String uuid;
        public String name;
        public String world;
        public Position position;
    }

    public static class PlayerDetails extends PlayerData {
        public double yaw;
        public double pitch;
        public String gamemode;
        public double health;
        public double maxHealth;
    }

    public static class Position {
        public final double x;
        public final double y;
        public final double z;

        public Position(double x, double y, double z) {
            this.x = Math.round(x * 100.0) / 100.0;
            this.y = Math.round(y * 100.0) / 100.0;
            this.z = Math.round(z * 100.0) / 100.0;
        }
    }

    // Inventory classes

    public static class PlayerInventory {
        public String uuid;
        public String name;
        public List<InventoryItem> items;
        public int totalSlots;
        public int usedSlots;
    }

    public static class InventoryItem {
        public int slot;
        public String itemId;
        public String displayName;
        public int amount;
        public int durability;
        public int maxDurability;
        public List<String> enchantments;
        public Map<String, Object> nbt;

        public InventoryItem() {
            this.enchantments = new ArrayList<>();
            this.nbt = new HashMap<>();
        }

        public InventoryItem(int slot, String itemId, int amount) {
            this();
            this.slot = slot;
            this.itemId = itemId;
            this.amount = amount;
        }
    }

    // Appearance classes

    public static class PlayerAppearance {
        public String uuid;
        public String name;
        public String skinId;
        public String skinUrl;
        public String modelType; // "default" or "slim"
        public String capeId;
        public String capeUrl;
        public AppearanceCustomization customization;
    }

    public static class AppearanceCustomization {
        public String hairStyle;
        public String hairColor;
        public String eyeColor;
        public String skinTone;
        public String bodyType;
        public List<String> accessories;
        public Map<String, String> colors;

        public AppearanceCustomization() {
            this.accessories = new ArrayList<>();
            this.colors = new HashMap<>();
        }
    }
}
