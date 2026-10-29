package com.kyuubisoft.api.live;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.hypixel.hytale.common.plugin.PluginManifest;
import com.hypixel.hytale.common.semver.SemverRange;
import com.hypixel.hytale.server.core.plugin.PluginManager;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Finds mods the server refused before setup (missing dependency, failed
 * class loading): those never reach the plugin manager, so their only trace
 * is the jar in the mods folder. Each jar's manifest is compared with the
 * known plugins; whatever is unknown is reported as {@link #REJECTED} with
 * the cause that can be derived (missing dependencies, server version).
 */
final class RejectedPluginScanner {

    static final String REJECTED = "REJECTED";
    private static final String MANIFEST = "manifest.json";
    // Real manifests are a few KB; a huge one is not a plugin manifest.
    private static final int MAX_MANIFEST_BYTES = 256 * 1024;
    private static final int MAX_CACHED_MANIFESTS = 1_024;
    private static final Map<Path, CachedManifest> MANIFESTS = new ConcurrentHashMap<>();

    private RejectedPluginScanner() {
    }

    static List<PluginStatusCollector.PluginInfo> scan(Set<String> knownIds, String serverVersion) {
        List<PluginStatusCollector.PluginInfo> rejected = new ArrayList<>();
        Path modsDir = PluginManager.MODS_PATH;
        if (modsDir == null || !Files.isDirectory(modsDir)) return rejected;
        try (DirectoryStream<Path> files = Files.newDirectoryStream(modsDir, RejectedPluginScanner::isArchive)) {
            for (Path file : files) {
                JsonObject manifest = readManifest(file);
                if (manifest == null) continue;
                String group = string(manifest, "Group");
                String name = string(manifest, "Name");
                // Asset-only packs have no main class and are no plugins: never "rejected".
                if (group == null || name == null || string(manifest, "Main") == null) continue;
                String id = group + ":" + name;
                if (knownIds.contains(id)) continue;
                rejected.add(describe(id, group, name, manifest, file, knownIds, serverVersion));
            }
        } catch (IOException | RuntimeException e) {
            // An unreadable mods folder only means no extra entries.
        }
        return rejected;
    }

    private static PluginStatusCollector.PluginInfo describe(String id, String group, String name,
            JsonObject manifest, Path file, Set<String> knownIds, String serverVersion) {
        PluginStatusCollector.PluginInfo info = new PluginStatusCollector.PluginInfo();
        info.id = id;
        info.group = group;
        info.name = name;
        info.version = string(manifest, "Version");
        info.description = LiveFormat.clip(string(manifest, "Description"));
        info.state = REJECTED;
        info.enabled = false;
        info.file = file.getFileName().toString();

        info.missingDependencies = new ArrayList<>();
        JsonElement deps = manifest.get("Dependencies");
        if (deps != null && deps.isJsonObject()) {
            for (String dep : deps.getAsJsonObject().keySet()) {
                if (!knownIds.contains(dep)) info.missingDependencies.add(dep);
            }
        }

        info.serverVersionRange = string(manifest, "ServerVersion");
        if (serverVersion != null) {
            try {
                SemverRange range = info.serverVersionRange == null ? null : SemverRange.fromString(info.serverVersionRange);
                PluginManifest.ServerVersionCheck check =
                        PluginManifest.checkServerVersionCompatibility(range, serverVersion);
                info.serverVersionCheck = check == null ? null : check.name();
                info.versionMismatch = check == PluginManifest.ServerVersionCheck.INCOMPATIBLE;
            } catch (RuntimeException e) {
                info.serverVersionCheck = PluginManifest.ServerVersionCheck.PARSE_FAILED.name();
            }
        }

        PluginStatusCollector.PluginError error = new PluginStatusCollector.PluginError();
        error.type = info.missingDependencies.isEmpty() ? "LoadRejected" : "MissingDependency";
        error.message = info.missingDependencies.isEmpty()
                ? "Refused while loading; the server log has the cause"
                : "Missing dependency: " + String.join(", ", info.missingDependencies);
        info.error = error;
        return info;
    }

    private static boolean isArchive(Path path) {
        String file = path.getFileName().toString().toLowerCase(Locale.ROOT);
        return Files.isRegularFile(path) && (file.endsWith(".jar") || file.endsWith(".zip"));
    }

    /**
     * The archive's manifest, read again only when the file changed (this runs
     * on every /api/plugins request and every few seconds in the state watcher).
     */
    private static JsonObject readManifest(Path file) {
        long modified;
        long size;
        try {
            modified = Files.getLastModifiedTime(file).toMillis();
            size = Files.size(file);
        } catch (IOException | RuntimeException e) {
            return null;
        }
        CachedManifest cached = MANIFESTS.get(file);
        if (cached != null && cached.modified == modified && cached.size == size) return cached.manifest;
        JsonObject manifest = parseManifest(file);
        if (MANIFESTS.size() >= MAX_CACHED_MANIFESTS) MANIFESTS.clear();
        MANIFESTS.put(file, new CachedManifest(modified, size, manifest));
        return manifest;
    }

    private static JsonObject parseManifest(Path file) {
        try (ZipFile zip = new ZipFile(file.toFile())) {
            ZipEntry entry = zip.getEntry(MANIFEST);
            if (entry == null || entry.getSize() > MAX_MANIFEST_BYTES) return null;
            byte[] bytes;
            try (InputStream in = zip.getInputStream(entry)) {
                // The declared size can lie: never read more than the cap.
                bytes = in.readNBytes(MAX_MANIFEST_BYTES + 1);
            }
            if (bytes.length > MAX_MANIFEST_BYTES) return null;
            JsonElement json = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8));
            return json != null && json.isJsonObject() ? json.getAsJsonObject() : null;
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** null manifest = not readable; cached as well so a broken jar is not reopened every time. */
    private record CachedManifest(long modified, long size, JsonObject manifest) {
    }

    private static String string(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }
}
