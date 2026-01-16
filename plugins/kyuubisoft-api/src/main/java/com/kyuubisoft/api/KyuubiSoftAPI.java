package com.kyuubisoft.api;

import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.hypixel.hytale.server.core.plugin.JavaPluginInit;
import com.hypixel.hytale.server.core.event.events.player.PlayerConnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerDisconnectEvent;
import com.hypixel.hytale.event.EventRegistry;
import com.kyuubisoft.api.web.WebServer;
import com.kyuubisoft.api.websocket.EventBroadcaster;
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
        LOGGER.info("║       KyuubiSoft API v1.0.0            ║");
        LOGGER.info("║       by KyuubiDDragon                 ║");
        LOGGER.info("╚════════════════════════════════════════╝");

        // Load configuration
        config = new ApiConfig(this);
        config.load();

        // Initialize event broadcaster for WebSocket
        eventBroadcaster = new EventBroadcaster();

        // Start HTTP/WebSocket server
        int port = config.getHttpPort();
        webServer = new WebServer(port, eventBroadcaster);

        try {
            webServer.start();
            LOGGER.info("API server started on port " + port);
            LOGGER.info("Endpoints:");
            LOGGER.info("  GET  http://localhost:" + port + "/api/players");
            LOGGER.info("  GET  http://localhost:" + port + "/api/worlds");
            LOGGER.info("  GET  http://localhost:" + port + "/api/server/info");
            LOGGER.info("  WS   ws://localhost:" + port + "/ws");
        } catch (Exception e) {
            LOGGER.severe("Failed to start API server: " + e.getMessage());
            e.printStackTrace();
        }

        // Register event listeners
        registerEvents();
    }

    private void registerEvents() {
        EventRegistry eventRegistry = getEventRegistry();

        // Player connect event
        eventRegistry.register(PlayerConnectEvent.class, event -> {
            String playerName = event.getPlayerRef().getUsername();
            String uuid = event.getPlayerRef().getUuid().toString();
            LOGGER.info("Player connected: " + playerName);
            eventBroadcaster.broadcastPlayerJoin(playerName, uuid);
        });

        // Player disconnect event
        eventRegistry.register(PlayerDisconnectEvent.class, event -> {
            String playerName = event.getPlayerRef().getUsername();
            String uuid = event.getPlayerRef().getUuid().toString();
            LOGGER.info("Player disconnected: " + playerName);
            eventBroadcaster.broadcastPlayerLeave(playerName, uuid);
        });
    }

    @Override
    protected void shutdown() {
        LOGGER.info("Shutting down KyuubiSoft API...");

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
