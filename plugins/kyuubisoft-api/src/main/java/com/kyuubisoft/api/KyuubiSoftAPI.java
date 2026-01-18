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
        LOGGER.info("║       KyuubiSoft API v1.1.6            ║");
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

        // Player chat event - use registerGlobal for global chat listener
        // Based on Serilum's Chat-History plugin implementation
        try {
            eventRegistry.registerGlobal(PlayerChatEvent.class, event -> {
                try {
                    String playerName = "Unknown";
                    String uuid = "";
                    String message = "";

                    // Get sender info
                    var sender = event.getSender();
                    if (sender != null) {
                        playerName = sender.getUsername();
                        uuid = sender.getUuid().toString();
                    }

                    // Get message content
                    Object content = event.getContent();
                    if (content != null) {
                        message = extractStringFromParamValue(content);
                    }

                    eventBroadcaster.broadcastChat(playerName, uuid, message);
                } catch (Exception e) {
                    LOGGER.warning("[Chat] Error processing chat event: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            LOGGER.warning("Could not register PlayerChatEvent: " + e.getMessage());
        }
    }

    /**
     * Extract string value from StringParamValue or similar wrapper objects.
     * Tries multiple methods via reflection to get the actual string.
     */
    private String extractStringFromParamValue(Object obj) {
        if (obj == null) return "";

        // If it's already a string, return it
        if (obj instanceof String) return (String) obj;

        String strVal = obj.toString();

        // If toString() returns a clean value (no @ sign), use it
        if (!strVal.contains("@") && !strVal.contains("StringParamValue")) {
            return strVal;
        }

        // Try various getter methods via reflection
        String[] methodNames = {"getValue", "getString", "get", "value", "getStringValue", "getContent", "getText"};

        for (String methodName : methodNames) {
            try {
                var method = obj.getClass().getMethod(methodName);
                Object result = method.invoke(obj);
                if (result != null) {
                    if (result instanceof String) {
                        return (String) result;
                    }
                    String resultStr = result.toString();
                    if (!resultStr.contains("@")) {
                        return resultStr;
                    }
                }
            } catch (Exception ignored) {
                // Method doesn't exist or failed, try next
            }
        }

        // Try to access 'value' field directly
        try {
            var field = obj.getClass().getDeclaredField("value");
            field.setAccessible(true);
            Object value = field.get(obj);
            if (value != null) {
                return value.toString();
            }
        } catch (Exception ignored) {
            // Field doesn't exist or not accessible
        }

        // Return raw toString as fallback
        return strVal.contains("@") ? "" : strVal;
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
