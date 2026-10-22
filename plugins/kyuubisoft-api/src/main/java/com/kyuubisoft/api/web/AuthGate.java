package com.kyuubisoft.api.web;

import com.google.gson.Gson;
import com.kyuubisoft.api.config.ApiConfig;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandler;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.handler.codec.http.*;
import io.netty.util.CharsetUtil;
import io.netty.util.ReferenceCountUtil;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;

/**
 * Bearer-token gate for every HTTP route and the WebSocket upgrade.
 *
 * <p>Sits in front of {@code WebSocketServerProtocolHandler}: an upgrade
 * request without a valid token is answered with 401 and never gets a 101.
 * Fail-closed: without a usable token every request gets 503 with code
 * {@code auth_not_configured}. The only request let through without a token
 * is a CORS preflight from an allow-listed origin, which carries no data.
 * With {@code insecureDisableAuth} no token is needed, but only GET, HEAD and
 * OPTIONS pass; everything else gets 403 {@code auth_disabled_read_only}.</p>
 */
@ChannelHandler.Sharable
public final class AuthGate extends ChannelInboundHandlerAdapter {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final Gson GSON = new Gson();
    private static final String BEARER_PREFIX = "Bearer ";
    private static final long REJECT_LOG_INTERVAL_MS = 60_000;
    private static final int MAX_LOGGED_PATH = 120;

    static final String CODE_INVALID = "auth_invalid";
    static final String CODE_NOT_CONFIGURED = "auth_not_configured";
    static final String CODE_READ_ONLY = "auth_disabled_read_only";

    enum Decision { ALLOW, REJECT_INVALID, REJECT_NOT_CONFIGURED, REJECT_READ_ONLY }

    private final boolean authDisabled;
    private final byte[] expectedDigest; // null when no usable token is configured
    private final CorsPolicy cors;
    private final AtomicLong lastRejectLog = new AtomicLong();

    public AuthGate(ApiConfig config, CorsPolicy cors) {
        this.authDisabled = config.isAuthDisabled();
        this.expectedDigest = config.hasUsableToken() ? sha256(config.getAuthToken()) : null;
        this.cors = cors;
    }

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        // After the WebSocket upgrade only frames pass through here.
        if (!(msg instanceof FullHttpRequest request)) {
            ctx.fireChannelRead(msg);
            return;
        }

        Decision decision = decide(request);
        if (decision == Decision.ALLOW) {
            ctx.fireChannelRead(msg);
            return;
        }

        String origin = request.headers().get(HttpHeaderNames.ORIGIN);
        logRejection(ctx, request, decision);
        ReferenceCountUtil.release(msg);
        if (decision == Decision.REJECT_NOT_CONFIGURED) {
            reject(ctx, origin, HttpResponseStatus.SERVICE_UNAVAILABLE, CODE_NOT_CONFIGURED,
                    "API locked: no auth token configured");
        } else if (decision == Decision.REJECT_READ_ONLY) {
            reject(ctx, origin, HttpResponseStatus.FORBIDDEN, CODE_READ_ONLY,
                    "insecureDisableAuth is true: the API is read-only (GET, HEAD and OPTIONS only)");
        } else {
            reject(ctx, origin, HttpResponseStatus.UNAUTHORIZED, CODE_INVALID, "Unauthorized");
        }
    }

    Decision decide(HttpRequest request) {
        // Without a token nothing proves the caller is the panel; a web page in
        // a developer's browser can send simple cross-site POSTs. Only reads
        // stay open then: no commands, player actions or mod actions.
        if (authDisabled) return isReadOnly(request.method()) ? Decision.ALLOW : Decision.REJECT_READ_ONLY;
        if (request.method() == HttpMethod.OPTIONS
                && cors.isAllowed(request.headers().get(HttpHeaderNames.ORIGIN))) {
            return Decision.ALLOW;
        }
        if (expectedDigest == null) return Decision.REJECT_NOT_CONFIGURED;

        String provided = bearerToken(request.headers());
        if (provided == null) return Decision.REJECT_INVALID;
        // Comparing fixed-length digests keeps the check constant-time even
        // for tokens of a different length.
        return MessageDigest.isEqual(sha256(provided), expectedDigest)
                ? Decision.ALLOW
                : Decision.REJECT_INVALID;
    }

    static boolean isReadOnly(HttpMethod method) {
        return method == HttpMethod.GET || method == HttpMethod.HEAD || method == HttpMethod.OPTIONS;
    }

    /** Token from {@code Authorization: Bearer <token>}, or null. */
    static String bearerToken(HttpHeaders headers) {
        String header = headers.get(HttpHeaderNames.AUTHORIZATION);
        if (header == null) return null;
        String value = header.trim();
        if (!value.regionMatches(true, 0, BEARER_PREFIX, 0, BEARER_PREFIX.length())) return null;
        String token = value.substring(BEARER_PREFIX.length()).trim();
        return token.isEmpty() ? null : token;
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            // Every JRE ships SHA-256; without it the API must not open.
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    private void reject(ChannelHandlerContext ctx, String origin, HttpResponseStatus status, String code, String message) {
        String json = GSON.toJson(new ErrorBody(status.code(), message, code));
        ByteBuf content = Unpooled.copiedBuffer(json, CharsetUtil.UTF_8);
        FullHttpResponse response = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, content);
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/json; charset=UTF-8");
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, content.readableBytes());
        if (status == HttpResponseStatus.UNAUTHORIZED) {
            response.headers().set(HttpHeaderNames.WWW_AUTHENTICATE, "Bearer realm=\"KyuubiSoftAPI\"");
        }
        cors.apply(response.headers(), origin);
        HttpUtil.setKeepAlive(response, false);
        ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE);
    }

    /** At most one warning per minute, so a scanner cannot flood the server log. */
    private void logRejection(ChannelHandlerContext ctx, HttpRequest request, Decision decision) {
        long now = System.currentTimeMillis();
        long last = lastRejectLog.get();
        if (now - last < REJECT_LOG_INTERVAL_MS || !lastRejectLog.compareAndSet(last, now)) return;
        String reason = switch (decision) {
            case REJECT_NOT_CONFIGURED -> "no token configured";
            case REJECT_READ_ONLY -> "insecureDisableAuth allows reads only";
            default -> "missing or wrong token";
        };
        LOGGER.warning("Rejected " + request.method() + " " + loggablePath(request.uri()) + " from " + ctx.channel().remoteAddress()
                + " (" + reason + "; further rejections are logged at most once per minute)");
    }

    /** Raw path without query, printable ASCII only and capped, so a crafted URI cannot forge log lines. */
    static String loggablePath(String uri) {
        int query = uri.indexOf('?');
        String path = query >= 0 ? uri.substring(0, query) : uri;
        if (path.length() > MAX_LOGGED_PATH) path = path.substring(0, MAX_LOGGED_PATH) + "...";
        return path.replaceAll("[^\\x20-\\x7E]", "?");
    }

    /** Same shape as HttpRequestHandler's error body, plus a machine-readable code. */
    private static final class ErrorBody {
        public final int status;
        public final String error;
        public final String code;

        ErrorBody(int status, String error, String code) {
            this.status = status;
            this.error = error;
            this.code = code;
        }
    }
}
