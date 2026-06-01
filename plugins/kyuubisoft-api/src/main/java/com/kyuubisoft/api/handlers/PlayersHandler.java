package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.NameMatching;
import com.hypixel.hytale.server.core.entity.entities.Player;
import com.hypixel.hytale.server.core.modules.entitystats.EntityStatMap;
import com.hypixel.hytale.server.core.modules.entitystats.EntityStatValue;
import com.hypixel.hytale.server.core.modules.entitystats.asset.DefaultEntityStatTypes;
import com.hypixel.hytale.math.vector.Transform;
import com.hypixel.hytale.math.vector.Rotation3f;
import org.joml.Vector3d;

import java.util.*;
import java.util.HashMap;
import java.util.Map;
import java.util.logging.Logger;

/**
 * Handler for player-related API endpoints.
 *
 * <h3>Hytale 2026-05 API notes</h3>
 * <ul>
 *   <li>{@code Transform.getPosition()} now returns {@link org.joml.Vector3d}
 *       and {@code Transform.getRotation()} a {@link Rotation3f} with explicit
 *       {@code yaw()}/{@code pitch()} accessors (older versions used
 *       {@code com.hypixel.hytale.math.vector.Vector3d/Vector3f}).</li>
 *   <li>{@code Universe.getPlayers()} returns {@link Collection} (was List).</li>
 *   <li>Player actions are dispatched through the server's own commands via
 *       {@link CommandExecutor} rather than the old "not implemented" stubs.</li>
 * </ul>
 */
public class PlayersHandler {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    // ============================================================
    // Player Actions (POST endpoints)
    // ============================================================

    /** POST /api/players/{name}/heal — restore the player's stats to full. */
    public ActionResult healPlayer(String playerName) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);
        return CommandExecutor.run("player stats settomax --player " + name);
    }

    /** POST /api/players/{name}/respawn — respawn the player at their spawn point. */
    public ActionResult respawnPlayer(String playerName) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);
        return CommandExecutor.run("player respawn --player " + name);
    }

    /** POST /api/players/{name}/kill — kill the player. */
    public ActionResult killPlayer(String playerName) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);
        return CommandExecutor.run("kill " + name);
    }

    /** POST /api/players/{name}/teleport — to coordinates or another player. */
    public ActionResult teleportPlayer(String playerName, Double x, Double y, Double z, String targetPlayer) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);

        if (targetPlayer != null && !targetPlayer.isEmpty()) {
            String target = safeName(targetPlayer);
            if (target == null) return new ActionResult(false, "Invalid target player name");
            if (findPlayer(target) == null) return new ActionResult(false, "Target player not found: " + target);
            return CommandExecutor.run("tp " + name + " " + target);
        }
        if (x == null || y == null || z == null
                || !Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) {
            return new ActionResult(false, "No valid target specified");
        }
        return CommandExecutor.run("tp " + name + " " + fmt(x) + " " + fmt(y) + " " + fmt(z));
    }

    /** POST /api/players/{name}/gamemode — Hytale today only has Adventure/Creative. */
    public ActionResult setGamemode(String playerName, String gamemode) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);

        String mode = gamemode == null ? "" : gamemode.trim().toLowerCase(Locale.ROOT);
        // Accept long and short forms; map to the two modes the server supports.
        if (mode.equals("c") || mode.equals("creative")) mode = "creative";
        else if (mode.equals("a") || mode.equals("adventure")) mode = "adventure";
        else return new ActionResult(false, "Unsupported gamemode (use creative/adventure): " + gamemode);

        return CommandExecutor.run("gamemode " + mode + " " + name);
    }

    /** POST /api/players/{name}/inventory/clear — clear the player's inventory. */
    public ActionResult clearInventory(String playerName) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);
        return CommandExecutor.run("inventory clear " + name);
    }

    /**
     * POST /api/players/{name}/give — give an item to an online player.
     *
     * Dispatched through the server's own /give command (via {@link CommandExecutor})
     * rather than a hand-rolled ECS {@code Player.giveItem(...)} call: that reuses
     * the server's validated item lookup + inventory/networking handling and the
     * exact syntax the panel already used over the console. The native
     * {@code Player.giveItem(ItemStack, Ref, ComponentAccessor)} path would need
     * a world-thread ComponentAccessor and is deferred.
     */
    public ActionResult givePlayer(String playerName, String itemId, Integer amount) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);
        if (itemId == null || !itemId.toLowerCase(Locale.ROOT).matches("[a-z][a-z0-9_]*(:[a-z][a-z0-9_/]*)?")) {
            return new ActionResult(false, "Invalid item id");
        }
        String item = itemId.toLowerCase(Locale.ROOT);
        int qty = (amount != null && amount > 0) ? Math.min(amount, 9999) : 1;
        String cmd = qty > 1 ? "give " + name + " " + item + " --quantity=" + qty
                             : "give " + name + " " + item;
        return CommandExecutor.run(cmd);
    }

    /** Find an online player by name (case-insensitive) using the native lookup. */
    private PlayerRef findPlayer(String playerName) {
        try {
            return Universe.get().getPlayerByUsername(playerName, NameMatching.EXACT_IGNORE_CASE);
        } catch (Throwable t) {
            // Fall back to a manual scan if the lookup overload misbehaves.
            for (PlayerRef player : Universe.get().getPlayers()) {
                if (player.getUsername().equalsIgnoreCase(playerName)) return player;
            }
            return null;
        }
    }

    /** Allow only the safe player-name charset; returns null if invalid. */
    private static String safeName(String name) {
        if (name == null) return null;
        return name.matches("[\\w-]{1,32}") ? name : null;
    }

    /** Trim float noise so commands stay clean. */
    private static String fmt(double v) {
        if (v == Math.rint(v)) return String.valueOf((long) v);
        return String.valueOf(Math.round(v * 1000.0) / 1000.0);
    }

    // ============================================================
    // Player Info (GET endpoints)
    // ============================================================

    /** GET /api/players — all online players across all worlds. */
    public PlayersResponse getAllPlayers() {
        Collection<PlayerRef> players = Universe.get().getPlayers();
        List<PlayerData> playerDataList = new ArrayList<>();
        for (PlayerRef player : players) {
            playerDataList.add(createPlayerData(player));
        }
        return new PlayersResponse(playerDataList.size(), playerDataList);
    }

    /** GET /api/players/{world} — all players in a specific world. */
    public PlayersResponse getPlayersInWorld(String worldName) {
        Universe universe = Universe.get();
        World world = universe.getWorld(worldName);
        if (world == null) {
            return new PlayersResponse(0, Collections.emptyList());
        }

        List<PlayerData> playerDataList = new ArrayList<>();
        for (PlayerRef player : universe.getPlayers()) {
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

    /** GET /api/players/{name}/details — detailed info about a specific player. */
    public PlayerDetails getPlayerDetails(String playerName) {
        PlayerRef player = findPlayer(playerName);
        return player == null ? null : createPlayerDetails(player);
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

        try {
            Transform transform = player.getTransform();
            if (transform != null) {
                Vector3d pos = transform.getPosition();
                if (pos != null) {
                    data.position = new Position(pos.x(), pos.y(), pos.z());
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

        // Position and rotation from the transform.
        try {
            Transform transform = player.getTransform();
            if (transform != null) {
                Vector3d pos = transform.getPosition();
                if (pos != null) {
                    details.position = new Position(pos.x(), pos.y(), pos.z());
                }
                Rotation3f rot = transform.getRotation();
                if (rot != null) {
                    details.yaw = rot.yaw();
                    details.pitch = rot.pitch();
                }
            }
        } catch (Exception e) {
            details.position = null;
        }

        // Real gamemode via the Player entity component (Adventure/Creative).
        details.gamemode = "unknown";
        try {
            Player p = player.getComponent(Player.getComponentType());
            if (p != null && p.getGameMode() != null) {
                details.gamemode = p.getGameMode().name().toLowerCase(Locale.ROOT);
            }
        } catch (Throwable ignored) {
            // Component not readable off the world thread in this build — keep "unknown".
        }

        // Real health via the entity-stats component.
        details.health = -1;
        details.maxHealth = -1;
        try {
            EntityStatMap stats = player.getComponent(EntityStatMap.getComponentType());
            if (stats != null) {
                EntityStatValue health = stats.get(DefaultEntityStatTypes.getHealth());
                if (health != null) {
                    details.health = round2(health.get());
                    details.maxHealth = round2(health.getMax());
                }
            }
        } catch (Throwable ignored) {
            // Stats not readable here — leave as -1 ("unknown").
        }

        return details;
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    /** GET /api/players/{name}/inventory — placeholder until item containers are mapped. */
    public PlayerInventory getPlayerInventory(String playerName) {
        PlayerRef player = findPlayer(playerName);
        return player == null ? null : createPlayerInventory(player);
    }

    private PlayerInventory createPlayerInventory(PlayerRef player) {
        PlayerInventory inventory = new PlayerInventory();
        inventory.uuid = player.getUuid().toString();
        inventory.name = player.getUsername();
        inventory.items = new ArrayList<>();
        inventory.totalSlots = 36;
        inventory.usedSlots = 0;

        // NOTE: Reading the live inventory requires walking the player's
        // ItemContainer windows (HotbarManager / WindowManager). That is a
        // larger, version-sensitive mapping deferred to a follow-up; the
        // structure is returned empty rather than fabricated.
        return inventory;
    }

    /** GET /api/players/{name}/appearance — placeholder structure. */
    public PlayerAppearance getPlayerAppearance(String playerName) {
        PlayerRef player = findPlayer(playerName);
        return player == null ? null : createPlayerAppearance(player);
    }

    private PlayerAppearance createPlayerAppearance(PlayerRef player) {
        PlayerAppearance appearance = new PlayerAppearance();
        appearance.uuid = player.getUuid().toString();
        appearance.name = player.getUsername();
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
