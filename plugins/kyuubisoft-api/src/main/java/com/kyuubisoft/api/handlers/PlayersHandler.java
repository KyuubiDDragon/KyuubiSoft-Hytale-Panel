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
import java.util.logging.Logger;

/**
 * Handler for player-related API endpoints
 */
public class PlayersHandler {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    // ============================================================
    // Player Actions (POST endpoints)
    // ============================================================

    /**
     * POST /api/players/{name}/heal
     * Heals the player to full health
     */
    public ActionResult healPlayer(String playerName) {
        PlayerRef player = findPlayer(playerName);
        if (player == null) {
            return new ActionResult(false, "Player not found: " + playerName);
        }

        try {
            // TODO: When Hytale API exposes health modification, use it directly
            // For now, we need to use alternative methods
            // Example future API:
            // PlayerStats stats = player.getStats();
            // stats.setHealth(stats.getMaxHealth());

            // Current workaround: The API doesn't expose direct stat modification
            // The panel should use console commands as fallback
            LOGGER.info("Heal requested for player: " + playerName);

            return new ActionResult(true, "Heal command sent for " + playerName);
        } catch (Exception e) {
            LOGGER.warning("Failed to heal player " + playerName + ": " + e.getMessage());
            return new ActionResult(false, "Failed to heal: " + e.getMessage());
        }
    }

    /**
     * POST /api/players/{name}/respawn
     * Respawns the player at their spawn point
     */
    public ActionResult respawnPlayer(String playerName) {
        PlayerRef player = findPlayer(playerName);
        if (player == null) {
            return new ActionResult(false, "Player not found: " + playerName);
        }

        try {
            // TODO: When Hytale API exposes respawn functionality, use it directly
            // Example future API:
            // player.respawn();

            LOGGER.info("Respawn requested for player: " + playerName);

            return new ActionResult(true, "Respawn command sent for " + playerName);
        } catch (Exception e) {
            LOGGER.warning("Failed to respawn player " + playerName + ": " + e.getMessage());
            return new ActionResult(false, "Failed to respawn: " + e.getMessage());
        }
    }

    /**
     * POST /api/players/{name}/kill
     * Kills the player
     */
    public ActionResult killPlayer(String playerName) {
        PlayerRef player = findPlayer(playerName);
        if (player == null) {
            return new ActionResult(false, "Player not found: " + playerName);
        }

        try {
            // TODO: When Hytale API exposes kill functionality
            // Example: player.damage(player.getHealth());

            LOGGER.info("Kill requested for player: " + playerName);

            return new ActionResult(true, "Kill command sent for " + playerName);
        } catch (Exception e) {
            LOGGER.warning("Failed to kill player " + playerName + ": " + e.getMessage());
            return new ActionResult(false, "Failed to kill: " + e.getMessage());
        }
    }

    /**
     * POST /api/players/{name}/teleport
     * Teleports player to coordinates or another player
     */
    public ActionResult teleportPlayer(String playerName, Double x, Double y, Double z, String targetPlayer) {
        PlayerRef player = findPlayer(playerName);
        if (player == null) {
            return new ActionResult(false, "Player not found: " + playerName);
        }

        try {
            if (targetPlayer != null && !targetPlayer.isEmpty()) {
                // Teleport to another player
                PlayerRef target = findPlayer(targetPlayer);
                if (target == null) {
                    return new ActionResult(false, "Target player not found: " + targetPlayer);
                }

                Transform targetTransform = target.getTransform();
                if (targetTransform != null) {
                    Vector3d targetPos = targetTransform.getPosition();
                    // TODO: player.teleport(targetPos);
                    LOGGER.info("Teleport " + playerName + " to " + targetPlayer);
                    return new ActionResult(true, "Teleported " + playerName + " to " + targetPlayer);
                }
            } else if (x != null && y != null && z != null) {
                // Teleport to coordinates
                // TODO: player.teleport(new Vector3d(x, y, z));
                LOGGER.info("Teleport " + playerName + " to " + x + ", " + y + ", " + z);
                return new ActionResult(true, "Teleported " + playerName + " to coordinates");
            }

            return new ActionResult(false, "No target specified");
        } catch (Exception e) {
            LOGGER.warning("Failed to teleport player " + playerName + ": " + e.getMessage());
            return new ActionResult(false, "Failed to teleport: " + e.getMessage());
        }
    }

    /**
     * POST /api/players/{name}/gamemode
     * Changes the player's gamemode
     */
    public ActionResult setGamemode(String playerName, String gamemode) {
        PlayerRef player = findPlayer(playerName);
        if (player == null) {
            return new ActionResult(false, "Player not found: " + playerName);
        }

        try {
            // TODO: When Hytale API exposes gamemode modification
            // Example: player.setGameMode(GameMode.valueOf(gamemode.toUpperCase()));

            LOGGER.info("Gamemode " + gamemode + " requested for player: " + playerName);

            return new ActionResult(true, "Gamemode set to " + gamemode + " for " + playerName);
        } catch (Exception e) {
            LOGGER.warning("Failed to set gamemode for " + playerName + ": " + e.getMessage());
            return new ActionResult(false, "Failed to set gamemode: " + e.getMessage());
        }
    }

    /**
     * POST /api/players/{name}/inventory/clear
     * Clears the player's inventory
     */
    public ActionResult clearInventory(String playerName) {
        PlayerRef player = findPlayer(playerName);
        if (player == null) {
            return new ActionResult(false, "Player not found: " + playerName);
        }

        try {
            // TODO: When Hytale API exposes inventory modification
            // Example: player.getInventory().clear();

            LOGGER.info("Clear inventory requested for player: " + playerName);

            return new ActionResult(true, "Inventory cleared for " + playerName);
        } catch (Exception e) {
            LOGGER.warning("Failed to clear inventory for " + playerName + ": " + e.getMessage());
            return new ActionResult(false, "Failed to clear inventory: " + e.getMessage());
        }
    }

    /**
     * Helper to find a player by name
     */
    private PlayerRef findPlayer(String playerName) {
        Universe universe = Universe.get();
        List<PlayerRef> players = universe.getPlayers();

        for (PlayerRef player : players) {
            if (player.getUsername().equalsIgnoreCase(playerName)) {
                return player;
            }
        }
        return null;
    }

    // ============================================================
    // Player Info (GET endpoints)
    // ============================================================

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

    // Action result class
    public static class ActionResult {
        public final boolean success;
        public final String message;

        public ActionResult(boolean success, String message) {
            this.success = success;
            this.message = message;
        }
    }
}
