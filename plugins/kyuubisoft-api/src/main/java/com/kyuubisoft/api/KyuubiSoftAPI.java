package com.kyuubisoft.api;

import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.hypixel.hytale.server.core.plugin.JavaPluginInit;
import com.hypixel.hytale.server.core.event.events.player.PlayerConnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerDisconnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerChatEvent;
import com.hypixel.hytale.event.EventRegistry;
import com.kyuubisoft.api.handlers.MetricsHandler;
import com.kyuubisoft.api.metrics.PrometheusMetrics;
import com.kyuubisoft.api.metrics.TpsTracker;
import com.kyuubisoft.api.web.WebServer;
import com.kyuubisoft.api.websocket.EventBroadcaster;
import com.kyuubisoft.api.websocket.PositionTicker;
import com.kyuubisoft.api.config.ApiConfig;

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

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static KyuubiSoftAPI instance;

    private WebServer webServer;
    private EventBroadcaster eventBroadcaster;
    private ApiConfig config;
    private TpsTracker tpsTracker;
    private PrometheusMetrics prometheusMetrics;
    private PositionTicker positionTicker;

    public KyuubiSoftAPI(JavaPluginInit init) {
        super(init);
        instance = this;
    }

    public static KyuubiSoftAPI getInstance() {
        return instance;
    }

    @Override
    protected void setup() {
        LOGGER.info("╔════════════════════════════════════════╗");
        LOGGER.info("║       KyuubiSoft API v1.4.0            ║");
        LOGGER.info("║       by KyuubiDDragon                 ║");
        LOGGER.info("║       + Prometheus Metrics Support     ║");
        LOGGER.info("╚════════════════════════════════════════╝");

        // Load configuration
        config = new ApiConfig(this);
        config.load();

        // Initialize TPS Tracker
        tpsTracker = new TpsTracker();
        tpsTracker.start();
        LOGGER.info("TPS Tracker initialized");

        // Initialize Prometheus Metrics
        prometheusMetrics = new PrometheusMetrics(tpsTracker);
        LOGGER.info("Prometheus Metrics initialized");

        // Initialize event broadcaster for WebSocket
        eventBroadcaster = new EventBroadcaster();

        // Start HTTP/WebSocket server
        int port = config.getHttpPort();
        webServer = new WebServer(port, eventBroadcaster);
        webServer.setApiConfig(config);

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
            LOGGER.info("  GET  http://localhost:" + port + "/metrics (Prometheus)");
            LOGGER.info("  WS   ws://localhost:" + port + "/ws");
        } catch (Exception e) {
            LOGGER.severe("Failed to start API server: " + e.getMessage());
            e.printStackTrace();
        }

        // Register event listeners
        registerEvents();

        // Start periodic player_position broadcast for the panel's live-map and
        // replay recorder. Disabled if positionBroadcastIntervalMs <= 0.
        try {
            positionTicker = new PositionTicker(eventBroadcaster, config.getPositionBroadcastIntervalMs());
            positionTicker.start();
        } catch (Exception e) {
            LOGGER.warning("Failed to start PositionTicker: " + e.getMessage());
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

        // Player chat event - use registerGlobal for global chat listener
        // Based on Serilum's Chat-History plugin implementation
        try {
            eventRegistry.registerGlobal(PlayerChatEvent.class, event -> {
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
        }

        if (tpsTracker != null) {
            tpsTracker.shutdown();
        }

        if (webServer != null) {
            webServer.stop();
        }

        LOGGER.info("KyuubiSoft API stopped.");
    }

    public ApiConfig getApiConfig() {
        return config;
    }

    public EventBroadcaster getEventBroadcaster() {
        return eventBroadcaster;
    }
}
