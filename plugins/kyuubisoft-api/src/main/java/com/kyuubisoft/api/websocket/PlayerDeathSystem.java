package com.kyuubisoft.api.websocket;

import com.hypixel.hytale.component.CommandBuffer;
import com.hypixel.hytale.component.Ref;
import com.hypixel.hytale.component.Store;
import com.hypixel.hytale.component.query.Query;
import com.hypixel.hytale.server.core.Message;
import com.hypixel.hytale.server.core.modules.entity.component.DisplayNameComponent;
import com.hypixel.hytale.server.core.modules.entity.component.TransformComponent;
import com.hypixel.hytale.server.core.modules.entity.damage.Damage;
import com.hypixel.hytale.server.core.modules.entity.damage.DamageCause;
import com.hypixel.hytale.server.core.modules.entity.damage.DeathComponent;
import com.hypixel.hytale.server.core.modules.entity.damage.DeathSystems;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.universe.world.storage.EntityStore;
import org.joml.Vector3d;

import java.util.logging.Logger;

/**
 * Sends {@code player_death} when a player dies: cause, killer and where it
 * happened.
 *
 * <p>An ECS death system: the server adds a {@link DeathComponent} to an
 * entity when it dies, and this system is told on the world thread, so the
 * store can be read directly. Registered in the plugin's setup through the
 * plugin's entity store registry, which removes it again when the plugin
 * shuts down.</p>
 */
public class PlayerDeathSystem extends DeathSystems.OnDeathSystem {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    private final EventBroadcaster broadcaster;

    public PlayerDeathSystem(EventBroadcaster broadcaster) {
        this.broadcaster = broadcaster;
    }

    @Override
    public Query<EntityStore> getQuery() {
        // Players only: every connected player entity carries a PlayerRef.
        return PlayerRef.getComponentType();
    }

    @Override
    public void onComponentAdded(Ref<EntityStore> ref, DeathComponent death, Store<EntityStore> store,
                                 CommandBuffer<EntityStore> commandBuffer) {
        if (!broadcaster.hasClients()) return;
        try {
            PlayerRef victim = store.getComponent(ref, PlayerRef.getComponentType());
            if (victim == null) return;

            EventBroadcaster.PlayerDeathEvent event = new EventBroadcaster.PlayerDeathEvent();
            event.player = victim.getUsername();
            event.uuid = victim.getUuid().toString();
            event.cause = causeId(death.getDeathCause());

            World world = store.getExternalData().getWorld();
            if (world != null) event.world = world.getName();

            TransformComponent transform = store.getComponent(ref, TransformComponent.getComponentType());
            Vector3d pos = transform != null ? transform.getPosition() : null;
            if (pos != null) {
                event.x = round2(pos.x());
                event.y = round2(pos.y());
                event.z = round2(pos.z());
            }

            describeKiller(event, death.getDeathInfo(), store);
            broadcaster.broadcastPlayerDeath(event);
        } catch (Throwable t) {
            // A broken event must never disturb the server's death handling.
            LOGGER.warning("Could not report a player death: " + t.getMessage());
        }
    }

    private static void describeKiller(EventBroadcaster.PlayerDeathEvent event, Damage damage, Store<EntityStore> store) {
        if (damage == null) return;
        Damage.Source source = damage.getSource();
        if (source instanceof Damage.EntitySource entitySource) {
            // Covers melee, projectiles (the shooter) and effects of an entity.
            event.killerType = "entity";
            Ref<EntityStore> killerRef = entitySource.getRef();
            // A killer from another store (it left the world) cannot be read here.
            if (killerRef == null || !killerRef.isValid() || killerRef.getStore() != store) return;
            PlayerRef killer = store.getComponent(killerRef, PlayerRef.getComponentType());
            if (killer != null) {
                event.killerType = "player";
                event.killer = killer.getUsername();
                event.killerUuid = killer.getUuid().toString();
                return;
            }
            DisplayNameComponent name = store.getComponent(killerRef, DisplayNameComponent.getComponentType());
            event.killer = name != null ? plainText(name.getDisplayName()) : null;
        } else if (source instanceof Damage.EnvironmentSource) {
            event.killerType = "environment";
        } else if (source instanceof Damage.CommandSource) {
            event.killerType = "command";
        }
    }

    private static String causeId(DamageCause cause) {
        String id = cause != null ? cause.getId() : null;
        return id != null && !id.isBlank() ? id : "unknown";
    }

    /** Literal text of a message, or its translation key when it has none. */
    private static String plainText(Message message) {
        if (message == null) return null;
        String raw = message.getRawText();
        if (raw != null && !raw.isBlank()) return raw;
        String key = message.getMessageId();
        return key != null && !key.isBlank() ? key : null;
    }

    private static double round2(double value) {
        return Math.round(value * 100.0) / 100.0;
    }
}
