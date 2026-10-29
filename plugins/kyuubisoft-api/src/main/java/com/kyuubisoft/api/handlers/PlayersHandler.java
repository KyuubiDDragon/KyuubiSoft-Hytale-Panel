package com.kyuubisoft.api.handlers;

import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.NameMatching;
import com.hypixel.hytale.server.core.entity.entities.Player;
import com.hypixel.hytale.server.core.inventory.InventoryComponent;
import com.hypixel.hytale.server.core.modules.entitystats.EntityStatMap;
import com.hypixel.hytale.server.core.modules.entitystats.EntityStatValue;
import com.hypixel.hytale.server.core.modules.entitystats.asset.DefaultEntityStatTypes;
import com.hypixel.hytale.math.vector.Transform;
import com.hypixel.hytale.math.vector.Rotation3f;
import com.hypixel.hytale.component.Ref;
import com.hypixel.hytale.component.Store;
import com.hypixel.hytale.server.core.modules.entity.component.HeadRotation;
import com.hypixel.hytale.server.core.modules.entity.component.TransformComponent;
import com.hypixel.hytale.server.core.universe.world.storage.EntityStore;
import com.kyuubisoft.api.util.WorldThread;
import com.kyuubisoft.api.web.ApiException;
import org.joml.Vector3d;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
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

    /**
     * POST /api/players/{name}/heal — health and stamina to their maximum, like
     * the server's own /heal macro does for its sender.
     */
    public ActionResult healPlayer(String playerName) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);
        ActionResult health = CommandExecutor.run("player stats settomax Health --player " + name);
        if (!health.success) return health;
        ActionResult stamina = CommandExecutor.run("player stats settomax Stamina --player " + name);
        if (!stamina.success) LOGGER.warning("Heal " + name + ": stamina not restored: " + stamina.message);
        return health;
    }

    /** POST /api/players/{name}/respawn — respawn the player at their spawn point. */
    public ActionResult respawnPlayer(String playerName) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        if (findPlayer(name) == null) return new ActionResult(false, "Player not found: " + name);
        // The usage variant with the player as its only argument.
        return CommandExecutor.run("player respawn " + name);
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

    /**
     * POST /api/players/{name}/inventory/clear — clear the player's inventory.
     *
     * <p>Done directly on the player's world thread: the server's
     * {@code /inventory clear} only clears the sender's own inventory and takes
     * no player. Clears the same sections as that command (everything, plus the
     * tool belt, which "everything" does not include). Blocks the calling
     * worker thread for up to {@link WorldThread#DEFAULT_TIMEOUT_MS}.</p>
     */
    public ActionResult clearInventory(String playerName) {
        String name = safeName(playerName);
        if (name == null) return new ActionResult(false, "Invalid player name");
        PlayerRef player = findPlayer(name);
        if (player == null) return new ActionResult(false, "Player not found: " + name);
        try {
            WorldThread.supplyForPlayer(player, (ref, store, world) -> {
                InventoryComponent.getCombined(store, ref, InventoryComponent.EVERYTHING).clear();
                InventoryComponent.Tool tools = store.getComponent(ref, InventoryComponent.Tool.getComponentType());
                if (tools != null) tools.getInventory().clear();
                return Boolean.TRUE;
            }).get(WorldThread.DEFAULT_TIMEOUT_MS + 500, TimeUnit.MILLISECONDS);
            return new ActionResult(true, "Cleared the inventory of " + player.getUsername());
        } catch (TimeoutException timeout) {
            return new ActionResult(false, "The player's world did not answer in time");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return new ActionResult(false, "Interrupted");
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause() != null ? failed.getCause() : failed;
            if (cause instanceof ApiException api) return new ActionResult(false, api.getMessage());
            if (cause instanceof TimeoutException) {
                return new ActionResult(false, "The player's world did not answer in time");
            }
            // The details only go to the server log; the panel gets a fixed message.
            LOGGER.warning("Clearing the inventory of " + name + " failed: " + cause);
            return new ActionResult(false, "Clearing the inventory failed; see the server log");
        }
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

    /**
     * GET /api/players/{name}/details — detailed info about a specific player.
     *
     * Components may only be read on the player's world thread, so the read is
     * queued there and the future completes once it ran (404 when the player
     * is offline or between worlds, 504 when the world does not answer).
     */
    public CompletableFuture<PlayerDetails> getPlayerDetails(String playerName) {
        PlayerRef player = findPlayer(playerName);
        if (player == null) {
            return CompletableFuture.failedFuture(new ApiException(404, "Player not found"));
        }
        return WorldThread.supplyForPlayer(player, (ref, store, world) -> createPlayerDetails(player, ref, store, world));
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

    /** Runs on the player's world thread: reads straight from the entity store. */
    private PlayerDetails createPlayerDetails(PlayerRef player, Ref<EntityStore> ref, Store<EntityStore> store, World world) {
        PlayerDetails details = new PlayerDetails();
        details.uuid = player.getUuid().toString();
        details.name = player.getUsername();
        details.world = world.getName();

        // Position from the transform, look direction from the head rotation
        // (the body rotation lags behind where the player actually looks).
        TransformComponent transform = store.getComponent(ref, TransformComponent.getComponentType());
        if (transform != null && transform.getPosition() != null) {
            Vector3d pos = transform.getPosition();
            details.position = new Position(pos.x(), pos.y(), pos.z());
        }
        HeadRotation head = store.getComponent(ref, HeadRotation.getComponentType());
        Rotation3f rot = head != null ? head.getRotation() : (transform != null ? transform.getRotation() : null);
        if (rot != null) {
            details.yaw = rot.yaw();
            details.pitch = rot.pitch();
        }

        // Real gamemode via the Player entity component (Adventure/Creative).
        details.gamemode = "unknown";
        Player p = store.getComponent(ref, Player.getComponentType());
        if (p != null && p.getGameMode() != null) {
            details.gamemode = p.getGameMode().name().toLowerCase(Locale.ROOT);
        }

        // Real health via the entity-stats component; -1 = unknown.
        details.health = -1;
        details.maxHealth = -1;
        EntityStatMap stats = store.getComponent(ref, EntityStatMap.getComponentType());
        if (stats != null) {
            EntityStatValue health = stats.get(DefaultEntityStatTypes.getHealth());
            if (health != null) {
                details.health = round2(health.get());
                details.maxHealth = round2(health.getMax());
            }
        }

        return details;
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
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
