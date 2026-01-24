package com.kyuubisoft.api.web;

import com.kyuubisoft.api.handlers.MetricsHandler;
import com.kyuubisoft.api.websocket.EventBroadcaster;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.*;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.http.*;
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler;
import io.netty.handler.stream.ChunkedWriteHandler;

import java.util.logging.Logger;

/**
 * Netty-based HTTP/WebSocket server for the KyuubiSoft API
 */
public class WebServer {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    private final int port;
    private final EventBroadcaster eventBroadcaster;
    private MetricsHandler metricsHandler;

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

    public void start() throws InterruptedException {
        bossGroup = new NioEventLoopGroup(1);
        workerGroup = new NioEventLoopGroup();

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

                        // WebSocket support
                        pipeline.addLast(new WebSocketServerProtocolHandler("/ws", null, true));

                        // Custom handlers
                        HttpRequestHandler httpHandler = new HttpRequestHandler();
                        if (metricsHandler != null) {
                            httpHandler.setMetricsHandler(metricsHandler);
                        }
                        pipeline.addLast(httpHandler);
                        pipeline.addLast(new WebSocketFrameHandler(eventBroadcaster));
                    }
                })
                .option(ChannelOption.SO_BACKLOG, 128)
                .childOption(ChannelOption.SO_KEEPALIVE, true);

        serverChannel = bootstrap.bind(port).sync().channel();
        LOGGER.info("WebServer bound to port " + port);
    }

    public void stop() {
        if (serverChannel != null) {
            serverChannel.close();
        }
        if (bossGroup != null) {
            bossGroup.shutdownGracefully();
        }
        if (workerGroup != null) {
            workerGroup.shutdownGracefully();
        }
        LOGGER.info("WebServer stopped");
    }
}
