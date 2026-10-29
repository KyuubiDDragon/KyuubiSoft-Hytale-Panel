package com.kyuubisoft.api;

import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.hypixel.hytale.server.core.plugin.JavaPluginInit;
import com.hypixel.hytale.server.core.event.events.player.PlayerConnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerDisconnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerChatEvent;
import com.hypixel.hytale.event.EventPriority;
import com.hypixel.hytale.event.EventRegistry;
import com.kyuubisoft.api.commands.CommandService;
import com.kyuubisoft.api.handlers.MetricsHandler;
import com.kyuubisoft.api.live.LiveDataModule;
import com.kyuubisoft.api.metrics.CpuSampler;
import com.kyuubisoft.api.metrics.PrometheusMetrics;
import com.kyuubisoft.api.panel.internal.PanelRuntime;
import com.kyuubisoft.api.web.WebServer;
import com.kyuubisoft.api.websocket.EventBroadcaster;
import com.kyuubisoft.api.websocket.PlayerDeathSystem;
import com.kyuubisoft.api.websocket.PositionTicker;
import com.kyuubisoft.api.websocket.TpsTicker;
import com.kyuubisoft.api.config.ApiConfig;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * KyuubiSoft API Plugin
 *
 * Provides a REST API and WebSocket for the KyuubiSoft Panel to access
 * accurate player data, server statistics, and real-time events.
 *
 * @author KyuubiDDragon
 */
public class KyuubiSoftAPI extends JavaPlugin {

    /** Keep in sync with manifest.json, build.gradle and the panel's PLUGIN_VERSION. */
    public static final String PLUGIN_VERSION = "2.1.0";

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    /** Threads for blocking HTTP work (command dispatch), so Netty threads never wait. */
    private static final int WORKER_THREADS = 4;
    // Set in setup(), cleared in shutdown(): a reloaded plugin never sees the
    // previous instance through it.
    private static volatile KyuubiSoftAPI instance;

    private WebServer webServer;
    private EventBroadcaster eventBroadcaster;
    private ApiConfig config;
    private PrometheusMetrics prometheusMetrics;
    private PositionTicker positionTicker;
    private TpsTicker tpsTicker;
    private ExecutorService workers;
    private CommandService commandService;
    private LiveDataModule liveData;

    public KyuubiSoftAPI(JavaPluginInit init) {
        super(init);
    }

    /** The running plugin; null before setup and after shutdown. */
    public static KyuubiSoftAPI getInstance() {
        return instance;
    }

    /**
     * Setup: configuration, event listeners and ECS systems. Nothing that
     * opens a port or starts a thread happens here; that is {@link #start()}.
     */
    @Override
    protected void setup() {
        LOGGER.info("╔════════════════════════════════════════╗");
        LOGGER.info("║       KyuubiSoft API v" + PLUGIN_VERSION + "            ║");
        LOGGER.info("║       by KyuubiDDragon                 ║");
        LOGGER.info("║       + Prometheus Metrics Support     ║");
        LOGGER.info("╚════════════════════════════════════════╝");
        instance = this;

        // Load configuration from the plugin's data directory (moves a
        // config from the pre-2.1 location there).
        config = new ApiConfig(getDataDirectory());
        config.load();

        // Initialize Prometheus Metrics
        prometheusMetrics = new PrometheusMetrics();

        // Initialize event broadcaster for WebSocket
        eventBroadcaster = new EventBroadcaster();

        // Register event listeners
        registerEvents();

        // player_death with cause and killer, reported by an ECS death system.
        try {
            getEntityStoreRegistry().registerSystem(new PlayerDeathSystem(eventBroadcaster));
        } catch (Exception e) {
            LOGGER.warning("Could not register the player death system, player_death is off: " + e.getMessage());
        }

        // Live data (/api/server/status, /api/plugins, /api/access/*, /api/permissions/*,
        // /api/sessions, player live/inventory) and its events; registers an ECS system.
        liveData = LiveDataModule.install(this, eventBroadcaster::broadcastEvent);
    }

    /** Start: open the API port and start the periodic broadcasts. */
    @Override
    protected void start() {
        workers = Executors.newFixedThreadPool(WORKER_THREADS, new ThreadFactory() {
            private final AtomicInteger next = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "KyuubiSoft-Worker-" + next.getAndIncrement());
                t.setDaemon(true);
                return t;
            }
        });

        // CPU load is read in the background; the MXBean call can block.
        CpuSampler.start();

        // Commands with captured output, command registry and completion (/api/commands)
        commandService = new CommandService();
        commandService.start(eventBroadcaster);

        // Workers for the mod panel registry (/api/mods/panel, mod_event); see panel.PanelRegistry
        PanelRuntime.start(eventBroadcaster);

        // Start HTTP/WebSocket server
        int port = config.getHttpPort();
        config.logSecurityPosture(port);
        webServer = new WebServer(port, eventBroadcaster);
        webServer.setApiConfig(config);
        webServer.setWorkers(workers);

        // Set up metrics handler
        MetricsHandler metricsHandler = new MetricsHandler(prometheusMetrics);
        webServer.setMetricsHandler(metricsHandler);

        try {
            webServer.start();
            LOGGER.info("API server started on port " + port);
            LOGGER.info("Endpoints:");
            LOGGER.info("  GET  http://localhost:" + port + "/api/players");
            LOGGER.info("  GET  http://localhost:" + port + "/api/worlds");
            LOGGER.info("  GET  http://localhost:" + port + "/api/server/info");
            LOGGER.info("  GET  http://localhost:" + port + "/api/server/tps");
            LOGGER.info("  GET  http://localhost:" + port + "/metrics (Prometheus)");
            LOGGER.info("  WS   ws://localhost:" + port + "/ws");
        } catch (Exception e) {
            LOGGER.log(Level.SEVERE, "Failed to start API server on port " + port, e);
        }

        // Start periodic player_position broadcast for the panel's live-map and
        // replay recorder. Disabled if positionBroadcastIntervalMs <= 0.
        try {
            positionTicker = new PositionTicker(eventBroadcaster, config.getPositionBroadcastIntervalMs());
            positionTicker.start();
        } catch (Exception e) {
            LOGGER.warning("Failed to start PositionTicker: " + e.getMessage());
        }

        // Per-world tps_update for the panel's TPS alarm and history.
        // Disabled if tpsBroadcastIntervalMs <= 0.
        try {
            tpsTicker = new TpsTicker(eventBroadcaster, config.getTpsBroadcastIntervalMs());
            tpsTicker.start();
        } catch (Exception e) {
            LOGGER.warning("Failed to start TpsTicker: " + e.getMessage());
        }

        // plugin_state: polls the plugin manager for load-state changes.
        if (liveData != null) {
            liveData.start();
        }
    }

    private void registerEvents() {
        EventRegistry eventRegistry = getEventRegistry();

        // Player connect event
        eventRegistry.register(PlayerConnectEvent.class, event -> {
            String playerName = event.getPlayerRef().getUsername();
            String uuid = event.getPlayerRef().getUuid().toString();
            // Debug: LOGGER.fine("Player connected: " + playerName);
            eventBroadcaster.broadcastPlayerJoin(playerName, uuid);
            // Update Prometheus metrics
            if (prometheusMetrics != null) {
                prometheusMetrics.incrementPlayerJoins();
            }
        });

        // Player disconnect event
        eventRegistry.register(PlayerDisconnectEvent.class, event -> {
            String playerName = event.getPlayerRef().getUsername();
            String uuid = event.getPlayerRef().getUuid().toString();
            // Debug: LOGGER.fine("Player disconnected: " + playerName);
            eventBroadcaster.broadcastPlayerLeave(playerName, uuid);
            // Update Prometheus metrics
            if (prometheusMetrics != null) {
                prometheusMetrics.incrementPlayerLeaves();
            }
        });

        // Player chat event - use registerGlobal for global chat listener.
        // LAST priority: chat filters and mutes of other mods run first, and a
        // message they cancelled is never forwarded to the panel (chat log,
        // auto-mod, Discord bridge). The server itself only drops cancelled
        // messages after all handlers ran.
        try {
            eventRegistry.registerGlobal(EventPriority.LAST, PlayerChatEvent.class, event -> {
                if (event.isCancelled()) return;
                try {
                    var sender = event.getSender();
                    String playerName = sender != null ? sender.getUsername() : "Unknown";
                    String uuid = sender != null ? sender.getUuid().toString() : "";
                    // PlayerChatEvent.getContent() is a plain String on this API —
                    // use it directly instead of the old toString/reflection probe.
                    String message = event.getContent();
                    if (message == null) message = "";

                    eventBroadcaster.broadcastChat(playerName, uuid, message);
                } catch (Exception e) {
                    LOGGER.warning("[Chat] Error processing chat event: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            LOGGER.warning("Could not register PlayerChatEvent: " + e.getMessage());
        }
    }

    @Override
    protected void shutdown() {
        LOGGER.info("Shutting down KyuubiSoft API...");

        if (positionTicker != null) {
            positionTicker.shutdown();
            positionTicker = null;
        }

        if (tpsTicker != null) {
            tpsTicker.shutdown();
            tpsTicker = null;
        }

        if (commandService != null) {
            commandService.shutdown();
        }

        PanelRuntime.stop();

        if (liveData != null) {
            liveData.shutdown();
            liveData = null;
        }

        // Stop accepting requests first, then drop the workers' queued work.
        if (webServer != null) {
            webServer.stop();
            webServer = null;
        }

        if (workers != null) {
            workers.shutdownNow();
            workers = null;
        }

        CpuSampler.stop();

        if (instance == this) {
            instance = null;
        }

        LOGGER.info("KyuubiSoft API stopped.");
    }

    public ApiConfig getApiConfig() {
        return config;
    }

    public EventBroadcaster getEventBroadcaster() {
        return eventBroadcaster;
    }

    /** Command execution, registry and completion behind /api/commands; null before setup. */
    public CommandService getCommandService() {
        return commandService;
    }
}
