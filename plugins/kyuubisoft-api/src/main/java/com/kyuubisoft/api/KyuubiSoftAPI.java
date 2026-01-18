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
import java.util.logging.Handler;
import java.util.logging.LogRecord;

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

        // Set up chat log interceptor as fallback
        setupChatLogInterceptor();
    }

    /**
     * Sets up a log handler to intercept chat messages from Hytale's internal logging.
     * This is a fallback since PlayerChatEvent doesn't seem to be fired.
     */
    private void setupChatLogInterceptor() {
        LOGGER.info("[KyuubiSoft] Setting up chat log interceptor...");

        // Get the root logger to intercept all logs
        Logger rootLogger = Logger.getLogger("");

        // Add our custom handler
        Handler chatHandler = new Handler() {
            // Keep track of last message to avoid duplicates
            private String lastMessage = "";
            private long lastTime = 0;

            @Override
            public void publish(LogRecord record) {
                if (record == null || record.getMessage() == null) return;

                String msg = record.getMessage();

                // Check if this is a chat message
                if (msg.contains("server.chat.playerMessage{")) {
                    // Avoid duplicates within 100ms
                    long now = System.currentTimeMillis();
                    if (msg.equals(lastMessage) && (now - lastTime) < 100) {
                        return;
                    }
                    lastMessage = msg;
                    lastTime = now;

                    LOGGER.info("[KyuubiSoft] Intercepted chat log: " + msg);

                    // Try to get the actual parameters from the LogRecord
                    Object[] params = record.getParameters();
                    if (params != null && params.length > 0) {
                        LOGGER.info("[KyuubiSoft] Log has " + params.length + " parameters");
                        for (int i = 0; i < params.length; i++) {
                            Object param = params[i];
                            if (param != null) {
                                LOGGER.info("[KyuubiSoft] Param " + i + ": " + param.getClass().getName() + " = " + param);
                                // Try to extract string from param
                                String extracted = extractStringFromParamValue(param);
                                LOGGER.info("[KyuubiSoft] Param " + i + " extracted: " + extracted);
                            }
                        }
                    }

                    // Try to extract from the Throwable if present (some logging frameworks use this)
                    Throwable thrown = record.getThrown();
                    if (thrown != null) {
                        LOGGER.info("[KyuubiSoft] Log has thrown: " + thrown.getClass().getName());
                    }
                }
            }

            @Override
            public void flush() {}

            @Override
            public void close() throws SecurityException {}
        };

        rootLogger.addHandler(chatHandler);
        LOGGER.info("[KyuubiSoft] Chat log interceptor installed");
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
                    LOGGER.info("[KyuubiSoft] PlayerChatEvent fired (global)!");
                    String playerName = "Unknown";
                    String message = "";

                    // Get sender username
                    try {
                        var sender = event.getSender();
                        if (sender != null) {
                            playerName = sender.getUsername();
                            LOGGER.info("[KyuubiSoft] Sender: " + playerName);
                        }
                    } catch (Exception e) {
                        LOGGER.warning("[Chat] Could not get sender: " + e.getMessage());
                    }

                    // Get message content using getContent() (not getMessage())
                    try {
                        Object content = event.getContent();
                        LOGGER.info("[KyuubiSoft] Content class: " + (content != null ? content.getClass().getName() : "null"));
                        message = extractStringFromParamValue(content);
                        LOGGER.info("[KyuubiSoft] Extracted message: " + message);
                    } catch (Exception e) {
                        LOGGER.warning("[Chat] Could not get content: " + e.getMessage());
                    }

                    // Try to get formatted message using the formatter
                    try {
                        var formatter = event.getFormatter();
                        if (formatter != null) {
                            var formattedMsg = formatter.format(event.getSender(), event.getContent());
                            if (formattedMsg != null) {
                                // Try various methods to get the string representation
                                LOGGER.info("[KyuubiSoft] FormattedMsg class: " + formattedMsg.getClass().getName());

                                // List all available methods on the Message object
                                for (var m : formattedMsg.getClass().getMethods()) {
                                    if (m.getParameterCount() == 0 && m.getReturnType() == String.class) {
                                        try {
                                            String result = (String) m.invoke(formattedMsg);
                                            if (result != null && !result.isEmpty()) {
                                                LOGGER.info("[KyuubiSoft] " + m.getName() + "(): " + result);
                                            }
                                        } catch (Exception ignored) {}
                                    }
                                }
                            }
                        }
                    } catch (Exception e) {
                        LOGGER.info("[Chat] Formatter not available: " + e.getMessage());
                    }

                    LOGGER.info("[KyuubiSoft Chat] " + playerName + ": " + message);
                    eventBroadcaster.broadcastChat(playerName, message);
                } catch (Exception e) {
                    LOGGER.warning("[Chat] Error: " + e.getMessage());
                    e.printStackTrace();
                }
            });
            LOGGER.info("[KyuubiSoft] Registered global PlayerChatEvent handler");
        } catch (Exception e) {
            LOGGER.warning("[KyuubiSoft] Could not register PlayerChatEvent: " + e.getMessage());
            e.printStackTrace();
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
