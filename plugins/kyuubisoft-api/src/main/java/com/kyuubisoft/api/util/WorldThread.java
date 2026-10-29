package com.kyuubisoft.api.util;

import com.hypixel.hytale.component.Ref;
import com.hypixel.hytale.component.Store;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.universe.world.World;
import com.hypixel.hytale.server.core.universe.world.storage.EntityStore;
import com.kyuubisoft.api.web.ApiException;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Runs work on a world's own thread without blocking the caller.
 *
 * <p>Components and stores may only be read on the thread of the world that
 * owns them. The HTTP layer runs on Netty threads, so every store access goes
 * through here: the task is queued with {@link World#execute(Runnable)} and the
 * returned future completes on the world thread. A world that does not answer
 * within the timeout fails the future with a {@link java.util.concurrent.TimeoutException}
 * (HTTP 504) instead of hanging the request.</p>
 */
public final class WorldThread {

    /** How long a request waits for a world thread before giving up. */
    public static final long DEFAULT_TIMEOUT_MS = 2000;

    /** Work that needs a player's entity: called on the player's world thread. */
    @FunctionalInterface
    public interface PlayerTask<T> {
        T apply(Ref<EntityStore> ref, Store<EntityStore> store, World world);
    }

    private WorldThread() {
    }

    public static <T> CompletableFuture<T> supply(World world, Supplier<T> task) {
        return supply(world, task, DEFAULT_TIMEOUT_MS);
    }

    public static <T> CompletableFuture<T> supply(World world, Supplier<T> task, long timeoutMs) {
        if (world == null) {
            return CompletableFuture.failedFuture(new ApiException(404, "World not found"));
        }
        if (world.isInThread()) {
            try {
                return CompletableFuture.completedFuture(task.get());
            } catch (Throwable t) {
                return CompletableFuture.failedFuture(t);
            }
        }

        CompletableFuture<T> future = new CompletableFuture<>();
        try {
            world.execute(() -> {
                // Timed out while queued: the caller has its answer already.
                if (future.isDone()) return;
                try {
                    future.complete(task.get());
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            });
        } catch (RuntimeException notAccepting) {
            // The world is starting or shutting down and refuses new tasks.
            return CompletableFuture.failedFuture(new ApiException(503, "World is not accepting tasks"));
        }
        return future.orTimeout(timeoutMs, TimeUnit.MILLISECONDS);
    }

    /**
     * Run {@code task} with the player's entity on the player's world thread.
     * Fails with 404 when the player is not in a world (joining, leaving, or
     * between worlds).
     */
    public static <T> CompletableFuture<T> supplyForPlayer(PlayerRef player, PlayerTask<T> task) {
        World world = worldOf(player);
        if (world == null) {
            return CompletableFuture.failedFuture(new ApiException(404, "Player is not in a world"));
        }
        return supply(world, () -> {
            Ref<EntityStore> ref = player.getReference();
            if (ref == null || !ref.isValid()) {
                throw new ApiException(404, "Player is not in a world");
            }
            Store<EntityStore> store = ref.getStore();
            // The player switched worlds after we picked the thread: this store
            // belongs to another world thread now.
            if (store != world.getEntityStore().getStore()) {
                throw new ApiException(409, "Player is changing worlds, try again");
            }
            return task.apply(ref, store, world);
        });
    }

    /** The world the player is currently in, or null. Safe from any thread. */
    public static World worldOf(PlayerRef player) {
        if (player == null) return null;
        UUID worldUuid = player.getWorldUuid();
        if (worldUuid == null) return null;
        Universe universe = Universe.get();
        return universe == null ? null : universe.getWorld(worldUuid);
    }
}
