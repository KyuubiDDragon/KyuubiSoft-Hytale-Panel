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

        // Player chat event - keyed event, requires a channel key
        // Try different channel keys: empty string, "global", "server", "default"
        String[] chatChannels = {"", "global", "server", "default", "chat"};
        for (String channel : chatChannels) {
            final String channelKey = channel;
            LOGGER.info("[KyuubiSoft] Registering chat event handler for channel: '" + channelKey + "'");
            eventRegistry.register(PlayerChatEvent.class, channel, event -> {
                try {
                    LOGGER.info("[KyuubiSoft Chat Handler] Chat event received on channel: '" + channelKey + "'");
                    LOGGER.info("[KyuubiSoft Chat Handler] Event class: " + event.getClass().getName());

                    String playerName = "Unknown";
                    String message = "";

                    // Log all available methods for debugging (only on first event)
                    LOGGER.info("[Debug] PlayerChatEvent methods:");
                    for (var m : event.getClass().getMethods()) {
                        if (m.getParameterCount() == 0 && !m.getName().startsWith("wait") && !m.getName().equals("getClass") && !m.getName().equals("hashCode") && !m.getName().equals("toString") && !m.getName().equals("notify") && !m.getName().equals("notifyAll")) {
                            try {
                                Object result = m.invoke(event);
                                LOGGER.info("  - " + m.getName() + "() = " + (result != null ? result.getClass().getSimpleName() + ": " + result : "null"));
                            } catch (Exception e) {
                                LOGGER.info("  - " + m.getName() + "() [error: " + e.getMessage() + "]");
                            }
                        }
                    }

                    // Try to extract using reflection on the event object itself
                    // The log shows message= and username= as parameters
                    try {
                        // Try getMessage() method
                        var msgMethod = event.getClass().getMethod("getMessage");
                        Object msgObj = msgMethod.invoke(event);
                        message = extractStringFromParamValue(msgObj);
                    } catch (NoSuchMethodException e1) {
                        // Try getContent() fallback
                        try {
                            var contentMethod = event.getClass().getMethod("getContent");
                            Object contentObj = contentMethod.invoke(event);
                            message = extractStringFromParamValue(contentObj);
                        } catch (Exception e2) {
                            LOGGER.warning("[Chat] No getMessage or getContent method found");
                        }
                    } catch (Exception e2) {
                        LOGGER.warning("[Chat] No getUsername or getSender method worked");
                    }

                // Try to get username
                try {
                    // Try getUsername() directly on event
                    var usernameMethod = event.getClass().getMethod("getUsername");
                    Object usernameObj = usernameMethod.invoke(event);
                    playerName = extractStringFromParamValue(usernameObj);
                } catch (NoSuchMethodException e1) {
                    // Try getSender().getUsername() fallback
                    try {
                        var sender = event.getSender();
                        if (sender != null) {
                            var username = sender.getUsername();
                            playerName = extractStringFromParamValue(username);
                        }
                    } catch (Exception e2) {
                        LOGGER.warning("[Chat] No getUsername or getSender method worked");
                    }
                }

                LOGGER.info("[KyuubiSoft Chat] " + playerName + ": " + message);
                eventBroadcaster.broadcastChat(playerName, message);
            } catch (Exception e) {
                LOGGER.warning("[Chat] Error processing chat event: " + e.getMessage());
                e.printStackTrace();
            }
        });
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

        // Log available methods for debugging
        LOGGER.info("[Debug] Available methods on " + obj.getClass().getName() + ":");
        for (var m : obj.getClass().getMethods()) {
            if (m.getParameterCount() == 0 && !m.getName().equals("getClass")) {
                LOGGER.info("  - " + m.getName() + "() -> " + m.getReturnType().getSimpleName());
            }
        }

        // Return raw toString as fallback (with cleanup)
        return strVal.contains("@") ? "[raw:" + obj.getClass().getSimpleName() + "]" : strVal;
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

        // Log available methods for debugging
        LOGGER.info("[Debug] Available methods on " + obj.getClass().getName() + ":");
        for (var m : obj.getClass().getMethods()) {
            if (m.getParameterCount() == 0 && !m.getName().equals("getClass")) {
                LOGGER.info("  - " + m.getName() + "() -> " + m.getReturnType().getSimpleName());
            }
        }

        // Return raw toString as fallback (with cleanup)
        return strVal.contains("@") ? "[raw:" + obj.getClass().getSimpleName() + "]" : strVal;
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
