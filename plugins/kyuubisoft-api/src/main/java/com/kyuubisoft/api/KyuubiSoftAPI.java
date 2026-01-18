package com.kyuubisoft.api;

import com.hypixel.hytale.server.core.plugin.JavaPlugin;
import com.hypixel.hytale.server.core.plugin.JavaPluginInit;
import com.hypixel.hytale.server.core.event.events.player.PlayerConnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerDisconnectEvent;
import com.hypixel.hytale.server.core.event.events.player.PlayerChatEvent;
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

        // Player chat event (async event with String key - using empty string for global listener)
        eventRegistry.register(PlayerChatEvent.class, "", event -> {
            try {
                // Get sender info - may need to extract from StringParamValue
                var sender = event.getSender();
                String playerName;
                if (sender != null) {
                    var username = sender.getUsername();
                    // Handle StringParamValue - try getValue() or toString()
                    if (username != null) {
                        playerName = username.toString();
                        // Remove class name prefix if present (e.g., "StringParamValue@...")
                        if (playerName.contains("@")) {
                            try {
                                // Try reflection to get actual value
                                var method = username.getClass().getMethod("getValue");
                                playerName = (String) method.invoke(username);
                            } catch (Exception e) {
                                // Try getString method
                                try {
                                    var method = username.getClass().getMethod("getString");
                                    playerName = (String) method.invoke(username);
                                } catch (Exception e2) {
                                    playerName = "Unknown";
                                }
                            }
                        }
                    } else {
                        playerName = "Unknown";
                    }
                } else {
                    playerName = "Unknown";
                }

                // Get message content - may also be StringParamValue
                var content = event.getContent();
                String message;
                if (content != null) {
                    message = content.toString();
                    // Handle StringParamValue
                    if (message.contains("@")) {
                        try {
                            var method = content.getClass().getMethod("getValue");
                            message = (String) method.invoke(content);
                        } catch (Exception e) {
                            try {
                                var method = content.getClass().getMethod("getString");
                                message = (String) method.invoke(content);
                            } catch (Exception e2) {
                                message = "[Unable to read message]";
                            }
                        }
                    }
                } else {
                    message = "";
                }

                LOGGER.info("[Chat] " + playerName + ": " + message);
                eventBroadcaster.broadcastChat(playerName, message);
            } catch (Exception e) {
                LOGGER.warning("[Chat] Error processing chat event: " + e.getMessage());
                e.printStackTrace();
            }
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
