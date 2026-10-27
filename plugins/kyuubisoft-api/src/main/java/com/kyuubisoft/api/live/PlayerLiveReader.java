package com.kyuubisoft.api.live;

import com.hypixel.hytale.component.ComponentType;
import com.hypixel.hytale.component.Ref;
import com.hypixel.hytale.component.Store;
import com.hypixel.hytale.math.vector.Rotation3f;
import com.hypixel.hytale.math.vector.Transform;
import com.hypixel.hytale.metrics.metric.HistoricMetric;
import com.hypixel.hytale.protocol.GameMode;
import com.hypixel.hytale.protocol.PlayerSkin;
import com.hypixel.hytale.protocol.packets.connection.PongType;
import com.hypixel.hytale.server.core.entity.entities.Player;
import com.hypixel.hytale.server.core.inventory.ActiveSlotInventoryComponent;
import com.hypixel.hytale.server.core.inventory.InventoryComponent;
import com.hypixel.hytale.server.core.inventory.ItemStack;
import com.hypixel.hytale.server.core.inventory.container.ItemContainer;
import com.hypixel.hytale.server.core.io.PacketHandler;
import com.hypixel.hytale.server.core.io.ProtocolVersion;
import com.hypixel.hytale.server.core.modules.entity.player.PlayerSkinComponent;
import com.hypixel.hytale.server.core.modules.entitystats.EntityStatMap;
import com.hypixel.hytale.server.core.modules.entitystats.EntityStatValue;
import com.hypixel.hytale.server.core.modules.entitystats.asset.DefaultEntityStatTypes;
import com.hypixel.hytale.server.core.permissions.PermissionsModule;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.universe.world.storage.EntityStore;
import com.kyuubisoft.api.util.WorldThread;
import com.kyuubisoft.api.web.ApiException;
import org.joml.Vector3d;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.IntSupplier;

/**
 * Live player data that lives in ECS components (game mode, stats, inventory,
 * skin). Components may only be read on the world thread of the world the
 * player is in, so every read is queued with {@code world.execute} and
 * completes a future; callers never block a Netty thread on it.
 *
 * <p>Failures are reported, never papered over with placeholder values: the
 * {@link WorldThread} errors (player left or is changing worlds, world gone,
 * timeout) and 501 when this server build lacks the data (missing component,
 * changed server API).</p>
 */
public final class PlayerLiveReader {

    // Direct is the real network round-trip; the others are fallbacks.
    private static final PongType[] PING_TYPES = { PongType.Direct, PongType.Tick, PongType.Raw };

    private final SessionTracker sessions;

    public PlayerLiveReader(SessionTracker sessions) {
        this.sessions = sessions;
    }

    // ============================================================
    // Session data (no components; safe on any thread)
    // ============================================================

    public SessionInfo session(PlayerRef player) {
        SessionInfo info = new SessionInfo();
        fillSession(info, player);
        return info;
    }

    private void fillSession(SessionInfo info, PlayerRef player) {
        UUID uuid = player.getUuid();
        info.uuid = uuid.toString();
        info.name = player.getUsername();
        World world = WorldThread.worldOf(player);
        info.world = world == null ? null : world.getName();
        info.joinedAt = LiveFormat.iso(sessions.joinedAt(uuid));
        info.language = player.getLanguage();
        info.ping = ping(player.getPacketHandler());
        info.protocolCrc = protocolCrc(player.getPacketHandler());
        try {
            info.groups = LiveFormat.sorted(PermissionsModule.get().getGroupsForUser(uuid));
        } catch (Throwable t) {
            info.groups = null;
        }
    }

    // ============================================================
    // World-thread reads
    // ============================================================

    public CompletableFuture<LiveSnapshot> live(PlayerRef player) {
        return onPlayerWorld(player, (ref, store, world) -> {
            LiveSnapshot snap = new LiveSnapshot();
            fillSession(snap, player);
            snap.world = world.getName();

            Player entity = store.getComponent(ref, Player.getComponentType());
            GameMode mode = entity == null ? null : entity.getGameMode();
            snap.gamemode = LiveFormat.lower(mode);

            EntityStatMap stats = store.getComponent(ref, EntityStatMap.getComponentType());
            if (stats != null) {
                snap.stats = new LinkedHashMap<>();
                putStat(snap.stats, "health", stats, DefaultEntityStatTypes::getHealth);
                putStat(snap.stats, "stamina", stats, DefaultEntityStatTypes::getStamina);
                putStat(snap.stats, "mana", stats, DefaultEntityStatTypes::getMana);
                putStat(snap.stats, "oxygen", stats, DefaultEntityStatTypes::getOxygen);
            }

            Transform transform = player.getTransform();
            if (transform != null && transform.getPosition() != null) {
                Vector3d pos = transform.getPosition();
                snap.position = new Position(pos.x(), pos.y(), pos.z());
            }
            Rotation3f head = player.getHeadRotation();
            if (head != null) {
                snap.yaw = LiveFormat.round2(head.yaw());
                snap.pitch = LiveFormat.round2(head.pitch());
            }

            snap.appearance = appearance(store, ref);
            return snap;
        });
    }

    public CompletableFuture<InventorySnapshot> inventory(PlayerRef player) {
        return onPlayerWorld(player, (ref, store, world) -> {
            InventorySnapshot inv = new InventorySnapshot();
            inv.uuid = player.getUuid().toString();
            inv.name = player.getUsername();
            inv.world = world.getName();
            inv.sections = new LinkedHashMap<>();
            inv.items = new ArrayList<>();
            addSection(inv, "hotbar", store, ref, InventoryComponent.Hotbar.getComponentType());
            addSection(inv, "storage", store, ref, InventoryComponent.Storage.getComponentType());
            addSection(inv, "armor", store, ref, InventoryComponent.Armor.getComponentType());
            addSection(inv, "utility", store, ref, InventoryComponent.Utility.getComponentType());
            addSection(inv, "tools", store, ref, InventoryComponent.Tool.getComponentType());
            addSection(inv, "backpack", store, ref, InventoryComponent.Backpack.getComponentType());
            if (inv.sections.isEmpty()) {
                // No section is readable: report "not supported", not an empty inventory.
                throw new ApiException(501, "This server build exposes no inventory for the player");
            }
            return inv;
        });
    }

    /**
     * Run {@code read} on the player's world thread. A server build without
     * the expected API surfaces as 501 instead of a generic 500.
     */
    private static <T> CompletableFuture<T> onPlayerWorld(PlayerRef player, WorldThread.PlayerTask<T> read) {
        return WorldThread.supplyForPlayer(player, (ref, store, world) -> {
            try {
                return read.apply(ref, store, world);
            } catch (LinkageError e) {
                throw new ApiException(501, "Not supported on this server build");
            }
        });
    }

    // ============================================================
    // Helpers
    // ============================================================

    private static void putStat(Map<String, Stat> out, String key, EntityStatMap stats, IntSupplier index) {
        try {
            EntityStatValue value = stats.get(index.getAsInt());
            if (value == null) return;
            Stat stat = new Stat();
            stat.value = LiveFormat.round2(value.get());
            stat.max = LiveFormat.round2(value.getMax());
            out.put(key, stat);
        } catch (RuntimeException ignored) {
            // Stat type not registered on this server (e.g. no mana): leave it out.
        }
    }

    private static <C extends InventoryComponent> void addSection(InventorySnapshot inv, String id,
            Store<EntityStore> store, Ref<EntityStore> ref, ComponentType<EntityStore, C> type) {
        if (type == null) return;
        C component = store.getComponent(ref, type);
        if (component == null) return;
        ItemContainer container = component.getInventory();
        if (container == null) return;

        Section section = new Section();
        section.capacity = container.getCapacity();
        if (component instanceof ActiveSlotInventoryComponent active) {
            byte slot = active.getActiveSlot();
            if (slot >= 0) section.activeSlot = (int) slot;
        }
        section.items = new ArrayList<>();
        container.forEach((slot, stack) -> {
            if (ItemStack.isEmpty(stack)) return;
            InventoryItem item = item(slot, stack);
            section.items.add(item);
            InventoryItem flat = item(slot, stack);
            flat.section = id;
            inv.items.add(flat);
        });
        section.items.sort((a, b) -> Integer.compare(a.slot, b.slot));
        inv.sections.put(id, section);
        inv.totalSlots += section.capacity;
        inv.usedSlots += section.items.size();
    }

    private static InventoryItem item(short slot, ItemStack stack) {
        InventoryItem item = new InventoryItem();
        item.slot = slot;
        item.itemId = stack.getItemId();
        item.amount = stack.getQuantity();
        double max = stack.getMaxDurability();
        if (max > 0) {
            item.durability = LiveFormat.round2(stack.getDurability());
            item.maxDurability = LiveFormat.round2(max);
        }
        if (stack.isUnbreakable()) item.unbreakable = true;
        if (stack.isBroken()) item.broken = true;
        return item;
    }

    /** Skin parts by slot name (bodyCharacteristic, haircut, ...); only the set ones. */
    private static Map<String, String> appearance(Store<EntityStore> store, Ref<EntityStore> ref) {
        PlayerSkinComponent component = store.getComponent(ref, PlayerSkinComponent.getComponentType());
        PlayerSkin skin = component == null ? null : component.getPlayerSkin();
        if (skin == null) return null;
        Map<String, String> parts = new LinkedHashMap<>();
        for (Field field : PlayerSkin.class.getFields()) {
            if (Modifier.isStatic(field.getModifiers()) || field.getType() != String.class) continue;
            try {
                Object value = field.get(skin);
                if (value instanceof String s && !s.isBlank()) parts.put(field.getName(), s);
            } catch (IllegalAccessException ignored) {
                // Public field; cannot happen.
            }
        }
        return parts;
    }

    static Ping ping(PacketHandler handler) {
        if (handler == null) return null;
        for (PongType type : PING_TYPES) {
            try {
                PacketHandler.PingInfo info = handler.getPingInfo(type);
                HistoricMetric metric = info == null ? null : info.getPingMetricSet();
                if (metric == null) continue;
                Long last = toMs(metric.getLastValue());
                if (last == null) continue;
                Ping ping = new Ping();
                ping.type = type.name();
                ping.lastMs = last;
                ping.avg1mMs = toMs((long) metric.getAverage(PacketHandler.PingInfo.ONE_MINUTE_INDEX));
                ping.min1mMs = toMs(metric.calculateMin(PacketHandler.PingInfo.ONE_MINUTE_INDEX));
                ping.max1mMs = toMs(metric.calculateMax(PacketHandler.PingInfo.ONE_MINUTE_INDEX));
                ping.avg5mMs = toMs((long) metric.getAverage(PacketHandler.PingInfo.FIVE_MINUTE_INDEX));
                return ping;
            } catch (Throwable ignored) {
                // Try the next pong type.
            }
        }
        return null;
    }

    /** Ping samples are stored in {@code PingInfo.TIME_UNIT}; clamp to a plausible range. */
    private static Long toMs(long raw) {
        if (raw <= 0) return null;
        long ms = PacketHandler.PingInfo.TIME_UNIT.toMillis(raw);
        return (ms < 0 || ms > 60_000L) ? null : ms;
    }

    private static Integer protocolCrc(PacketHandler handler) {
        try {
            ProtocolVersion version = handler == null ? null : handler.getProtocolVersion();
            return version == null ? null : version.getCrc();
        } catch (Throwable t) {
            return null;
        }
    }

    // Response classes (Gson omits null fields).

    public static class SessionInfo {
        public String uuid;
        public String name;
        public String world;
        public String joinedAt;
        public String language;
        public List<String> groups;
        public Ping ping;
        /** Protocol checksum the client connected with; the client build string is not kept by the server. */
        public Integer protocolCrc;
    }

    public static class LiveSnapshot extends SessionInfo {
        public String gamemode;
        public Map<String, Stat> stats;
        public Position position;
        public Double yaw;
        public Double pitch;
        public Map<String, String> appearance;
    }

    public static class Stat {
        public double value;
        public double max;
    }

    public static class Ping {
        public String type;
        public Long lastMs;
        public Long avg1mMs;
        public Long min1mMs;
        public Long max1mMs;
        public Long avg5mMs;
    }

    public static class Position {
        public final double x;
        public final double y;
        public final double z;

        Position(double x, double y, double z) {
            this.x = LiveFormat.round2(x);
            this.y = LiveFormat.round2(y);
            this.z = LiveFormat.round2(z);
        }
    }

    public static class InventorySnapshot {
        public String uuid;
        public String name;
        public String world;
        public Map<String, Section> sections;
        /** All items flattened, each tagged with its section (compatible with the old item list). */
        public List<InventoryItem> items;
        public int totalSlots;
        public int usedSlots;
    }

    public static class Section {
        public int capacity;
        public Integer activeSlot;
        public List<InventoryItem> items;
    }

    public static class InventoryItem {
        public String section;
        public int slot;
        public String itemId;
        public int amount;
        public Double durability;
        public Double maxDurability;
        public Boolean unbreakable;
        public Boolean broken;
    }
}
