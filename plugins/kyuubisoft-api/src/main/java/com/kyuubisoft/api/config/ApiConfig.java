package com.kyuubisoft.api.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.logging.Logger;

/**
 * Configuration for KyuubiSoft API Plugin
 *
 * <p>Since 2.0.0 every request needs {@code Authorization: Bearer <authToken>}.
 * Without a usable token the API stays locked (fail-closed); the KyuubiSoft
 * Panel writes the token into this file before each server start.</p>
 *
 * <p>Since 2.1.0 the file lives in the plugin's data directory
 * ({@code mods/KyuubiDDragon_KyuubiSoftAPI/config.json}). A config at the old
 * place ({@code config/kyuubisoft-api/config.json}) is moved there on startup:
 * its known keys are kept unless the new file already sets them (the
 * security-relevant ones only while no new file exists), and the old file is
 * deleted afterwards so the token is not left behind in two places.</p>
 */
public class ApiConfig {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    /** Fallback token source when the config file has none (e.g. containers created by the panel). */
    public static final String TOKEN_ENV = "KYUUBISOFT_API_TOKEN";
    /** Shorter tokens are treated as "not configured" so a placeholder never unlocks the API. */
    public static final int MIN_TOKEN_LENGTH = 16;
    public static final String CONFIG_FILE_NAME = "config.json";
    /** Where 1.x and 2.0.x kept the config, relative to the server's working directory. */
    public static final Path LEGACY_CONFIG_PATH = Path.of("config", "kyuubisoft-api", CONFIG_FILE_NAME);

    /** Keys an old config passes on to the new file (legacy 1.4.x keys only for the startup notice). */
    static final Set<String> LEGACY_KEYS = Set.of("httpPort", "authToken", "wsHeartbeatSeconds", "logRequests",
            "positionBroadcastIntervalMs", "tpsBroadcastIntervalMs", "authEnabled", "corsEnabled", "corsOrigin");
    /** Keys that weaken security: taken from an old config only when there is no new file yet. */
    static final Set<String> LEGACY_SECURITY_KEYS = Set.of("insecureDisableAuth", "corsAllowedOrigins");

    static final int DEFAULT_HTTP_PORT = 18085;
    // Shorter periodic intervals would only add load without visible benefit.
    static final int MIN_BROADCAST_INTERVAL_MS = 250;

    private final Path configPath;
    private final Path legacyConfigPath;
    private ConfigData data;

    /** @param dataDirectory the plugin's data directory ({@code getDataDirectory()}) */
    public ApiConfig(Path dataDirectory) {
        this(dataDirectory.resolve(CONFIG_FILE_NAME), LEGACY_CONFIG_PATH);
    }

    ApiConfig(Path configPath, Path legacyConfigPath) {
        this.configPath = configPath;
        this.legacyConfigPath = legacyConfigPath;
        this.data = new ConfigData();
    }

    public void load() {
        migrateLegacyConfig();

        if (Files.exists(configPath)) {
            data = read(configPath);
            LOGGER.info("Configuration loaded from " + configPath);
        } else {
            // Create default config
            data = new ConfigData();
            save();
            LOGGER.info("Created default configuration at " + configPath);
        }
        normalize();
    }

    /** Parse the file; an empty or broken file gives the (locked) defaults. */
    private static ConfigData read(Path path) {
        try {
            String content = Files.readString(path, StandardCharsets.UTF_8);
            if (content.isBlank()) {
                LOGGER.warning("Config file " + path + " is empty, using defaults");
                return new ConfigData();
            }
            ConfigData loaded = GSON.fromJson(stripBom(content), ConfigData.class);
            return loaded != null ? loaded : new ConfigData();
        } catch (Exception e) {
            // Never echo the content or parser details: the file holds the token.
            LOGGER.warning("Config file " + path + " is not valid JSON (" + e.getClass().getSimpleName()
                    + "), using defaults");
            return new ConfigData();
        }
    }

    /** Replace missing or out-of-range values with their defaults. */
    private void normalize() {
        if (data.httpPort < 1 || data.httpPort > 65535) {
            LOGGER.warning("httpPort " + data.httpPort + " is invalid, using " + DEFAULT_HTTP_PORT);
            data.httpPort = DEFAULT_HTTP_PORT;
        }
        if (data.authToken == null) data.authToken = "";
        if (data.corsAllowedOrigins == null) data.corsAllowedOrigins = new ArrayList<>();
        data.positionBroadcastIntervalMs = clampInterval("positionBroadcastIntervalMs", data.positionBroadcastIntervalMs);
        data.tpsBroadcastIntervalMs = clampInterval("tpsBroadcastIntervalMs", data.tpsBroadcastIntervalMs);
    }

    private static int clampInterval(String key, int value) {
        if (value <= 0 || value >= MIN_BROADCAST_INTERVAL_MS) return value;
        LOGGER.warning(key + " " + value + " is too short, using " + MIN_BROADCAST_INTERVAL_MS);
        return MIN_BROADCAST_INTERVAL_MS;
    }

    /**
     * Move a config from the pre-2.1 location into the data directory. Keys of
     * the new file win, except an empty authToken there does not hide a token
     * from the old file. The keys that weaken security ({@link #LEGACY_SECURITY_KEYS})
     * only come along while there is no new file yet: an old file dropped next
     * to a running install must not switch auth off. Old locations with a
     * symlink anywhere in the path are left alone.
     */
    void migrateLegacyConfig() {
        if (!Files.isRegularFile(legacyConfigPath, LinkOption.NOFOLLOW_LINKS)) return;
        if (hasSymlinkInPath(legacyConfigPath)) {
            LOGGER.warning("Not moving the old configuration from " + legacyConfigPath
                    + ": a folder on that path is a symbolic link");
            return;
        }
        try {
            boolean newFileExists = Files.exists(configPath);
            JsonObject merged = legacyKeys(readObjectOrEmpty(legacyConfigPath), !newFileExists);
            if (newFileExists) {
                JsonObject current = readObjectOrEmpty(configPath);
                for (Map.Entry<String, JsonElement> entry : current.entrySet()) {
                    if (entry.getKey().equals("authToken") && isBlankString(entry.getValue())) continue;
                    merged.add(entry.getKey(), entry.getValue());
                }
            }
            writeSecret(configPath, GSON.toJson(merged));
            Files.delete(legacyConfigPath);
            deleteIfEmpty(legacyConfigPath.getParent());
            LOGGER.info("Moved configuration from " + legacyConfigPath + " to " + configPath);
        } catch (Exception e) {
            LOGGER.warning("Could not move the old configuration from " + legacyConfigPath + " to " + configPath
                    + " (" + e.getClass().getSimpleName() + "); using " + configPath);
        }
    }

    /** The keys of an old config worth keeping; unknown keys are dropped. */
    static JsonObject legacyKeys(JsonObject legacy, boolean includeSecurityKeys) {
        JsonObject kept = new JsonObject();
        for (Map.Entry<String, JsonElement> entry : legacy.entrySet()) {
            String key = entry.getKey();
            if (LEGACY_KEYS.contains(key) || (includeSecurityKeys && LEGACY_SECURITY_KEYS.contains(key))) {
                kept.add(key, entry.getValue());
            }
        }
        return kept;
    }

    /** True when any folder on the path (relative to the working directory) is a symbolic link. */
    private static boolean hasSymlinkInPath(Path path) {
        for (Path dir = path.getParent(); dir != null; dir = dir.getParent()) {
            if (Files.isSymbolicLink(dir)) return true;
        }
        return false;
    }

    private static JsonObject readObjectOrEmpty(Path path) {
        try {
            String content = Files.readString(path, StandardCharsets.UTF_8);
            if (content.isBlank()) return new JsonObject();
            JsonElement parsed = JsonParser.parseString(stripBom(content));
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
        } catch (Exception e) {
            return new JsonObject();
        }
    }

    private static boolean isBlankString(JsonElement value) {
        return value == null || value.isJsonNull()
                || (value.isJsonPrimitive() && value.getAsString().isBlank());
    }

    private static String stripBom(String content) {
        return !content.isEmpty() && content.charAt(0) == '﻿' ? content.substring(1) : content;
    }

    private static void deleteIfEmpty(Path dir) {
        if (dir == null) return;
        try (var entries = Files.list(dir)) {
            if (entries.findAny().isEmpty()) Files.delete(dir);
        } catch (IOException ignored) {
            // Not empty or not ours: keep it.
        }
    }

    /** Write a file that may hold the token: owner-only where the file system supports it. */
    private static void writeSecret(Path path, String content) throws IOException {
        Files.createDirectories(path.getParent());
        Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
        Files.deleteIfExists(tmp);
        try {
            // Owner-only from the start, so the token is never readable by others.
            Files.createFile(tmp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } catch (UnsupportedOperationException e) {
            // Windows / non-POSIX file system: default permissions.
            Files.createFile(tmp);
        }
        try {
            Files.writeString(tmp, content, StandardCharsets.UTF_8);
            try {
                Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    public void save() {
        try {
            writeSecret(configPath, GSON.toJson(data));
        } catch (Exception e) {
            LOGGER.warning("Failed to save config: " + e.getMessage());
        }
    }

    /** The config file this instance reads (in the plugin's data directory). */
    public Path getConfigPath() {
        return configPath;
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
            LOGGER.warning(" The API on port " + port + " accepts reads WITHOUT a token,");
            LOGGER.warning(" including the chat/position stream. Commands, player and mod");
            LOGGER.warning(" actions (every method but GET, HEAD, OPTIONS) are refused (403).");
            LOGGER.warning(" Only use this on an isolated development machine.");
            LOGGER.warning("==============================================================");
        } else if (getAuthToken().isEmpty()) {
            LOGGER.severe("No auth token configured: the API on port " + port + " is LOCKED and answers every request with 503.");
            LOGGER.severe("Set authToken in " + configPath + " or " + TOKEN_ENV
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
     * Interval (in ms) for the periodic per-world tps_update broadcast. <= 0
     * disables it. Default 5 000 ms.
     */
    public int getTpsBroadcastIntervalMs() {
        return data.tpsBroadcastIntervalMs;
    }

    /**
     * Configuration data structure
     */
    public static class ConfigData {
        public int httpPort = DEFAULT_HTTP_PORT;
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
        // 2.1.0 — periodic per-world tps_update for the panel's TPS alarm and
        // history. Set to 0 to disable.
        public int tpsBroadcastIntervalMs = 5000;

        // Legacy 1.4.x keys, read only to explain at startup that they are
        // ignored. Null when absent, so new default configs don't contain them.
        public Boolean authEnabled;
        public Boolean corsEnabled;
        public String corsOrigin;
    }
}
