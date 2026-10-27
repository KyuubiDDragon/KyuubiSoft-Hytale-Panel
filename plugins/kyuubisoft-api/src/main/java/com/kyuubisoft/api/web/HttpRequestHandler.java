package com.kyuubisoft.api.web;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import com.kyuubisoft.api.handlers.MetricsHandler;
import com.kyuubisoft.api.handlers.PlayersHandler;
import com.kyuubisoft.api.handlers.ServerHandler;
import com.kyuubisoft.api.handlers.WorldsHandler;
import com.kyuubisoft.api.live.LiveRoutes;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.handler.codec.http.*;
import io.netty.util.CharsetUtil;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Handles HTTP requests and routes them to appropriate handlers.
 * Authentication happens earlier in the pipeline ({@link AuthGate}); every
 * request that reaches this handler is already authorized.
 *
 * <p>Routes match against the decoded path without the query string. A
 * handler either returns its response object, or a {@link CompletionStage}
 * (e.g. work queued on a world thread) that is written once it completes, so
 * a Netty thread never waits for a world. Blocking work goes to
 * {@link #workers}. Failures map to HTTP status codes: {@link ApiException}
 * keeps its status, a timeout is 504, anything else 500 with a generic
 * message.</p>
 */
public class HttpRequestHandler extends SimpleChannelInboundHandler<FullHttpRequest> {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    // Route patterns - GET
    private static final Pattern PLAYERS_PATTERN = Pattern.compile("^/api/players(?:/([\\w-]+))?$");
    private static final Pattern PLAYER_DETAILS_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/details$");
    private static final Pattern WORLDS_PATTERN = Pattern.compile("^/api/worlds(?:/([\\w-]+))?$");
    private static final Pattern WORLD_STATS_PATTERN = Pattern.compile("^/api/worlds/([\\w-]+)/stats$");
    private static final Pattern WORLD_PERF_PATTERN = Pattern.compile("^/api/worlds/([\\w-]+)/perf$");
    private static final Pattern SERVER_INFO_PATTERN = Pattern.compile("^/api/server/info$");
    private static final Pattern SERVER_TPS_PATTERN = Pattern.compile("^/api/server/tps$");
    private static final Pattern SERVER_PERFORMANCE_PATTERN = Pattern.compile("^/api/server/performance$");
    private static final Pattern SERVER_MEMORY_PATTERN = Pattern.compile("^/api/server/memory$");
    private static final Pattern METRICS_PATTERN = Pattern.compile("^/metrics$");

    // Route patterns - POST (Player Actions)
    private static final Pattern PLAYER_HEAL_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/heal$");
    private static final Pattern PLAYER_RESPAWN_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/respawn$");
    private static final Pattern PLAYER_KILL_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/kill$");
    private static final Pattern PLAYER_TELEPORT_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/teleport$");
    private static final Pattern PLAYER_GAMEMODE_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/gamemode$");
    private static final Pattern PLAYER_INVENTORY_CLEAR_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/inventory/clear$");
    private static final Pattern PLAYER_GIVE_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/give$");

    private final PlayersHandler playersHandler = new PlayersHandler();
    private final WorldsHandler worldsHandler = new WorldsHandler();
    private final ServerHandler serverHandler = new ServerHandler();
    private MetricsHandler metricsHandler;
    private CorsPolicy corsPolicy;
    // Runs blocking handler work (command dispatch) off the Netty threads.
    // Falls back to the common pool if the server did not set one.
    private Executor workers = ForkJoinPool.commonPool();
    // Keep-alive decision and Origin header of the request currently being
    // processed. The handler is per-connection and Netty delivers requests
    // sequentially; reads pause while an asynchronous response is pending,
    // and the completion restores both fields on the event loop before it
    // writes, so single fields stay correct across keep-alive requests.
    private boolean keepAlive = false;
    private String requestOrigin = null;

    public void setMetricsHandler(MetricsHandler metricsHandler) {
        this.metricsHandler = metricsHandler;
    }

    public void setCorsPolicy(CorsPolicy corsPolicy) {
        this.corsPolicy = corsPolicy;
    }

    public void setWorkers(Executor workers) {
        if (workers != null) this.workers = workers;
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest request) {
        // Honor HTTP keep-alive so the panel can reuse connections instead of
        // a TCP handshake per poll. All responses set Content-Length already.
        this.keepAlive = HttpUtil.isKeepAlive(request);
        this.requestOrigin = request.headers().get(HttpHeaderNames.ORIGIN);

        // Route on the path only, so "/api/players?x=1" still finds its route.
        QueryStringDecoder decoder = new QueryStringDecoder(request.uri());
        String path = decoder.path();
        Map<String, List<String>> query = decoder.parameters();
        Object response = null;

        try {
            // Route the request based on HTTP method
            Matcher matcher;

            // /api/commands/*: commands with captured output, registry, completion
            if (CommandRoutes.handles(request.method(), path)) {
                sendResult(ctx, CommandRoutes.route(request, path, query));
                return;
            }

            // Live data: server status, plugins, access, permissions, sessions and
            // player live/inventory/appearance (world-thread reads, see live.LiveRoutes)
            if (LiveRoutes.handles(request.method(), path)) {
                sendResult(ctx, LiveRoutes.route(path));
                return;
            }

            // Handle POST requests (Player Actions)
            if (request.method() == HttpMethod.POST) {
                // POST /api/players/{name}/heal
                if ((matcher = PLAYER_HEAL_PATTERN.matcher(path)).matches()) {
                    String playerName = matcher.group(1);
                    response = onWorkers(() -> playersHandler.healPlayer(playerName));
                }
                // POST /api/players/{name}/respawn
                else if ((matcher = PLAYER_RESPAWN_PATTERN.matcher(path)).matches()) {
                    String playerName = matcher.group(1);
                    response = onWorkers(() -> playersHandler.respawnPlayer(playerName));
                }
                // POST /api/players/{name}/kill
                else if ((matcher = PLAYER_KILL_PATTERN.matcher(path)).matches()) {
                    String playerName = matcher.group(1);
                    response = onWorkers(() -> playersHandler.killPlayer(playerName));
                }
                // POST /api/players/{name}/teleport
                else if ((matcher = PLAYER_TELEPORT_PATTERN.matcher(path)).matches()) {
                    String playerName = matcher.group(1);
                    // Parse JSON body for teleport parameters
                    TeleportRequest teleportReq = readJson(request, TeleportRequest.class);
                    if (teleportReq != null) {
                        response = onWorkers(() -> playersHandler.teleportPlayer(playerName, teleportReq.x, teleportReq.y, teleportReq.z, teleportReq.target));
                    } else {
                        response = onWorkers(() -> playersHandler.teleportPlayer(playerName, null, null, null, null));
                    }
                }
                // POST /api/players/{name}/gamemode
                else if ((matcher = PLAYER_GAMEMODE_PATTERN.matcher(path)).matches()) {
                    String playerName = matcher.group(1);
                    GamemodeRequest gamemodeReq = readJson(request, GamemodeRequest.class);
                    if (gamemodeReq != null && gamemodeReq.gamemode != null) {
                        response = onWorkers(() -> playersHandler.setGamemode(playerName, gamemodeReq.gamemode));
                    } else {
                        sendError(ctx, HttpResponseStatus.BAD_REQUEST, "Gamemode required");
                        return;
                    }
                }
                // POST /api/players/{name}/inventory/clear
                else if ((matcher = PLAYER_INVENTORY_CLEAR_PATTERN.matcher(path)).matches()) {
                    String playerName = matcher.group(1);
                    response = onWorkers(() -> playersHandler.clearInventory(playerName));
                }
                // POST /api/players/{name}/give  { item, amount? }
                else if ((matcher = PLAYER_GIVE_PATTERN.matcher(path)).matches()) {
                    String playerName = matcher.group(1);
                    GiveRequest giveReq = readJson(request, GiveRequest.class);
                    if (giveReq != null && giveReq.item != null) {
                        response = onWorkers(() -> playersHandler.givePlayer(playerName, giveReq.item, giveReq.amount));
                    } else {
                        sendError(ctx, HttpResponseStatus.BAD_REQUEST, "Item required");
                        return;
                    }
                }
                else {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "POST endpoint not found: " + path);
                    return;
                }

                sendResult(ctx, response);
                return;
            }

            // Handle OPTIONS requests (CORS preflight)
            if (request.method() == HttpMethod.OPTIONS) {
                sendCorsResponse(ctx);
                return;
            }

            // Only handle GET requests for info endpoints
            if (request.method() != HttpMethod.GET) {
                sendError(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED);
                return;
            }

            // GET /api/players or /api/players/{world}
            if ((matcher = PLAYERS_PATTERN.matcher(path)).matches()) {
                String world = matcher.group(1);
                response = (world != null)
                        ? playersHandler.getPlayersInWorld(world)
                        : playersHandler.getAllPlayers();
            }
            // GET /api/players/{name}/details (read on the player's world thread)
            else if ((matcher = PLAYER_DETAILS_PATTERN.matcher(path)).matches()) {
                String playerName = matcher.group(1);
                response = playersHandler.getPlayerDetails(playerName);
            }
            // GET /api/worlds or /api/worlds/{name}
            else if ((matcher = WORLDS_PATTERN.matcher(path)).matches()) {
                String worldName = matcher.group(1);
                response = (worldName != null)
                        ? worldsHandler.getWorld(worldName)
                        : worldsHandler.getAllWorlds();
                if (worldName != null && response == null) {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "World not found");
                    return;
                }
            }
            // GET /api/worlds/{name}/stats
            else if ((matcher = WORLD_STATS_PATTERN.matcher(path)).matches()) {
                String worldName = matcher.group(1);
                response = worldsHandler.getWorldStats(worldName);
                if (response == null) {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "World not found");
                    return;
                }
            }
            // GET /api/worlds/{name}/perf - tick metrics of one world
            else if ((matcher = WORLD_PERF_PATTERN.matcher(path)).matches()) {
                String worldName = matcher.group(1);
                response = worldsHandler.getWorldPerf(worldName);
                if (response == null) {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "World not found");
                    return;
                }
            }
            // GET /api/server/info
            else if (SERVER_INFO_PATTERN.matcher(path).matches()) {
                response = serverHandler.getServerInfo();
            }
            // GET /api/server/tps - tick metrics of every world
            else if (SERVER_TPS_PATTERN.matcher(path).matches()) {
                response = serverHandler.getTps();
            }
            // GET /api/server/performance
            else if (SERVER_PERFORMANCE_PATTERN.matcher(path).matches()) {
                response = serverHandler.getPerformance();
            }
            // GET /api/server/memory
            else if (SERVER_MEMORY_PATTERN.matcher(path).matches()) {
                response = serverHandler.getMemory();
            }
            // GET /metrics - Prometheus format
            else if (METRICS_PATTERN.matcher(path).matches()) {
                if (metricsHandler != null) {
                    sendPrometheusMetrics(ctx);
                    return;
                } else {
                    sendError(ctx, HttpResponseStatus.SERVICE_UNAVAILABLE, "Metrics not initialized");
                    return;
                }
            }
            // Not found
            else {
                sendError(ctx, HttpResponseStatus.NOT_FOUND, "Endpoint not found: " + path);
                return;
            }

            sendResult(ctx, response);

        } catch (Exception e) {
            sendFailure(ctx, path, e);
        }
    }

    /**
     * Run blocking handler work (e.g. a command dispatch that waits for its
     * result) on the worker pool instead of the Netty thread.
     */
    private <T> CompletableFuture<T> onWorkers(Supplier<T> task) {
        return CompletableFuture.supplyAsync(task, workers);
    }

    /**
     * Parse the request body as JSON. An empty body gives null; a body that is
     * not valid JSON for {@code type} is a 400, without echoing parser details.
     */
    static <T> T readJson(FullHttpRequest request, Class<T> type) {
        String body = request.content().toString(CharsetUtil.UTF_8);
        if (body.isBlank()) return null;
        try {
            return GSON.fromJson(body, type);
        } catch (JsonParseException e) {
            throw new ApiException(400, "Invalid JSON body");
        }
    }

    /** First value of a query parameter, or null. */
    static String queryParam(Map<String, List<String>> query, String name) {
        List<String> values = query.getOrDefault(name, Collections.emptyList());
        return values.isEmpty() ? null : values.get(0);
    }

    /**
     * Write a handler result: plain objects right away, a {@link CompletionStage}
     * once it completes. While it is pending the channel reads nothing more,
     * so a keep-alive client cannot get answers out of order.
     */
    private void sendResult(ChannelHandlerContext ctx, Object response) {
        if (!(response instanceof CompletionStage<?> stage)) {
            sendJson(ctx, response, HttpResponseStatus.OK);
            return;
        }
        final boolean requestKeepAlive = this.keepAlive;
        final String origin = this.requestOrigin;
        ctx.channel().config().setAutoRead(false);
        stage.whenComplete((value, error) -> ctx.executor().execute(() -> {
            try {
                this.keepAlive = requestKeepAlive;
                this.requestOrigin = origin;
                if (error != null) {
                    sendFailure(ctx, null, error);
                } else if (value == null) {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "Not found");
                } else {
                    sendJson(ctx, value, HttpResponseStatus.OK);
                }
            } finally {
                ctx.channel().config().setAutoRead(true);
            }
        }));
    }

    /** Map a failure to a status; only ApiException messages reach the client. */
    private void sendFailure(ChannelHandlerContext ctx, String path, Throwable error) {
        Throwable cause = error;
        while ((cause instanceof CompletionException || cause instanceof ExecutionException)
                && cause.getCause() != null) {
            cause = cause.getCause();
        }
        if (cause instanceof ApiException api) {
            sendError(ctx, HttpResponseStatus.valueOf(api.getStatus()), api.getMessage());
        } else if (cause instanceof TimeoutException) {
            sendError(ctx, HttpResponseStatus.GATEWAY_TIMEOUT, "The server did not answer in time");
        } else {
            LOGGER.log(Level.WARNING, "Error handling request" + (path != null ? " " + path : ""), cause);
            sendError(ctx, HttpResponseStatus.INTERNAL_SERVER_ERROR, "Internal server error");
        }
    }

    private void sendJson(ChannelHandlerContext ctx, Object data, HttpResponseStatus status) {
        String json = GSON.toJson(data);
        ByteBuf content = Unpooled.copiedBuffer(json, CharsetUtil.UTF_8);

        FullHttpResponse response = new DefaultFullHttpResponse(
                HttpVersion.HTTP_1_1, status, content);

        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/json; charset=UTF-8");
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, content.readableBytes());

        applyCors(response.headers());

        writeResponse(ctx, response);
    }

    /** Apply CORS headers when the request comes from an allow-listed origin (CORS is off by default). */
    private void applyCors(HttpHeaders headers) {
        if (corsPolicy == null) return;
        corsPolicy.apply(headers, requestOrigin);
    }

    /**
     * Flush a response, honoring the keep-alive decision made for the current
     * request. When the client asked to keep the connection open we set the
     * Connection header accordingly and leave the channel open for reuse;
     * otherwise we close it once the write completes (the legacy behavior).
     */
    private void writeResponse(ChannelHandlerContext ctx, FullHttpResponse response) {
        if (keepAlive) {
            HttpUtil.setKeepAlive(response, true);
            ctx.writeAndFlush(response);
        } else {
            HttpUtil.setKeepAlive(response, false);
            ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
        }
    }

    private void sendError(ChannelHandlerContext ctx, HttpResponseStatus status) {
        sendError(ctx, status, status.reasonPhrase());
    }

    private void sendError(ChannelHandlerContext ctx, HttpResponseStatus status, String message) {
        ErrorResponse error = new ErrorResponse(status.code(), message);
        sendJson(ctx, error, status);
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        LOGGER.warning("Exception in HTTP handler: " + cause.getMessage());
        ctx.close();
    }

    private void sendCorsResponse(ChannelHandlerContext ctx) {
        FullHttpResponse response = new DefaultFullHttpResponse(
                HttpVersion.HTTP_1_1, HttpResponseStatus.OK, Unpooled.EMPTY_BUFFER);

        applyCors(response.headers());
        response.headers().set(HttpHeaderNames.ACCESS_CONTROL_MAX_AGE, 86400);
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0);

        writeResponse(ctx, response);
    }

    private void sendPrometheusMetrics(ChannelHandlerContext ctx) {
        String metrics = metricsHandler.getMetrics();
        ByteBuf content = Unpooled.copiedBuffer(metrics, CharsetUtil.UTF_8);

        FullHttpResponse response = new DefaultFullHttpResponse(
                HttpVersion.HTTP_1_1, HttpResponseStatus.OK, content);

        response.headers().set(HttpHeaderNames.CONTENT_TYPE, metricsHandler.getContentType());
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, content.readableBytes());

        applyCors(response.headers());

        writeResponse(ctx, response);
    }

    /**
     * Error response structure
     */
    private static class ErrorResponse {
        public final int status;
        public final String error;

        public ErrorResponse(int status, String error) {
            this.status = status;
            this.error = error;
        }
    }

    /**
     * Request body for teleport
     */
    private static class TeleportRequest {
        public Double x;
        public Double y;
        public Double z;
        public String target;
    }

    /**
     * Request body for gamemode
     */
    private static class GamemodeRequest {
        public String gamemode;
    }

    /**
     * Request body for give
     */
    private static class GiveRequest {
        public String item;
        public Integer amount;
    }
}
