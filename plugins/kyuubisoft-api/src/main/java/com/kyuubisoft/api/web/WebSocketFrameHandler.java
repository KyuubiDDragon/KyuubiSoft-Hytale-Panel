package com.kyuubisoft.api.web;

import com.kyuubisoft.api.websocket.EventBroadcaster;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.handler.codec.http.websocketx.*;

import java.util.logging.Logger;

/**
 * Handles WebSocket frames and manages client connections
 */
public class WebSocketFrameHandler extends SimpleChannelInboundHandler<WebSocketFrame> {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    private final EventBroadcaster eventBroadcaster;

    public WebSocketFrameHandler(EventBroadcaster eventBroadcaster) {
        this.eventBroadcaster = eventBroadcaster;
    }

    @Override
    public void handlerAdded(ChannelHandlerContext ctx) {
        // Client connected
        eventBroadcaster.addChannel(ctx.channel());
    }

    @Override
    public void handlerRemoved(ChannelHandlerContext ctx) {
        // Client disconnected
        eventBroadcaster.removeChannel(ctx.channel());
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, WebSocketFrame frame) {
        if (frame instanceof TextWebSocketFrame) {
            // Handle text messages from client (e.g., for future commands)
            String text = ((TextWebSocketFrame) frame).text();
            LOGGER.fine("Received WebSocket message: " + text);

            // Echo back for now (can be extended for commands)
            // ctx.channel().writeAndFlush(new TextWebSocketFrame("Received: " + text));

        } else if (frame instanceof PingWebSocketFrame) {
            // Respond to ping with pong
            ctx.channel().writeAndFlush(new PongWebSocketFrame(frame.content().retain()));

        } else if (frame instanceof CloseWebSocketFrame) {
            // Client wants to close
            ctx.close();

        } else {
            // Unknown frame type
            LOGGER.warning("Unsupported WebSocket frame type: " + frame.getClass().getName());
        }
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        LOGGER.warning("WebSocket error: " + cause.getMessage());
        ctx.close();
    }
}
