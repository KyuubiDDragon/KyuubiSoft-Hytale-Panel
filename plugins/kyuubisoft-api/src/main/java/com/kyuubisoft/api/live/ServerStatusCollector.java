package com.kyuubisoft.api.live;

import com.hypixel.hytale.common.util.java.ManifestUtil;
import com.hypixel.hytale.server.core.HytaleServer;
import com.hypixel.hytale.server.core.ShutdownReason;
import com.hypixel.hytale.server.core.auth.ServerAuthManager;
import com.hypixel.hytale.server.core.auth.SessionServiceClient;
import com.hypixel.hytale.server.core.update.UpdateModule;
import com.hypixel.hytale.server.core.update.UpdateService;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/**
 * GET /api/server/status: build, update and auth state straight from the
 * running server modules, so the panel no longer scrapes logs for them.
 *
 * <p>Never exposes credentials: no tokens, no signed download URL, no session
 * id. The auth block only reports which tokens exist and when they expire.</p>
 */
public final class ServerStatusCollector {

    public ServerStatus collect() {
        ServerStatus status = new ServerStatus();
        status.build = build();
        status.update = update(status.build.version);
        status.auth = auth();
        status.lifecycle = lifecycle();
        status.collectedAt = Instant.now().toString();
        return status;
    }

    private static Build build() {
        Build build = new Build();
        try {
            build.version = ManifestUtil.getImplementationVersion();
            build.revision = ManifestUtil.getImplementationRevisionId();
            build.patchline = ManifestUtil.getPatchline();
        } catch (Throwable ignored) {
            // Not running from a release jar (dev classpath): leave the fields unset.
        }
        return build;
    }

    private static Update update(String currentVersion) {
        Update update = new Update();
        update.currentVersion = currentVersion;
        try {
            update.patchline = UpdateService.getEffectivePatchline();
        } catch (Throwable ignored) {
            // Patchline resolution reads the server config; keep it unset if that fails.
        }
        try {
            update.stagedVersion = UpdateService.getStagedVersion();
        } catch (Throwable ignored) {
            // No staging directory or unreadable staged jar: nothing is staged.
        }

        UpdateModule module;
        try {
            module = UpdateModule.get();
        } catch (Throwable t) {
            module = null;
        }
        update.moduleEnabled = module != null && !UpdateModule.KILL_SWITCH_ENABLED;
        if (module == null) return update;

        UpdateService.VersionManifest latest = module.getLatestKnownVersion();
        if (latest != null && latest.version != null) {
            update.latestVersion = latest.version;
            update.available = !Objects.equals(latest.version, currentVersion)
                    && !Objects.equals(latest.version, update.stagedVersion);
        }
        update.downloading = module.isDownloadInProgress();
        UpdateModule.DownloadProgress progress = module.getDownloadProgress();
        if (update.downloading && progress != null) {
            Progress p = new Progress();
            p.percent = progress.percent();
            p.downloadedBytes = progress.downloadedBytes();
            p.totalBytes = progress.totalBytes();
            p.etaSeconds = progress.etaSeconds();
            update.progress = p;
        }
        return update;
    }

    private static Auth auth() {
        Auth auth = new Auth();
        ServerAuthManager manager;
        try {
            manager = ServerAuthManager.getInstance();
        } catch (Throwable t) {
            manager = null;
        }
        if (manager == null) return auth;

        auth.mode = manager.getAuthMode() == null ? null : manager.getAuthMode().name();
        auth.hasSessionToken = manager.hasSessionToken();
        auth.hasIdentityToken = manager.hasIdentityToken();
        auth.authenticated = auth.hasSessionToken && auth.hasIdentityToken;
        auth.singleplayer = manager.isSingleplayer();

        Instant expiry = manager.getTokenExpiry();
        if (expiry != null) {
            long seconds = Duration.between(Instant.now(), expiry).getSeconds();
            auth.tokenExpiresAt = expiry.toString();
            auth.expiresInSeconds = Math.max(0, seconds);
            auth.expired = seconds <= 0;
        }

        SessionServiceClient.GameProfile profile = manager.getSelectedProfile();
        if (profile != null) {
            auth.profileName = profile.username;
            auth.profileUuid = LiveFormat.uuid(profile.uuid);
        }
        // The server's own one-line summary ("MODE (authenticated) [expires in ..]"); token-free.
        auth.summary = manager.getAuthStatus();
        return auth;
    }

    private static Lifecycle lifecycle() {
        Lifecycle lifecycle = new Lifecycle();
        HytaleServer server = HytaleServer.get();
        if (server == null) return lifecycle;
        lifecycle.booted = server.isBooted();
        lifecycle.shuttingDown = server.isShuttingDown();
        lifecycle.bootedAt = LiveFormat.iso(server.getBoot());
        ShutdownReason reason = server.getShutdownReason();
        if (reason != null) {
            lifecycle.shutdownReason = reason.getName();
            lifecycle.shutdownMessage = LiveFormat.clip(reason.getMessage());
        }
        return lifecycle;
    }

    // Response classes (Gson omits null fields).

    public static class ServerStatus {
        public Build build;
        public Update update;
        public Auth auth;
        public Lifecycle lifecycle;
        public String collectedAt;
    }

    public static class Build {
        public String version;
        public String revision;
        public String patchline;
    }

    public static class Update {
        public boolean moduleEnabled;
        public String patchline;
        public String currentVersion;
        public String latestVersion;
        public boolean available;
        public String stagedVersion;
        public boolean downloading;
        public Progress progress;
    }

    public static class Progress {
        public int percent;
        public long downloadedBytes;
        public long totalBytes;
        public long etaSeconds;
    }

    public static class Auth {
        public String mode;
        public boolean authenticated;
        public boolean hasSessionToken;
        public boolean hasIdentityToken;
        public boolean singleplayer;
        public String tokenExpiresAt;
        public Long expiresInSeconds;
        public Boolean expired;
        public String profileName;
        public String profileUuid;
        public String summary;
    }

    public static class Lifecycle {
        public boolean booted;
        public boolean shuttingDown;
        public String bootedAt;
        public String shutdownReason;
        public String shutdownMessage;
    }
}
