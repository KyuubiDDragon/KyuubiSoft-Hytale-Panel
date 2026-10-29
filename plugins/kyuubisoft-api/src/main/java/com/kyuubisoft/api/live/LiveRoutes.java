package com.kyuubisoft.api.live;

import com.hypixel.hytale.server.core.NameMatching;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.kyuubisoft.api.web.ApiException;
import io.netty.handler.codec.http.HttpMethod;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Read-only live-data endpoints. Each returns a future of the response body
 * that the HTTP handler writes once it completes; module calls run on the
 * live-data workers and component reads on the player's world thread, so no
 * Netty thread waits.
 *
 * <ul>
 *   <li>{@code GET /api/server/status}: build, update, auth and lifecycle state</li>
 *   <li>{@code GET /api/plugins}: every plugin/mod with load state, version, error</li>
 *   <li>{@code GET /api/access/whitelist}, {@code GET /api/access/bans}</li>
 *   <li>{@code GET /api/permissions/groups}, {@code GET /api/permissions/users},
 *       {@code GET /api/permissions/users/{uuid}}</li>
 *   <li>{@code GET /api/sessions}: online sessions (world, join time, ping, groups)</li>
 *   <li>{@code GET /api/players/{name|uuid}/live|inventory|appearance}</li>
 * </ul>
 *
 * Errors are {@link ApiException}s: 404 player offline, 409 player changing
 * worlds, 501 data the server build does not offer, 503 module not ready.
 */
public final class LiveRoutes {

    private static final Set<String> FIXED_PATHS = Set.of(
            "/api/server/status", "/api/plugins", "/api/access/whitelist", "/api/access/bans",
            "/api/permissions/groups", "/api/permissions/users", "/api/sessions");
    private static final Pattern PLAYER_ROUTE =
            Pattern.compile("^/api/players/([\\w-]{1,36})/(live|inventory|appearance)$");
    private static final Pattern PERMISSION_USER = Pattern.compile("^/api/permissions/users/([^/]+)$");
    private static final Pattern PLAYER_NAME = Pattern.compile("[\\w-]{1,32}");

    private LiveRoutes() {
    }

    /** True for the GET routes above; other methods keep the caller's 404/405 handling. */
    public static boolean handles(HttpMethod method, String path) {
        if (method != HttpMethod.GET || path == null) return false;
        return FIXED_PATHS.contains(path)
                || PERMISSION_USER.matcher(path).matches()
                || PLAYER_ROUTE.matcher(path).matches();
    }

    /**
     * Route a request {@link #handles} accepted.
     *
     * @return a future of the response body
     * @throws ApiException for a request that cannot be served
     */
    public static CompletableFuture<?> route(String path) {
        LiveDataModule module = LiveDataModule.get();
        if (module == null) throw new ApiException(503, "Live data is not initialized");
        switch (path) {
            case "/api/server/status":
                return module.supply(() -> module.status().collect());
            case "/api/plugins":
                return module.supply(() -> module.plugins().collect());
            case "/api/access/whitelist":
                return module.supply(() -> required(module.access().whitelist(), "Access control"));
            case "/api/access/bans":
                return module.supply(() -> required(module.access().bans(), "Access control"));
            case "/api/permissions/groups":
                return module.supply(() -> required(module.permissions().groups(), "Permissions"));
            case "/api/permissions/users":
                return module.supply(() -> required(module.permissions().users(), "Permissions"));
            case "/api/sessions":
                return module.supply(() -> sessions(module));
            default:
                break;
        }
        Matcher user = PERMISSION_USER.matcher(path);
        if (user.matches()) {
            UUID uuid = parseUuid(user.group(1));
            if (uuid == null) throw new ApiException(400, "Invalid UUID");
            return module.supply(() -> required(module.permissions().user(uuid), "Permissions"));
        }
        Matcher player = PLAYER_ROUTE.matcher(path);
        if (player.matches()) {
            return playerRoute(module, player.group(1), player.group(2));
        }
        throw new ApiException(404, "Endpoint not found");
    }

    private static CompletableFuture<?> playerRoute(LiveDataModule module, String key, String what) {
        PlayerLiveReader reader = module.players();
        Supplier<PlayerRef> lookup = () -> {
            PlayerRef player = findPlayer(key);
            if (player == null) throw new ApiException(404, "Player is not online");
            return player;
        };
        switch (what) {
            case "inventory":
                return module.supply(lookup).thenCompose(reader::inventory);
            case "appearance":
                return module.supply(lookup).thenCompose(reader::live).thenApply(LiveRoutes::appearance);
            default:
                return module.supply(lookup).thenCompose(reader::live);
        }
    }

    private static SessionsResponse sessions(LiveDataModule module) {
        SessionsResponse response = new SessionsResponse();
        response.sessions = new ArrayList<>();
        for (PlayerRef ref : Universe.get().getPlayers()) {
            response.sessions.add(module.players().session(ref));
        }
        response.sessions.sort((a, b) -> String.CASE_INSENSITIVE_ORDER.compare(a.name, b.name));
        response.count = response.sessions.size();
        return response;
    }

    private static AppearanceResponse appearance(PlayerLiveReader.LiveSnapshot snap) {
        if (snap.appearance == null) throw new ApiException(501, "The server keeps no skin data for this player");
        AppearanceResponse response = new AppearanceResponse();
        response.uuid = snap.uuid;
        response.name = snap.name;
        response.skin = snap.appearance;
        return response;
    }

    /** A collector returns null when its server module is not loaded: say so instead of an empty list. */
    private static <T> T required(T body, String moduleName) {
        if (body == null) throw new ApiException(501, moduleName + " module is not loaded on this server");
        return body;
    }

    private static PlayerRef findPlayer(String key) {
        Universe universe = Universe.get();
        UUID uuid = parseUuid(key);
        if (uuid != null) return universe.getPlayer(uuid);
        if (!PLAYER_NAME.matcher(key).matches()) return null;
        return universe.getPlayerByUsername(key, NameMatching.EXACT_IGNORE_CASE);
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.length() != 36) return null;
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    public static class SessionsResponse {
        public int count;
        public List<PlayerLiveReader.SessionInfo> sessions;
    }

    public static class AppearanceResponse {
        public String uuid;
        public String name;
        public Map<String, String> skin;
    }
}
