package com.kyuubisoft.api.web;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.kyuubisoft.api.panel.PanelAction;
import com.kyuubisoft.api.panel.PanelRegistry;
import com.kyuubisoft.api.panel.PanelRequest;
import com.kyuubisoft.api.panel.internal.PanelRuntime;
import com.kyuubisoft.api.panel.internal.PanelWire;
import com.kyuubisoft.api.panel.internal.ProviderIndex;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandler;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.FullHttpResponse;
import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpMethod;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.HttpUtil;
import io.netty.handler.codec.http.HttpVersion;
import io.netty.handler.codec.http.QueryStringDecoder;
import io.netty.util.CharsetUtil;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * HTTP side of the mod panel registry ({@link PanelRegistry}). Sits in the pipeline in front of
 * {@link HttpRequestHandler}, takes the paths below {@code /api/mods/panel} and hands everything
 * else (including CORS preflights) on. Replies to mod calls are written once the worker finished,
 * so a slow mod never holds a Netty thread.
 *
 * <ul>
 *   <li>{@code GET /api/mods/panel}: registered providers with their actions</li>
 *   <li>{@code GET /api/mods/panel/{id}}: one provider's snapshot</li>
 *   <li>{@code POST /api/mods/panel/{id}/actions/{actionId}} {@code {params?, confirmed?}}: runs an action</li>
 * </ul>
 *
 * <p>The panel passes the acting account in {@code X-Panel-Actor} and its UI language in
 * {@code Accept-Language}; both are informational for the mod. Channel exceptions are left to
 * {@link HttpRequestHandler} further down the pipeline.</p>
 */
@ChannelHandler.Sharable
public final class ModPanelHttpHandler extends SimpleChannelInboundHandler<FullHttpRequest> {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    static final String BASE_PATH = "/api/mods/panel";
    private static final Pattern PROVIDER_PATH = Pattern.compile("^/api/mods/panel/([^/]+)$");
    private static final Pattern ACTION_PATH = Pattern.compile("^/api/mods/panel/([^/]+)/actions/([^/]+)$");
    private static final Pattern ACTOR = Pattern.compile("[\\w.@-]{1,64}");
    private static final Pattern LOCALE = Pattern.compile("[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?");

    static final String CODE_NOT_FOUND = "not_found";
    static final String CODE_INVALID_BODY = "invalid_body";
    static final String CODE_INVALID_PARAMS = "invalid_params";
    static final String CODE_CONFIRMATION_REQUIRED = "confirmation_required";
    static final String CODE_UNAVAILABLE = "mod_panel_unavailable";

    private final CorsPolicy cors;

    public ModPanelHttpHandler(CorsPolicy cors) {
        this.cors = cors;
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest request) {
        String path = new QueryStringDecoder(request.uri()).path();
        boolean ours = path.equals(BASE_PATH) || path.startsWith(BASE_PATH + "/");
        if (!ours || request.method() == HttpMethod.OPTIONS) {
            ctx.fireChannelRead(request.retain());
            return;
        }
        Reply reply = new Reply(ctx, HttpUtil.isKeepAlive(request), request.headers().get(HttpHeaderNames.ORIGIN), cors);
        try {
            route(path, request, reply);
        } catch (RuntimeException e) {
            LOGGER.warning("Mod panel request " + request.method() + " " + PanelWire.clip(path, 120) + " failed: " + e);
            reply.error(HttpResponseStatus.INTERNAL_SERVER_ERROR, "Internal error", null);
        }
    }

    private void route(String path, FullHttpRequest request, Reply reply) {
        PanelRuntime runtime = PanelRuntime.current();
        if (runtime == null) {
            reply.error(HttpResponseStatus.SERVICE_UNAVAILABLE, "Mod panel not running", CODE_UNAVAILABLE);
            return;
        }
        HttpMethod method = request.method();
        Matcher matcher;

        if (path.equals(BASE_PATH)) {
            if (method != HttpMethod.GET) {
                reply.error(HttpResponseStatus.METHOD_NOT_ALLOWED, "Use GET", null);
                return;
            }
            reply.json(HttpResponseStatus.OK, listing());
        } else if ((matcher = PROVIDER_PATH.matcher(path)).matches()) {
            if (method != HttpMethod.GET) {
                reply.error(HttpResponseStatus.METHOD_NOT_ALLOWED, "Use GET", null);
                return;
            }
            Optional<ProviderIndex.Registered> entry = provider(matcher.group(1));
            if (entry.isEmpty()) {
                reply.error(HttpResponseStatus.NOT_FOUND, "Unknown provider", CODE_NOT_FOUND);
                return;
            }
            reply.later(runtime.snapshot(entry.get(), new PanelRequest(actor(request), locale(request), null)));
        } else if ((matcher = ACTION_PATH.matcher(path)).matches()) {
            if (method != HttpMethod.POST) {
                reply.error(HttpResponseStatus.METHOD_NOT_ALLOWED, "Use POST", null);
                return;
            }
            Optional<ProviderIndex.Registered> entry = provider(matcher.group(1));
            String actionId = matcher.group(2);
            Optional<PanelAction> action = entry.flatMap(e -> e.action(actionId));
            if (action.isEmpty()) {
                reply.error(HttpResponseStatus.NOT_FOUND, "Unknown provider or action", CODE_NOT_FOUND);
                return;
            }
            runAction(runtime, entry.get(), action.get(), request, reply);
        } else {
            reply.error(HttpResponseStatus.NOT_FOUND, "Endpoint not found", CODE_NOT_FOUND);
        }
    }

    private static void runAction(PanelRuntime runtime, ProviderIndex.Registered entry, PanelAction action,
                                  FullHttpRequest request, Reply reply) {
        JsonObject body;
        try {
            body = readBody(request);
        } catch (JsonParseException | IllegalStateException e) {
            reply.error(HttpResponseStatus.BAD_REQUEST, "Body must be a JSON object", CODE_INVALID_BODY);
            return;
        }
        JsonElement params = body.get("params");
        if (params != null && !params.isJsonNull() && !params.isJsonObject()) {
            reply.error(HttpResponseStatus.BAD_REQUEST, "params must be an object", CODE_INVALID_BODY);
            return;
        }
        JsonElement confirmed = body.get("confirmed");
        boolean isConfirmed = confirmed != null && confirmed.isJsonPrimitive()
                && confirmed.getAsJsonPrimitive().isBoolean() && confirmed.getAsBoolean();
        if (action.requiresConfirmation() && !isConfirmed) {
            reply.error(HttpResponseStatus.CONFLICT, "This action has to be confirmed", CODE_CONFIRMATION_REQUIRED);
            return;
        }
        PanelWire.ParamCheck check = PanelWire.checkParams(action,
                params != null && params.isJsonObject() ? params.getAsJsonObject() : null);
        if (!check.isOk()) {
            reply.error(HttpResponseStatus.BAD_REQUEST, check.error(), CODE_INVALID_PARAMS);
            return;
        }
        reply.later(runtime.action(entry, action, new PanelRequest(actor(request), locale(request), check.values())));
    }

    private static Map<String, Object> listing() {
        List<Map<String, Object>> providers = new ArrayList<>();
        for (ProviderIndex.Registered entry : ProviderIndex.list()) providers.add(PanelWire.provider(entry));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("apiVersion", PanelRegistry.apiVersion());
        out.put("snapshotTimeoutMs", PanelRuntime.SNAPSHOT_TIMEOUT_MS);
        out.put("actionTimeoutMs", PanelRuntime.ACTION_TIMEOUT_MS);
        out.put("providers", providers);
        return out;
    }

    private static Optional<ProviderIndex.Registered> provider(String id) {
        return PanelWire.isValidProviderId(id) ? ProviderIndex.get(id) : Optional.empty();
    }

    private static JsonObject readBody(FullHttpRequest request) {
        String text = request.content().toString(CharsetUtil.UTF_8).trim();
        if (text.isEmpty()) return new JsonObject();
        return JsonParser.parseString(text).getAsJsonObject();
    }

    private static String actor(FullHttpRequest request) {
        String value = request.headers().get("X-Panel-Actor");
        return value != null && ACTOR.matcher(value.trim()).matches() ? value.trim() : null;
    }

    /** First language tag of {@code Accept-Language}, or null. */
    private static String locale(FullHttpRequest request) {
        String value = request.headers().get(HttpHeaderNames.ACCEPT_LANGUAGE);
        if (value == null) return null;
        String first = value.split("[,;]", 2)[0].trim();
        return LOCALE.matcher(first).matches() ? first : null;
    }

    /** Writes the response for one request; remembers its keep-alive and Origin. */
    private static final class Reply {
        private final ChannelHandlerContext ctx;
        private final boolean keepAlive;
        private final String origin;
        private final CorsPolicy cors;

        Reply(ChannelHandlerContext ctx, boolean keepAlive, String origin, CorsPolicy cors) {
            this.ctx = ctx;
            this.keepAlive = keepAlive;
            this.origin = origin;
            this.cors = cors;
        }

        /** Writes the body once the future completes; reading pauses until then. */
        void later(CompletableFuture<Map<String, Object>> future) {
            ctx.channel().config().setAutoRead(false);
            future.whenComplete((body, error) -> ctx.executor().execute(() -> {
                try {
                    if (error != null) {
                        LOGGER.warning("Mod panel call failed: " + error);
                        error(HttpResponseStatus.INTERNAL_SERVER_ERROR, "Internal error", null);
                    } else {
                        json(HttpResponseStatus.OK, body);
                    }
                } catch (RuntimeException e) {
                    // e.g. a value Gson cannot write: answer instead of leaving the client hanging
                    LOGGER.warning("Mod panel reply could not be written: " + e);
                    error(HttpResponseStatus.INTERNAL_SERVER_ERROR, "Internal error", null);
                } finally {
                    ctx.channel().config().setAutoRead(true);
                }
            }));
        }

        void error(HttpResponseStatus status, String message, String code) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("status", status.code());
            body.put("error", message);
            if (code != null) body.put("code", code);
            json(status, body);
        }

        void json(HttpResponseStatus status, Object body) {
            ByteBuf content = Unpooled.copiedBuffer(GSON.toJson(body), CharsetUtil.UTF_8);
            FullHttpResponse response = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, content);
            response.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/json; charset=UTF-8");
            response.headers().set(HttpHeaderNames.CONTENT_LENGTH, content.readableBytes());
            if (cors != null) cors.apply(response.headers(), origin);
            if (keepAlive) {
                HttpUtil.setKeepAlive(response, true);
                ctx.writeAndFlush(response);
            } else {
                HttpUtil.setKeepAlive(response, false);
                ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
            }
        }
    }
}
