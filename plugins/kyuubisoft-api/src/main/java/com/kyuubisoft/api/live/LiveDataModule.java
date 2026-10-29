package com.kyuubisoft.api.live;

import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.kyuubisoft.api.web.ApiException;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.logging.Logger;

/**
 * Live-data part of the API: server status, plugin state, access, permissions,
 * sessions and world-thread player reads, plus the matching WebSocket events.
 *
 * <p>Lifecycle: {@link #install} in the plugin's setup (registers events and
 * the ECS system), {@link #start} once the server runs (state watcher),
 * {@link #shutdown} on plugin shutdown.</p>
 */
public final class LiveDataModule {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final long PLUGIN_POLL_SECONDS = 5;
    private static final int WORKER_THREADS = 2;
    private static final int MAX_QUEUED_READS = 32;

    private static volatile LiveDataModule instance;

    private final SessionTracker sessions = new SessionTracker();
    private final ServerStatusCollector status = new ServerStatusCollector();
    private final PluginStatusCollector plugins = new PluginStatusCollector();
    private final AccessCollector access = new AccessCollector();
    private final PermissionsCollector permissions = new PermissionsCollector();
    private final PlayerLiveReader players = new PlayerLiveReader(sessions);
    private final Consumer<Object> sink;
    // Module calls can touch the disk (staged update, ban file); keep them off Netty.
    // Bounded, so slow reads cannot let requests pile up: beyond that, 503.
    private final ExecutorService workers = new ThreadPoolExecutor(WORKER_THREADS, WORKER_THREADS,
            0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(MAX_QUEUED_READS), daemon("KyuubiSoft-Live"));
    private ScheduledExecutorService scheduler;

    private LiveDataModule(Consumer<Object> sink) {
        this.sink = sink;
    }

    /**
     * Create the module and register its listeners. {@code sink} receives the
     * event frames (e.g. the WebSocket broadcaster).
     */
    public static LiveDataModule install(JavaPlugin plugin, Consumer<Object> sink) {
        LiveDataModule module = new LiveDataModule(sink);
        new ServerEventsBridge(sink, module.sessions).register(plugin);
        instance = module;
        return module;
    }

    /** The installed module, or null before setup / after shutdown. */
    public static LiveDataModule get() {
        return instance;
    }

    public void start() {
        if (scheduler != null) return;
        scheduler = Executors.newSingleThreadScheduledExecutor(daemon("KyuubiSoft-LiveWatch"));
        scheduler.scheduleWithFixedDelay(new PluginStateWatcher(plugins, sink),
                0, PLUGIN_POLL_SECONDS, TimeUnit.SECONDS);
    }

    public void shutdown() {
        if (scheduler != null) scheduler.shutdownNow();
        workers.shutdownNow();
        if (instance == this) instance = null;
        LOGGER.fine("[Data] Live-data module stopped");
    }

    /** Run a module read on the live-data workers. */
    <T> CompletableFuture<T> supply(Supplier<T> task) {
        try {
            return CompletableFuture.supplyAsync(task, workers);
        } catch (RejectedExecutionException busy) {
            return CompletableFuture.failedFuture(new ApiException(503, "Live data is busy, try again shortly"));
        }
    }

    ServerStatusCollector status() {
        return status;
    }

    PluginStatusCollector plugins() {
        return plugins;
    }

    AccessCollector access() {
        return access;
    }

    PermissionsCollector permissions() {
        return permissions;
    }

    PlayerLiveReader players() {
        return players;
    }

    private static ThreadFactory daemon(String name) {
        AtomicInteger counter = new AtomicInteger();
        return runnable -> {
            Thread thread = new Thread(runnable, name + "-" + counter.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }
}
