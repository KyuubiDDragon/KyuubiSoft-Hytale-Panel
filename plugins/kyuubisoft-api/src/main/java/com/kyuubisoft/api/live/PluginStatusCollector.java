package com.kyuubisoft.api.live;

import com.hypixel.hytale.common.plugin.AuthorInfo;
import com.hypixel.hytale.common.plugin.PluginIdentifier;
import com.hypixel.hytale.common.plugin.PluginManifest;
import com.hypixel.hytale.common.semver.SemverRange;
import com.hypixel.hytale.common.util.java.ManifestUtil;
import com.hypixel.hytale.server.core.plugin.PluginBase;
import com.hypixel.hytale.server.core.plugin.PluginManager;
import com.hypixel.hytale.server.core.plugin.PluginState;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * GET /api/plugins: every plugin/mod the server knows, with its load state,
 * version, failure cause and server-version compatibility.
 *
 * <p>Entries come from the plugin manager, so they show what actually loaded.
 * Manifests it discovered but did not load (disabled) are NOT_LOADED; jars in
 * the mods folder it refused before setup (missing dependency, class loading)
 * are REJECTED, see {@link RejectedPluginScanner}.</p>
 */
public final class PluginStatusCollector {

    /** State reported for a discovered manifest that has no loaded plugin. */
    static final String NOT_LOADED = "NOT_LOADED";

    // PluginBase keeps the failure cause package-private; read it reflectively
    // and degrade to "no detail" if a server update moves it.
    private static final Method FAILURE_CAUSE = lookupFailureCause();

    public PluginsResponse collect() {
        PluginsResponse response = new PluginsResponse();
        response.serverVersion = serverVersion();
        response.plugins = new ArrayList<>();

        PluginManager manager = PluginManager.get();
        if (manager == null) return response;
        response.managerState = LiveFormat.lower(manager.getState());

        Set<String> loadedIds = new HashSet<>();
        for (PluginBase plugin : manager.getPlugins()) {
            PluginInfo info = describe(plugin, response.serverVersion);
            loadedIds.add(info.id);
            response.plugins.add(info);
        }
        Set<String> knownIds = new HashSet<>(loadedIds);
        for (Map.Entry<PluginIdentifier, PluginManifest> entry : availableManifests(manager).entrySet()) {
            String id = entry.getKey().toString();
            knownIds.add(id);
            if (loadedIds.contains(id)) continue;
            response.plugins.add(describeUnloaded(id, entry.getValue(), response.serverVersion));
        }
        // Mods refused before setup are only visible as jars in the mods folder.
        response.plugins.addAll(RejectedPluginScanner.scan(knownIds, response.serverVersion));

        response.plugins.sort(Comparator.comparing((PluginInfo p) -> p.core)
                .thenComparing(p -> p.id, String.CASE_INSENSITIVE_ORDER));
        for (PluginInfo info : response.plugins) {
            if (info.core) response.coreCount++;
            if (PluginState.FAILED.name().equals(info.state)
                    || RejectedPluginScanner.REJECTED.equals(info.state)) response.failedCount++;
            if (info.versionMismatch) response.mismatchCount++;
        }
        response.count = response.plugins.size();
        return response;
    }

    /** Lightweight id → state map for the change watcher. */
    Map<String, PluginInfo> snapshot() {
        Map<String, PluginInfo> states = new LinkedHashMap<>();
        PluginManager manager = PluginManager.get();
        if (manager == null) return states;
        String serverVersion = serverVersion();
        for (PluginBase plugin : manager.getPlugins()) {
            PluginInfo info = describe(plugin, serverVersion);
            states.put(info.id, info);
        }
        return states;
    }

    private static PluginInfo describe(PluginBase plugin, String serverVersion) {
        PluginInfo info = fromManifest(plugin.getIdentifier().toString(), plugin.getManifest(), serverVersion);
        PluginState state = plugin.getState();
        info.state = state == null ? null : state.name();
        info.enabled = plugin.isEnabled();
        if (state == PluginState.FAILED) info.error = failureCause(plugin);
        return info;
    }

    private static PluginInfo describeUnloaded(String id, PluginManifest manifest, String serverVersion) {
        PluginInfo info = fromManifest(id, manifest, serverVersion);
        info.state = NOT_LOADED;
        info.enabled = false;
        info.disabledByDefault = manifest != null && manifest.isDisabledByDefault();
        return info;
    }

    private static PluginInfo fromManifest(String id, PluginManifest manifest, String serverVersion) {
        PluginInfo info = new PluginInfo();
        info.id = id;
        if (manifest == null) return info;
        info.group = manifest.getGroup();
        info.name = manifest.getName();
        info.version = manifest.getVersion() == null ? null : manifest.getVersion().toString();
        info.description = LiveFormat.clip(manifest.getDescription());
        info.website = manifest.getWebsite();
        info.core = PluginManifest.CORE_GROUP.equals(manifest.getGroup());
        info.authors = authors(manifest.getAuthors());
        info.dependencies = ranges(manifest.getDependencies());
        info.optionalDependencies = ranges(manifest.getOptionalDependencies());

        SemverRange range = manifest.getServerVersion();
        info.serverVersionRange = range == null ? null : range.toString();
        if (!info.core && serverVersion != null) {
            try {
                PluginManifest.ServerVersionCheck check =
                        PluginManifest.checkServerVersionCompatibility(range, serverVersion);
                info.serverVersionCheck = check == null ? null : check.name();
                info.versionMismatch = check == PluginManifest.ServerVersionCheck.INCOMPATIBLE;
            } catch (Throwable ignored) {
                // Unparsable server version: leave the check unset rather than guessing.
            }
        }
        return info;
    }

    private static Map<PluginIdentifier, PluginManifest> availableManifests(PluginManager manager) {
        try {
            // The manager hands out its live map; copy before iterating.
            return new HashMap<>(manager.getAvailablePlugins());
        } catch (Throwable t) {
            return Map.of();
        }
    }

    private static List<String> authors(List<AuthorInfo> authors) {
        List<String> names = new ArrayList<>();
        if (authors == null) return names;
        for (AuthorInfo author : authors) {
            if (author != null && author.getName() != null) names.add(author.getName());
        }
        return names;
    }

    private static Map<String, String> ranges(Map<PluginIdentifier, SemverRange> deps) {
        Map<String, String> out = new LinkedHashMap<>();
        if (deps == null) return out;
        for (Map.Entry<PluginIdentifier, SemverRange> dep : deps.entrySet()) {
            out.put(dep.getKey().toString(), dep.getValue() == null ? "*" : dep.getValue().toString());
        }
        return out;
    }

    private static String serverVersion() {
        try {
            return ManifestUtil.getImplementationVersion();
        } catch (Throwable t) {
            return null;
        }
    }

    private static Method lookupFailureCause() {
        try {
            Method method = PluginBase.class.getDeclaredMethod("getFailureCause");
            method.setAccessible(true);
            return method;
        } catch (Throwable t) {
            return null;
        }
    }

    private static PluginError failureCause(PluginBase plugin) {
        if (FAILURE_CAUSE == null) return null;
        try {
            Object cause = FAILURE_CAUSE.invoke(plugin);
            if (!(cause instanceof Throwable throwable)) return null;
            // Report the innermost cause: that is the actual load error.
            Throwable root = throwable;
            while (root.getCause() != null && root.getCause() != root) root = root.getCause();
            PluginError error = new PluginError();
            error.type = root.getClass().getName();
            error.message = LiveFormat.clip(root.getMessage());
            if (root != throwable) {
                error.wrapperType = throwable.getClass().getName();
                error.wrapperMessage = LiveFormat.clip(throwable.getMessage());
            }
            return error;
        } catch (Throwable t) {
            return null;
        }
    }

    // Response classes (Gson omits null fields).

    public static class PluginsResponse {
        public String serverVersion;
        public String managerState;
        public int count;
        public int coreCount;
        public int failedCount;
        public int mismatchCount;
        public List<PluginInfo> plugins;
    }

    public static class PluginInfo {
        public String id;
        public String group;
        public String name;
        public String version;
        public String state;
        public boolean enabled;
        public boolean core;
        public Boolean disabledByDefault;
        public String description;
        public String website;
        public List<String> authors;
        public String serverVersionRange;
        public String serverVersionCheck;
        public boolean versionMismatch;
        public Map<String, String> dependencies;
        public Map<String, String> optionalDependencies;
        /** Jar name, only for REJECTED entries (found in the mods folder, never loaded). */
        public String file;
        /** Dependencies no known plugin provides, only for REJECTED entries. */
        public List<String> missingDependencies;
        public PluginError error;
    }

    public static class PluginError {
        public String type;
        public String message;
        public String wrapperType;
        public String wrapperMessage;
    }
}
