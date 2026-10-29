package com.kyuubisoft.api.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.kyuubisoft.api.KyuubiSoftAPI;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Logger;

/**
 * Configuration for KyuubiSoft API Plugin
 *
 * <p>Since 2.0.0 every request needs {@code Authorization: Bearer <authToken>}.
 * Without a usable token the API stays locked (fail-closed); the KyuubiSoft
 * Panel writes the token into this file before each server start.</p>
 */
public class ApiConfig {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    /** Fallback token source when the config file has none (e.g. containers created by the panel). */
    public static final String TOKEN_ENV = "KYUUBISOFT_API_TOKEN";
    /** Shorter tokens are treated as "not configured" so a placeholder never unlocks the API. */
    public static final int MIN_TOKEN_LENGTH = 16;

    private final KyuubiSoftAPI plugin;
    private ConfigData data;

    public ApiConfig(KyuubiSoftAPI plugin) {
        this.plugin = plugin;
        this.data = new ConfigData();
    }

    public void load() {
        Path configPath = getConfigPath();

        if (Files.exists(configPath)) {
            try (Reader reader = Files.newBufferedReader(configPath)) {
                ConfigData loaded = GSON.fromJson(reader, ConfigData.class);
                // An empty file parses to null; keep the (locked) defaults then.
                data = loaded != null ? loaded : new ConfigData();
                LOGGER.info("Configuration loaded from " + configPath);
            } catch (Exception e) {
                LOGGER.warning("Failed to load config, using defaults: " + e.getMessage());
                data = new ConfigData();
            }
        } else {
            // Create default config
            save();
            LOGGER.info("Created default configuration at " + configPath);
        }
    }

    public void save() {
        Path configPath = getConfigPath();

        try {
            Files.createDirectories(configPath.getParent());
            try (Writer writer = Files.newBufferedWriter(configPath)) {
                GSON.toJson(data, writer);
            }
        } catch (Exception e) {
            LOGGER.warning("Failed to save config: " + e.getMessage());
        }
    }

    private Path getConfigPath() {
        return Path.of("config", "kyuubisoft-api", "config.json");
    }

    public int getHttpPort() {
        return data.httpPort;
    }

    /**
     * The bearer token clients must send. The config file wins; the
     * {@value #TOKEN_ENV} environment variable is the fallback. Empty when
     * neither is set.
     */
    public String getAuthToken() {
        String fromFile = data.authToken == null ? "" : data.authToken.trim();
        if (!fromFile.isEmpty()) return fromFile;
        String fromEnv = System.getenv(TOKEN_ENV);
        return fromEnv == null ? "" : fromEnv.trim();
    }

    private String getAuthTokenSource() {
        String fromFile = data.authToken == null ? "" : data.authToken.trim();
        return fromFile.isEmpty() ? "environment variable " + TOKEN_ENV : "config file";
    }

    /** True when a token long enough to be enforced is configured. */
    public boolean hasUsableToken() {
        return getAuthToken().length() >= MIN_TOKEN_LENGTH;
    }

    /** Explicit, loudly logged opt-out for isolated development setups. */
    public boolean isAuthDisabled() {
        return data.insecureDisableAuth;
    }

    /** Browser origins allowed to call the API cross-origin. Empty = CORS off. */
    public List<String> getCorsAllowedOrigins() {
        List<String> origins = new ArrayList<>();
        if (data.corsAllowedOrigins != null) {
            for (String origin : data.corsAllowedOrigins) {
                if (origin != null) origins.add(origin);
            }
        }
        return origins;
    }

    /**
     * Log how the API is protected. Called once at startup so operators see
     * a locked or unprotected API in the server log. Never logs the token.
     */
    public void logSecurityPosture(int port) {
        if (isAuthDisabled()) {
            LOGGER.warning("==============================================================");
            LOGGER.warning(" SECURITY WARNING: insecureDisableAuth is true.");
            LOGGER.warning(" The API on port " + port + " accepts requests WITHOUT a token,");
            LOGGER.warning(" including player actions and the chat/position stream.");
            LOGGER.warning(" Only use this on an isolated development machine.");
            LOGGER.warning("==============================================================");
        } else if (getAuthToken().isEmpty()) {
            LOGGER.severe("No auth token configured: the API on port " + port + " is LOCKED and answers every request with 503.");
            LOGGER.severe("Set authToken in config/kyuubisoft-api/config.json or " + TOKEN_ENV
                    + " (the KyuubiSoft Panel writes it automatically before each server start).");
        } else if (!hasUsableToken()) {
            LOGGER.severe("authToken is shorter than " + MIN_TOKEN_LENGTH + " characters: the API on port " + port
                    + " is LOCKED. Use a long random token, e.g. `openssl rand -hex 32`.");
        } else {
            LOGGER.info("Auth: bearer token required for HTTP and WebSocket (token from " + getAuthTokenSource() + ")");
        }

        if (Boolean.FALSE.equals(data.authEnabled)) {
            LOGGER.info("Legacy key authEnabled=false is ignored since 2.0.0: a token is always required.");
        }
        if (data.corsEnabled != null || data.corsOrigin != null) {
            LOGGER.info("Legacy keys corsEnabled/corsOrigin are ignored since 2.0.0: CORS is off unless corsAllowedOrigins lists explicit origins.");
        }
    }

    /**
     * Interval (in ms) for the periodic player_position broadcast. <= 0
     * disables the ticker. Default 2 000 ms matches the panel's live-map
     * expected refresh rate.
     */
    public int getPositionBroadcastIntervalMs() {
        return data.positionBroadcastIntervalMs;
    }

    /**
     * Configuration data structure
     */
    public static class ConfigData {
        public int httpPort = 18085;
        public String authToken = "";
        // Explicit opt-out. A new key on purpose: 1.4.x wrote authEnabled=false
        // into every config, so the old switch must not disable auth anymore.
        public boolean insecureDisableAuth = false;
        public List<String> corsAllowedOrigins = new ArrayList<>();
        public int wsHeartbeatSeconds = 30;
        public boolean logRequests = false;
        // v3.1 — periodic per-player position broadcast for the panel's
        // live-map and replay recorder. Set to 0 to disable.
        public int positionBroadcastIntervalMs = 2000;

        // Legacy 1.4.x keys, read only to explain at startup that they are
        // ignored. Null when absent, so new default configs don't contain them.
        public Boolean authEnabled;
        public Boolean corsEnabled;
        public String corsOrigin;
    }
}
