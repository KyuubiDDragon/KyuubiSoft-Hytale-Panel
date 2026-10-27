package com.kyuubisoft.api.live;

import java.time.Instant;
import java.util.List;

/**
 * WebSocket event frames added with the live-data API. Every frame carries
 * {@code type} and {@code timestamp} like the existing events; Gson omits
 * null fields, which the panel schema treats as "unknown".
 */
public final class LiveEvents {

    private LiveEvents() {
    }

    abstract static class Base {
        public final String type;
        public final String timestamp = Instant.now().toString();

        Base(String type) {
            this.type = type;
        }
    }

    /** {@code player_gamemode}: confirmed game mode change (cancelled changes are not reported). */
    public static final class GameModeChanged extends Base {
        public String player;
        public String uuid;
        public String world;
        public String from;
        public String to;

        GameModeChanged() {
            super("player_gamemode");
        }
    }

    /** {@code player_join_denied}: a connection refused during setup (ban, whitelist, plugin). */
    public static final class JoinDenied extends Base {
        public String player;
        public String uuid;
        /** banned | whitelist | other */
        public String kind;
        public String reason;
        public String reasonId;

        JoinDenied() {
            super("player_join_denied");
        }
    }

    /** {@code world_added} / {@code world_removed}. */
    public static final class WorldChanged extends Base {
        public String world;
        /** Removal reason (GENERAL, EXCEPTIONAL); absent for world_added. */
        public String reason;
        /**
         * True when the world goes away because the server shuts down; the
         * server then reports EXCEPTIONAL even though nothing failed.
         */
        public Boolean serverShuttingDown;

        WorldChanged(String type) {
            super(type);
        }
    }

    /** {@code server_shutdown}: sent first thing when the server starts shutting down. */
    public static final class ServerShutdown extends Base {
        public String reason;
        public Integer exitCode;
        public String message;

        ServerShutdown() {
            super("server_shutdown");
        }
    }

    /** {@code plugin_state}: a plugin/mod changed its load state. */
    public static final class PluginStateChanged extends Base {
        public String plugin;
        public String name;
        public String version;
        public String from;
        public String to;
        public PluginStatusCollector.PluginError error;

        PluginStateChanged() {
            super("plugin_state");
        }
    }

    /** {@code permission_changed}: a user's or a group's rights changed. */
    public static final class PermissionChanged extends Base {
        /** user | group */
        public String scope;
        /** group_added | group_removed | permissions_added | permissions_removed */
        public String action;
        public String uuid;
        public String player;
        public String group;
        public List<String> permissions;

        PermissionChanged() {
            super("permission_changed");
        }
    }
}
