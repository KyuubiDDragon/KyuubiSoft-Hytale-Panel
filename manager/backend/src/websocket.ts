import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { verifyToken } from './services/auth.js';
import { getDockerInstance, getContainerName, execCommand, getLogs } from './services/docker.js';
import { parseLogLine } from './services/logs.js';
import { processLogLine } from './services/players.js';
import type { WsMessage } from './types/index.js';

const clients = new Set<WebSocket>();
let logStream: NodeJS.ReadableStream | null = null;

async function sendExistingLogs(ws: WebSocket): Promise<void> {
  try {
    const logs = await getLogs(200);
    const lines = logs.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = parseLogLine(trimmed);
      if (parsed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'log',
          ...parsed,
        }));
      }
    }
  } catch (error) {
    console.error('Failed to send existing logs:', error);
  }
}

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Extract token from query string
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Token required');
      return;
    }

    const username = verifyToken(token, 'access');
    if (!username) {
      ws.close(4001, 'Invalid token');
      return;
    }

    console.log(`WebSocket client connected: ${username}`);
    clients.add(ws);

    // Send existing logs to new client
    sendExistingLogs(ws);

    // Start streaming if first client
    if (clients.size === 1) {
      startLogStreaming();
    }

    // Handle messages from client
    ws.on('message', async (data: Buffer) => {
      try {
        const message: WsMessage = JSON.parse(data.toString());

        switch (message.type) {
          case 'command':
            if (message.payload) {
              const result = await execCommand(message.payload);
              ws.send(JSON.stringify({
                type: 'command_response',
                command: message.payload,
                success: result.success,
                output: result.message,
                error: result.error,
              }));
            }
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log('WebSocket client disconnected');

      // Stop streaming if no clients
      if (clients.size === 0) {
        stopLogStreaming();
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(ws);
    });
  });
}

function broadcast(message: object): void {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

async function startLogStreaming(): Promise<void> {
  try {
    const docker = getDockerInstance();
    const container = docker.getContainer(getContainerName());

    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 0,
      timestamps: true,
    });

    logStream = stream;

    stream.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf-8').split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = parseLogLine(trimmed);
        if (parsed) {
          broadcast({
            type: 'log',
            ...parsed,
          });

          // Check for player events
          const playerEvent = processLogLine(trimmed);
          if (playerEvent) {
            broadcast({
              type: 'player_event',
              ...playerEvent,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    });

    stream.on('error', (error: Error) => {
      console.error('Log stream error:', error);
      broadcast({
        type: 'error',
        message: error.message,
      });
    });

    stream.on('end', () => {
      console.log('Log stream ended');
    });

  } catch (error) {
    console.error('Failed to start log streaming:', error);
    broadcast({
      type: 'error',
      message: 'Failed to connect to container logs',
    });
  }
}

function stopLogStreaming(): void {
  if (logStream) {
    logStream.removeAllListeners();
    logStream = null;
  }
}
