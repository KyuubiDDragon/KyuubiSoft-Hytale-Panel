package com.kyuubisoft.api.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.kyuubisoft.api.KyuubiSoftAPI;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.logging.Logger;

/**
 * Configuration for KyuubiSoft API Plugin
 */
public class ApiConfig {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

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
                data = GSON.fromJson(reader, ConfigData.class);
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

    public boolean isAuthEnabled() {
        return data.authEnabled;
    }

    public String getAuthToken() {
        return data.authToken;
    }

    public boolean isCorsEnabled() {
        return data.corsEnabled;
    }

    public String getCorsOrigin() {
        return data.corsOrigin;
    }

    /**
     * Configuration data structure
     */
    public static class ConfigData {
        public int httpPort = 18085;
        public boolean authEnabled = false;
        public String authToken = "";
        public boolean corsEnabled = true;
        public String corsOrigin = "*";
        public int wsHeartbeatSeconds = 30;
        public boolean logRequests = false;
    }
}
