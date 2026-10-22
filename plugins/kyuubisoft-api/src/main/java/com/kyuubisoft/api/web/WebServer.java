package com.kyuubisoft.api.web;

import com.kyuubisoft.api.config.ApiConfig;
import com.kyuubisoft.api.handlers.MetricsHandler;
import com.kyuubisoft.api.websocket.EventBroadcaster;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.*;
import io.netty.channel.nio.NioIoHandler;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.http.*;
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler;
import io.netty.handler.stream.ChunkedWriteHandler;
import io.netty.util.concurrent.EventExecutor;
import io.netty.util.concurrent.Future;

import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/**
 * Netty-based HTTP/WebSocket server for the KyuubiSoft API
 */
public class WebServer {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final long STOP_TIMEOUT_SECONDS = 5;

    private final int port;
    private final EventBroadcaster eventBroadcaster;
    private MetricsHandler metricsHandler;
    private ApiConfig apiConfig;
    private Executor workers;

    private EventLoopGroup bossGroup;
    private EventLoopGroup workerGroup;
    private Channel serverChannel;

    public WebServer(int port, EventBroadcaster eventBroadcaster) {
        this.port = port;
        this.eventBroadcaster = eventBroadcaster;
    }

    public void setMetricsHandler(MetricsHandler metricsHandler) {
        this.metricsHandler = metricsHandler;
    }

    /** API config providing the auth token and the CORS allowlist. Required. */
    public void setApiConfig(ApiConfig apiConfig) {
        this.apiConfig = apiConfig;
    }

    /** Pool for blocking request work, so the Netty threads never wait on it. */
    public void setWorkers(Executor workers) {
        this.workers = workers;
    }

    public void start() throws InterruptedException {
        if (apiConfig == null) {
            // Without its config the API cannot authenticate anyone: stay closed.
            throw new IllegalStateException("ApiConfig missing, refusing to start the API server");
        }
        final CorsPolicy corsPolicy = new CorsPolicy(apiConfig.getCorsAllowedOrigins());
        final AuthGate authGate = new AuthGate(apiConfig, corsPolicy);
        final ModPanelHttpHandler modPanelHandler = new ModPanelHttpHandler(corsPolicy);

        bossGroup = new MultiThreadIoEventLoopGroup(1, NioIoHandler.newFactory());
        workerGroup = new MultiThreadIoEventLoopGroup(NioIoHandler.newFactory());

        ServerBootstrap bootstrap = new ServerBootstrap();
        bootstrap.group(bossGroup, workerGroup)
                .channel(NioServerSocketChannel.class)
                .childHandler(new ChannelInitializer<SocketChannel>() {
                    @Override
                    protected void initChannel(SocketChannel ch) {
                        ChannelPipeline pipeline = ch.pipeline();

                        // HTTP codec
                        pipeline.addLast(new HttpServerCodec());
                        pipeline.addLast(new HttpObjectAggregator(65536));
                        pipeline.addLast(new ChunkedWriteHandler());

                        // Auth before the WebSocket handshake: an upgrade without
                        // a valid token gets 401 instead of 101.
                        pipeline.addLast(authGate);

                        // WebSocket support
                        pipeline.addLast(new WebSocketServerProtocolHandler("/ws", null, true));

                        // Custom handlers. /api/mods/panel* first; it passes everything else on.
                        pipeline.addLast(modPanelHandler);
                        HttpRequestHandler httpHandler = new HttpRequestHandler();
                        if (metricsHandler != null) {
                            httpHandler.setMetricsHandler(metricsHandler);
                        }
                        httpHandler.setCorsPolicy(corsPolicy);
                        httpHandler.setWorkers(workers);
                        pipeline.addLast(httpHandler);
                        pipeline.addLast(new WebSocketFrameHandler(eventBroadcaster));
                    }
                })
                .option(ChannelOption.SO_BACKLOG, 128)
                .childOption(ChannelOption.SO_KEEPALIVE, true);

        serverChannel = bootstrap.bind(port).sync().channel();
        LOGGER.info("WebServer bound to port " + port);
    }

    /**
     * Close the port and wait (bounded) until the event loops are gone, so a
     * plugin reload can bind the same port right away.
     */
    public void stop() {
        // Waiting from one of our own event loops (a request that triggered the
        // shutdown) would block that loop on itself: then only ask, don't wait.
        boolean mayWait = !inOwnEventLoop();
        if (serverChannel != null) {
            ChannelFuture closed = serverChannel.close();
            if (mayWait) closed.awaitUninterruptibly(STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        }
        for (EventLoopGroup group : new EventLoopGroup[] { bossGroup, workerGroup }) {
            if (group == null) continue;
            Future<?> terminated = group.shutdownGracefully(0, STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (mayWait) terminated.awaitUninterruptibly(STOP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        }
        LOGGER.info("WebServer stopped");
    }

    private boolean inOwnEventLoop() {
        for (EventLoopGroup group : new EventLoopGroup[] { bossGroup, workerGroup }) {
            if (group == null) continue;
            for (EventExecutor executor : group) {
                if (executor.inEventLoop()) return true;
            }
        }
        return false;
    }
}
