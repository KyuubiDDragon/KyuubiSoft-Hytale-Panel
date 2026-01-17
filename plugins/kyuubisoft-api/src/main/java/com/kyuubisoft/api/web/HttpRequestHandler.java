package com.kyuubisoft.api.web;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.kyuubisoft.api.KyuubiSoftAPI;
import com.kyuubisoft.api.handlers.PlayersHandler;
import com.kyuubisoft.api.handlers.ServerHandler;
import com.kyuubisoft.api.handlers.WorldsHandler;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.handler.codec.http.*;
import io.netty.util.CharsetUtil;

import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Handles HTTP requests and routes them to appropriate handlers
 */
public class HttpRequestHandler extends SimpleChannelInboundHandler<FullHttpRequest> {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    // Route patterns
    private static final Pattern PLAYERS_PATTERN = Pattern.compile("^/api/players(?:/([\\w-]+))?$");
    private static final Pattern PLAYER_DETAILS_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/details$");
    private static final Pattern PLAYER_INVENTORY_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/inventory$");
    private static final Pattern PLAYER_APPEARANCE_PATTERN = Pattern.compile("^/api/players/([\\w-]+)/appearance$");
    private static final Pattern WORLDS_PATTERN = Pattern.compile("^/api/worlds(?:/([\\w-]+))?$");
    private static final Pattern WORLD_STATS_PATTERN = Pattern.compile("^/api/worlds/([\\w-]+)/stats$");
    private static final Pattern SERVER_INFO_PATTERN = Pattern.compile("^/api/server/info$");
    private static final Pattern SERVER_PERFORMANCE_PATTERN = Pattern.compile("^/api/server/performance$");
    private static final Pattern SERVER_MEMORY_PATTERN = Pattern.compile("^/api/server/memory$");

    private final PlayersHandler playersHandler = new PlayersHandler();
    private final WorldsHandler worldsHandler = new WorldsHandler();
    private final ServerHandler serverHandler = new ServerHandler();

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest request) {
        // Skip WebSocket upgrade requests
        if (request.uri().equals("/ws")) {
            ctx.fireChannelRead(request.retain());
            return;
        }

        // Only handle GET requests for now
        if (request.method() != HttpMethod.GET) {
            sendError(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED);
            return;
        }

        String uri = request.uri();
        Object response = null;
        HttpResponseStatus status = HttpResponseStatus.OK;

        try {
            // Route the request
            Matcher matcher;

            // GET /api/players or /api/players/{world}
            if ((matcher = PLAYERS_PATTERN.matcher(uri)).matches()) {
                String world = matcher.group(1);
                response = (world != null)
                        ? playersHandler.getPlayersInWorld(world)
                        : playersHandler.getAllPlayers();
            }
            // GET /api/players/{name}/details
            else if ((matcher = PLAYER_DETAILS_PATTERN.matcher(uri)).matches()) {
                String playerName = matcher.group(1);
                response = playersHandler.getPlayerDetails(playerName);
                if (response == null) {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "Player not found");
                    return;
                }
            }
            // GET /api/players/{name}/inventory
            else if ((matcher = PLAYER_INVENTORY_PATTERN.matcher(uri)).matches()) {
                String playerName = matcher.group(1);
                response = playersHandler.getPlayerInventory(playerName);
                if (response == null) {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "Player not found");
                    return;
                }
            }
            // GET /api/players/{name}/appearance
            else if ((matcher = PLAYER_APPEARANCE_PATTERN.matcher(uri)).matches()) {
                String playerName = matcher.group(1);
                response = playersHandler.getPlayerAppearance(playerName);
                if (response == null) {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "Player not found");
                    return;
                }
            }
            // GET /api/worlds or /api/worlds/{name}
            else if ((matcher = WORLDS_PATTERN.matcher(uri)).matches()) {
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
            else if ((matcher = WORLD_STATS_PATTERN.matcher(uri)).matches()) {
                String worldName = matcher.group(1);
                response = worldsHandler.getWorldStats(worldName);
                if (response == null) {
                    sendError(ctx, HttpResponseStatus.NOT_FOUND, "World not found");
                    return;
                }
            }
            // GET /api/server/info
            else if (SERVER_INFO_PATTERN.matcher(uri).matches()) {
                response = serverHandler.getServerInfo();
            }
            // GET /api/server/performance
            else if (SERVER_PERFORMANCE_PATTERN.matcher(uri).matches()) {
                response = serverHandler.getPerformance();
            }
            // GET /api/server/memory
            else if (SERVER_MEMORY_PATTERN.matcher(uri).matches()) {
                response = serverHandler.getMemory();
            }
            // Not found
            else {
                sendError(ctx, HttpResponseStatus.NOT_FOUND, "Endpoint not found: " + uri);
                return;
            }

            sendJson(ctx, response, status);

        } catch (Exception e) {
            LOGGER.warning("Error handling request " + uri + ": " + e.getMessage());
            e.printStackTrace();
            sendError(ctx, HttpResponseStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }

    private void sendJson(ChannelHandlerContext ctx, Object data, HttpResponseStatus status) {
        String json = GSON.toJson(data);
        ByteBuf content = Unpooled.copiedBuffer(json, CharsetUtil.UTF_8);

        FullHttpResponse response = new DefaultFullHttpResponse(
                HttpVersion.HTTP_1_1, status, content);

        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/json; charset=UTF-8");
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, content.readableBytes());

        // CORS headers
        response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, "*");
        response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS");
        response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_HEADERS, "Content-Type, Authorization");

        ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
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
}
