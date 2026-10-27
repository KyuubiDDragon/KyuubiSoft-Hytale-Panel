package com.kyuubisoft.api.live;

import com.hypixel.hytale.component.ArchetypeChunk;
import com.hypixel.hytale.component.CommandBuffer;
import com.hypixel.hytale.component.Ref;
import com.hypixel.hytale.component.Store;
import com.hypixel.hytale.component.query.Query;
import com.hypixel.hytale.component.system.EntityEventSystem;
import com.hypixel.hytale.event.EventPriority;
import com.hypixel.hytale.event.EventRegistry;
import com.hypixel.hytale.protocol.GameMode;
import com.hypixel.hytale.server.core.HytaleServer;
import com.hypixel.hytale.server.core.Message;
import com.hypixel.hytale.server.core.ShutdownReason;
import com.hypixel.hytale.server.core.entity.entities.Player;
import com.hypixel.hytale.server.core.event.events.ShutdownEvent;
import com.hypixel.hytale.server.core.event.events.ecs.ChangeGameModeEvent;
import com.hypixel.hytale.server.core.event.events.permissions.GroupPermissionChangeEvent;
import com.hypixel.hytale.server.core.event.events.permissions.PlayerGroupEvent;
import com.hypixel.hytale.server.core.event.events.permissions.PlayerPermissionChangeEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerConnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerDisconnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerSetupConnectEvent;
import com.hypixel.hytale.server.core.modules.accesscontrol.AccessControlModule;
import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.universe.world.events.AddWorldEvent;
import com.hypixel.hytale.server.core.universe.world.events.RemoveWorldEvent;
import com.hypixel.hytale.server.core.universe.world.storage.EntityStore;

import java.util.Collection;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.logging.Logger;

/**
 * Turns server events into the WebSocket frames from {@link LiveEvents} and
 * keeps the session tracker current. Registered once during plugin setup
 * (the ECS system registry only accepts systems then).
 */
final class ServerEventsBridge {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    /** A refused join is reported at most once per name in this window. */
    static final long JOIN_DENIED_WINDOW_MS = 30_000;
    /** Names remembered at once; beyond that, further refusals in the window are not reported. */
    static final int MAX_JOIN_DENIED_NAMES = 4_096;

    private final Consumer<Object> sink;
    private final SessionTracker sessions;
    private final PerKeyCooldown joinDeniedLimiter = new PerKeyCooldown(JOIN_DENIED_WINDOW_MS, MAX_JOIN_DENIED_NAMES);

    ServerEventsBridge(Consumer<Object> sink, SessionTracker sessions) {
        this.sink = sink;
        this.sessions = sessions;
    }

    void register(JavaPlugin plugin) {
        EventRegistry events = plugin.getEventRegistry();

        events.register(PlayerConnectEvent.class, e -> sessions.onJoin(e.getPlayerRef().getUuid()));
        events.register(PlayerDisconnectEvent.class, e -> sessions.onLeave(e.getPlayerRef().getUuid()));

        // LAST: the access-control module (and other plugins) cancel earlier;
        // the server only acts on the flag after all handlers ran.
        events.register(EventPriority.LAST, PlayerSetupConnectEvent.class, this::onSetupConnect);

        // World events are keyed by world name, so they need the global registration.
        events.registerGlobal(EventPriority.LAST, AddWorldEvent.class, e -> {
            if (e.isCancelled()) return;
            emitWorld("world_added", e.getWorld(), null);
        });
        events.registerGlobal(EventPriority.LAST, RemoveWorldEvent.class, e -> {
            if (e.isCancelled()) return;
            emitWorld("world_removed", e.getWorld(),
                    e.getRemovalReason() == null ? null : e.getRemovalReason().name());
        });

        // FIRST: before players are disconnected and the plugins (this one
        // included) shut down, so the frame still reaches the panel.
        events.register(EventPriority.FIRST, ShutdownEvent.class, e -> onShutdown());

        registerPermissionEvents(events);

        try {
            plugin.getEntityStoreRegistry().registerSystem(new GameModeChangeSystem());
        } catch (Throwable t) {
            LOGGER.warning("[Data] Game mode events unavailable: " + t.getMessage());
        }
    }

    private void onSetupConnect(PlayerSetupConnectEvent event) {
        if (!event.isCancelled()) return;
        // Anyone can trigger this by connecting, under any name: report each
        // name at most once per window so a connection flood stays small.
        if (!joinDeniedLimiter.tryAcquire(event.getUsername(), System.currentTimeMillis())) return;
        try {
            LiveEvents.JoinDenied denied = new LiveEvents.JoinDenied();
            denied.player = event.getUsername();
            denied.uuid = LiveFormat.uuid(event.getUuid());
            Message reason = event.getReason();
            denied.reason = LiveFormat.text(reason);
            denied.reasonId = reason == null ? null : reason.getMessageId();
            denied.kind = denialKind(event.getUuid());
            emit(denied);
        } catch (Throwable t) {
            LOGGER.warning("[Data] Could not report denied join: " + t.getMessage());
        }
    }

    /** Classify by the access state; anything else was refused by a plugin. */
    private static String denialKind(UUID uuid) {
        try {
            AccessControlModule access = AccessControlModule.get();
            if (access == null || uuid == null) return "other";
            if (access.isBanned(uuid)) return "banned";
            if (access.isJoinPermissionRequired() && !access.isAllowedToJoin(uuid)) return "whitelist";
        } catch (Throwable ignored) {
            // Fall through: unknown cause.
        }
        return "other";
    }

    private void emitWorld(String type, World world, String reason) {
        // The frame identifies the world by name; without one there is nothing to report.
        if (world == null || world.getName() == null) return;
        LiveEvents.WorldChanged event = new LiveEvents.WorldChanged(type);
        event.world = world.getName();
        event.reason = reason;
        try {
            if (HytaleServer.get().isShuttingDown()) event.serverShuttingDown = true;
        } catch (Throwable ignored) {
            // No server instance: leave the flag unset.
        }
        emit(event);
    }

    private void onShutdown() {
        LiveEvents.ServerShutdown event = new LiveEvents.ServerShutdown();
        try {
            ShutdownReason reason = HytaleServer.get().getShutdownReason();
            if (reason != null) {
                event.reason = reason.getName();
                event.exitCode = reason.getExitCode();
                event.message = LiveFormat.clip(reason.getMessage());
            }
        } catch (Throwable ignored) {
            // Report the shutdown even when the reason is unreadable.
        }
        emit(event);
    }

    private void registerPermissionEvents(EventRegistry events) {
        events.register(PlayerGroupEvent.Added.class,
                e -> emitUser("group_added", e.getPlayerUuid(), e.getGroupName(), null));
        events.register(PlayerGroupEvent.Removed.class,
                e -> emitUser("group_removed", e.getPlayerUuid(), e.getGroupName(), null));
        events.register(PlayerPermissionChangeEvent.GroupAdded.class,
                e -> emitUser("group_added", e.getPlayerUuid(), e.getGroupName(), null));
        events.register(PlayerPermissionChangeEvent.GroupRemoved.class,
                e -> emitUser("group_removed", e.getPlayerUuid(), e.getGroupName(), null));
        events.register(PlayerPermissionChangeEvent.PermissionsAdded.class,
                e -> emitUser("permissions_added", e.getPlayerUuid(), null, e.getAddedPermissions()));
        events.register(PlayerPermissionChangeEvent.PermissionsRemoved.class,
                e -> emitUser("permissions_removed", e.getPlayerUuid(), null, e.getRemovedPermissions()));
        events.register(GroupPermissionChangeEvent.Added.class,
                e -> emitGroup("permissions_added", e.getGroupName(), e.getAddedPermissions()));
        events.register(GroupPermissionChangeEvent.Removed.class,
                e -> emitGroup("permissions_removed", e.getGroupName(), e.getRemovedPermissions()));
    }

    private void emitUser(String action, UUID uuid, String group, Collection<String> permissions) {
        LiveEvents.PermissionChanged event = new LiveEvents.PermissionChanged();
        event.scope = "user";
        event.action = action;
        event.uuid = LiveFormat.uuid(uuid);
        event.player = LiveFormat.onlineName(uuid);
        event.group = group;
        event.permissions = permissions == null ? null : LiveFormat.sorted(permissions);
        emit(event);
    }

    private void emitGroup(String action, String group, Collection<String> permissions) {
        LiveEvents.PermissionChanged event = new LiveEvents.PermissionChanged();
        event.scope = "group";
        event.action = action;
        event.group = group;
        event.permissions = permissions == null ? null : LiveFormat.sorted(permissions);
        emit(event);
    }

    private void emit(Object event) {
        try {
            sink.accept(event);
        } catch (Throwable t) {
            LOGGER.warning("[Data] Event broadcast failed: " + t.getMessage());
        }
    }

    /**
     * Reports game mode changes. The event fires before the change is applied
     * and can still be cancelled by a later handler, so the new mode is
     * confirmed on the next world-thread slot before anything is sent.
     */
    private final class GameModeChangeSystem extends EntityEventSystem<EntityStore, ChangeGameModeEvent> {

        GameModeChangeSystem() {
            super(ChangeGameModeEvent.class);
        }

        @Override
        public Query<EntityStore> getQuery() {
            return PlayerRef.getComponentType();
        }

        @Override
        public void handle(int index, ArchetypeChunk<EntityStore> chunk, Store<EntityStore> store,
                           CommandBuffer<EntityStore> buffer, ChangeGameModeEvent event) {
            PlayerRef player = chunk.getComponent(index, PlayerRef.getComponentType());
            Player entity = chunk.getComponent(index, Player.getComponentType());
            if (player == null || entity == null) return;
            GameMode from = entity.getGameMode();
            if (from == event.getGameMode()) return;
            Ref<EntityStore> ref = chunk.getReferenceTo(index);
            World world = store.getExternalData().getWorld();
            world.execute(() -> {
                if (ref == null || !ref.isValid()) return;
                Player now = ref.getStore().getComponent(ref, Player.getComponentType());
                if (now == null || now.getGameMode() == from) return;
                LiveEvents.GameModeChanged changed = new LiveEvents.GameModeChanged();
                changed.player = player.getUsername();
                changed.uuid = LiveFormat.uuid(player.getUuid());
                changed.world = world.getName();
                changed.from = LiveFormat.lower(from);
                changed.to = LiveFormat.lower(now.getGameMode());
                emit(changed);
            });
        }
    }
}
