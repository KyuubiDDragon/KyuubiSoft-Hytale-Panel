package com.kyuubisoft.api.websocket;

import com.google.gson.Gson;
import io.netty.channel.Channel;
import io.netty.channel.group.ChannelGroup;
import io.netty.channel.group.DefaultChannelGroup;
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame;
import io.netty.util.concurrent.GlobalEventExecutor;

import java.time.Instant;
import java.util.logging.Logger;

/**
 * Broadcasts events to all connected WebSocket clients
 */
public class EventBroadcaster {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final Gson GSON = new Gson();

    private final ChannelGroup channels = new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);

    /**
     * Add a WebSocket channel to the broadcast group
     */
    public void addChannel(Channel channel) {
        channels.add(channel);
        LOGGER.info("WebSocket client connected. Total clients: " + channels.size());
    }

    /**
     * Remove a WebSocket channel from the broadcast group
     */
    public void removeChannel(Channel channel) {
        channels.remove(channel);
        LOGGER.info("WebSocket client disconnected. Total clients: " + channels.size());
    }

    /**
     * Broadcast player join event
     */
    public void broadcastPlayerJoin(String playerName, String uuid) {
        PlayerEvent event = new PlayerEvent();
        event.type = "player_join";
        event.player = playerName;
        event.uuid = uuid;
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /**
     * Broadcast player leave event
     */
    public void broadcastPlayerLeave(String playerName, String uuid) {
        PlayerEvent event = new PlayerEvent();
        event.type = "player_leave";
        event.player = playerName;
        event.uuid = uuid;
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /**
     * Broadcast player death event
     */
    public void broadcastPlayerDeath(String playerName, String cause) {
        PlayerDeathEvent event = new PlayerDeathEvent();
        event.type = "player_death";
        event.player = playerName;
        event.cause = cause;
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /**
     * Broadcast chat message
     */
    public void broadcastChat(String playerName, String message) {
        ChatEvent event = new ChatEvent();
        event.type = "player_chat";
        event.player = playerName;
        event.message = message;
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /**
     * Broadcast TPS update (can be called periodically)
     */
    public void broadcastTpsUpdate(double tps, double mspt) {
        TpsEvent event = new TpsEvent();
        event.type = "tps_update";
        event.tps = tps;
        event.mspt = mspt;
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /**
     * Broadcast a generic event object
     */
    private void broadcast(Object event) {
        if (channels.isEmpty()) {
            return;
        }

        String json = GSON.toJson(event);
        TextWebSocketFrame frame = new TextWebSocketFrame(json);
        channels.writeAndFlush(frame);
    }

    /**
     * Get the number of connected clients
     */
    public int getClientCount() {
        return channels.size();
    }

    // Event classes

    public static class PlayerEvent {
        public String type;
        public String player;
        public String uuid;
        public String timestamp;
    }

    public static class PlayerDeathEvent {
        public String type;
        public String player;
        public String cause;
        public String timestamp;
    }

    public static class ChatEvent {
        public String type;
        public String player;
        public String message;
        public String timestamp;
    }

    public static class TpsEvent {
        public String type;
        public double tps;
        public double mspt;
        public String timestamp;
    }
}
