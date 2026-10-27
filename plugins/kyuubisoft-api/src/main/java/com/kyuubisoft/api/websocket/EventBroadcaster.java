package com.kyuubisoft.api.websocket;

import com.google.gson.Gson;
import com.kyuubisoft.api.metrics.WorldPerf;
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
        // Debug: LOGGER.fine("WebSocket client connected. Total clients: " + channels.size());
    }

    /**
     * Remove a WebSocket channel from the broadcast group
     */
    public void removeChannel(Channel channel) {
        channels.remove(channel);
        // Debug: LOGGER.fine("WebSocket client disconnected. Total clients: " + channels.size());
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
     * Broadcast a player death. The caller (the death system) fills the
     * victim, cause, killer and position; type and timestamp are set here.
     */
    public void broadcastPlayerDeath(PlayerDeathEvent event) {
        event.type = "player_death";
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /**
     * Broadcast chat message
     */
    public void broadcastChat(String playerName, String uuid, String message) {
        ChatEvent event = new ChatEvent();
        event.type = "player_chat";
        event.player = playerName;
        event.uuid = uuid;
        event.message = message;
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /**
     * Broadcast a player position update (live-map + replay).
     *
     * Fields may be null when the underlying Hytale API does not expose them
     * yet (see PositionTicker for the reflection-based extraction). The frame
     * is only sent when at least world+x+y+z are present, so consumers can
     * treat a payload's absence as "no data" rather than "player at 0,0,0".
     */
    public void broadcastPlayerPosition(String playerName, String uuid, String world,
                                        Double x, Double y, Double z,
                                        Double yaw, Double pitch, Integer latencyMs) {
        PlayerPositionEvent event = new PlayerPositionEvent();
        event.type = "player_position";
        event.player = playerName;
        event.uuid = uuid;
        event.world = world;
        event.x = x;
        event.y = y;
        event.z = z;
        event.yaw = yaw;
        event.pitch = pitch;
        event.latencyMs = latencyMs;
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /**
     * Broadcast the tick metrics of one world (sent periodically per world by
     * {@link TpsTicker}). {@code tps}/{@code mspt} are the 10 s averages; the
     * windows carry min/avg/max for 10 s, 1 min and 5 min.
     */
    public void broadcastTpsUpdate(WorldPerf.Snapshot perf) {
        TpsEvent event = new TpsEvent();
        event.type = "tps_update";
        event.world = perf.world;
        event.tps = perf.tps;
        event.mspt = perf.mspt;
        event.targetTps = perf.targetTps;
        event.tickBudgetMs = perf.tickBudgetMs;
        event.windows = perf.windows;
        event.players = perf.players;
        event.entities = perf.entities;
        event.loadedChunks = perf.loadedChunks;
        event.timestamp = Instant.now().toString();

        broadcast(event);
    }

    /** True while at least one WebSocket client listens; lets periodic producers skip work. */
    public boolean hasClients() {
        return !channels.isEmpty();
    }

    /**
     * Broadcast a ready-made event frame that sets its own {@code type} and
     * {@code timestamp} (the live-data events in {@code live.LiveEvents}).
     */
    public void broadcastEvent(Object frame) {
        broadcast(frame);
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
     * Broadcast an event a mod sent through {@code PanelRegistry.publishEvent}. The payload is
     * already checked and trimmed by {@code panel.internal.ModEvents}.
     */
    public void broadcastModEvent(String modId, String event, java.util.Map<String, Object> payload) {
        ModEvent frame = new ModEvent();
        frame.type = "mod_event";
        frame.modId = modId;
        frame.event = event;
        frame.payload = payload;
        frame.timestamp = Instant.now().toString();

        broadcast(frame);
    }

    /**
     * Broadcast that the set of registered commands changed (a plugin loaded,
     * unloaded or reloaded), so the panel refreshes its cached command list.
     */
    public void broadcastCommandsChanged(String revision, int count) {
        CommandsChangedEvent event = new CommandsChangedEvent();
        event.type = "commands_changed";
        event.revision = revision;
        event.count = count;
        event.timestamp = Instant.now().toString();

        broadcast(event);
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
        public String uuid;
        /** Damage cause id, e.g. "Physical", "Fall", "Drowning"; "unknown" when the server gives none. */
        public String cause;
        /** Name of the killing player or entity; omitted when unknown. */
        public String killer;
        /** UUID of the killing player; omitted for non-player killers. */
        public String killerUuid;
        /** "player", "entity", "environment" or "command"; omitted when unknown. */
        public String killerType;
        public String world;
        public Double x;
        public Double y;
        public Double z;
        public String timestamp;
    }

    public static class ChatEvent {
        public String type;
        public String player;
        public String uuid;
        public String message;
        public String timestamp;
    }

    public static class TpsEvent {
        public String type;
        public String world;
        /** 10 s average TPS (server formula, capped at the target). */
        public double tps;
        /** 10 s average time a tick took to compute, in ms. */
        public double mspt;
        public int targetTps;
        public double tickBudgetMs;
        public java.util.List<WorldPerf.Window> windows;
        public int players;
        public int entities;
        public int loadedChunks;
        public String timestamp;
    }

    public static class PlayerPositionEvent {
        public String type;
        public String player;
        public String uuid;
        public String world;
        public Double x;
        public Double y;
        public Double z;
        public Double yaw;
        public Double pitch;
        public Integer latencyMs;
        public String timestamp;
    }

    public static class ModEvent {
        public String type;
        public String modId;
        public String event;
        public java.util.Map<String, Object> payload;
        public String timestamp;
    }

    public static class CommandsChangedEvent {
        public String type;
        public String revision;
        public int count;
        public String timestamp;
    }
}
