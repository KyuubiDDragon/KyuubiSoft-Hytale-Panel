import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { verifyToken, verifyWsTicket } from './services/auth.js';
import { getDockerInstance, execCommand, getLogs } from './services/docker.js';
import { createDockerOutputDecoder } from './services/dockerStream.js';
import { parseLogLine } from './services/logs.js';
import { processLogLine } from './services/players.js';
import { hasPermission } from './services/roles.js';
import { authorizeCommand, scopeAllows } from './services/commandPolicy.js';
import type { WsMessage } from './types/index.js';
import { isDemoMode, getNextDemoLogLine } from './services/demoData.js';
import { getDefaultId, getServer } from './services/servers.js';

// All clients indexed by socket. We need per-client server scope so that
// when the last subscriber to server X disconnects we tear down its stream.
const clientUsernames = new Map<WebSocket, string>();
const clientServerId = new Map<WebSocket, string>();
// Scopes of the API key a socket's ticket was issued for (absent = normal login).
const clientApiKeyScopes = new Map<WebSocket, string[]>();

// Per-server set of subscribed sockets (so we can broadcast per-server)
const clientsByServer = new Map<string, Set<WebSocket>>();

// Per-server log stream state
interface StreamState {
  stream: NodeJS.ReadableStream | null;
  restartTimeout: NodeJS.Timeout | null;
  demoInterval: NodeJS.Timeout | null;
}
const streamsByServer = new Map<string, StreamState>();

function getOrCreateStreamState(serverId: string): StreamState {
  let s = streamsByServer.get(serverId);
  if (!s) {
    s = { stream: null, restartTimeout: null, demoInterval: null };
    streamsByServer.set(serverId, s);
  }
  return s;
}

function getClientsForServer(serverId: string): Set<WebSocket> {
  let s = clientsByServer.get(serverId);
  if (!s) {
    s = new Set();
    clientsByServer.set(serverId, s);
  }
  return s;
}

async function sendExistingLogs(ws: WebSocket, serverId: string): Promise<void> {
  try {
    const logs = await getLogs(200, serverId);
    const lines = logs.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = parseLogLine(trimmed);
      if (parsed && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'log',
            ...parsed,
          }),
        );
      }
    }
  } catch (error) {
    console.error('Failed to send existing logs:', error);
  }
}

/**
 * Extract serverId from a request URL. Returns the default server id when
 * the upgrade hits /api/console/ws (legacy mount). Returns null if neither
 * pattern matches.
 *
 * Exported only for unit tests — production code goes through setupWebSocket.
 */
export async function resolveSocketServerId(reqUrl: string): Promise<string | null> {
  // Match /api/servers/:id/console/ws[?...]
  const match = reqUrl.match(/^\/api\/servers\/([^/?]+)\/console\/ws(?:\?|$)/);
  if (match) {
    const id = match[1];
    const server = await getServer(id);
    if (!server) return null;
    return id;
  }
  if (reqUrl.startsWith('/api/console/ws')) {
    try {
      return await getDefaultId();
    } catch {
      return 'default';
    }
  }
  return null;
}

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const ticket = url.searchParams.get('ticket');
    const token = url.searchParams.get('token');

    // Determine which server this socket subscribes to BEFORE ticket verify
    // so we can enforce the ticket-server binding (a ticket issued for
    // server A cannot be used to open a WS for server B).
    const serverId = await resolveSocketServerId(req.url || '');
    if (!serverId) {
      ws.close(4004, 'Unknown server');
      return;
    }

    // The scoped path /api/servers/:id/console/ws carries the id in the
    // URL; the legacy /api/console/ws path resolves to the default-server.
    // Only the scoped path passes expectedServerId so legacy tickets
    // (unscoped) still work for legacy clients.
    const pathname = url.pathname;
    const isScoped = pathname.startsWith('/api/servers/');
    const expectedServerId = isScoped ? serverId : undefined;

    let username: string;
    let apiKeyScopes: string[] | undefined;

    if (ticket) {
      const ticketResult = verifyWsTicket(ticket, expectedServerId);
      if (!ticketResult.valid || !ticketResult.username) {
        ws.close(4001, 'Invalid or expired ticket');
        return;
      }
      username = ticketResult.username;
      apiKeyScopes = ticketResult.apiKeyScopes;
    } else if (token) {
      console.warn(
        'WebSocket: Client using deprecated token auth. Should use /api/auth/ws-ticket instead.',
      );
      const tokenResult = verifyToken(token, 'access');
      if (!tokenResult) {
        ws.close(4001, 'Invalid token');
        return;
      }
      username = tokenResult.username;
    } else {
      ws.close(4001, 'Authentication required (ticket or token)');
      return;
    }

    // A ticket requested with an API key carries the key's scopes; the key must
    // cover console.view itself, not just its owner. A failing rights lookup
    // (unreadable users file) closes the socket instead of leaving it hanging.
    let canViewLogs = false;
    try {
      canViewLogs =
        scopeAllows(apiKeyScopes, 'console.view') &&
        (await hasPermission(username, 'console.view', isScoped ? serverId : undefined));
    } catch (err) {
      console.error('WebSocket permission check failed:', err);
      ws.close(1011, 'Permission check failed');
      return;
    }
    if (!canViewLogs) {
      ws.close(4003, 'Permission denied: console.view required');
      return;
    }

    console.log(`WebSocket client connected: ${username} (server=${serverId})`);
    const serverClients = getClientsForServer(serverId);
    serverClients.add(ws);
    clientUsernames.set(ws, username);
    clientServerId.set(ws, serverId);
    if (apiKeyScopes) clientApiKeyScopes.set(ws, apiKeyScopes);

    await sendExistingLogs(ws, serverId);

    // Start streaming for this server if first client subscribed
    if (serverClients.size === 1) {
      startLogStreaming(serverId);
    }

    ws.on('message', async (data: Buffer) => {
      try {
        const message: WsMessage = JSON.parse(data.toString());

        switch (message.type) {
          case 'command':
            if (message.payload) {
              const wsUsername = clientUsernames.get(ws);
              const wsServerId = clientServerId.get(ws);
              // Same check as the HTTP console: whitelist, then the command's
              // tier on the SAME server it will run on (so a per-server operator
              // role is honoured), limited by the API key's scopes if any.
              const auth = await authorizeCommand(
                { username: wsUsername, apiKeyScopes: clientApiKeyScopes.get(ws) },
                message.payload,
                wsServerId,
              );
              if (!auth.allowed) {
                ws.send(
                  JSON.stringify({
                    type: 'command_response',
                    command: message.payload,
                    success: false,
                    error: auth.error,
                  }),
                );
                break;
              }

              const result = await execCommand(message.payload, wsServerId);
              ws.send(
                JSON.stringify({
                  type: 'command_response',
                  command: message.payload,
                  success: result.success,
                  output: result.message,
                  error: result.error,
                }),
              );
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
      const sid = clientServerId.get(ws);
      clientUsernames.delete(ws);
      clientServerId.delete(ws);
      clientApiKeyScopes.delete(ws);
      if (sid) {
        const set = clientsByServer.get(sid);
        set?.delete(ws);
        console.log(`WebSocket client disconnected (server=${sid})`);
        if (set && set.size === 0) {
          stopLogStreaming(sid);
        }
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      const sid = clientServerId.get(ws);
      clientUsernames.delete(ws);
      clientServerId.delete(ws);
      clientApiKeyScopes.delete(ws);
      if (sid) {
        clientsByServer.get(sid)?.delete(ws);
      }
    });
  });
}

function broadcast(serverId: string, message: object): void {
  const data = JSON.stringify(message);
  const set = clientsByServer.get(serverId);
  if (!set) return;
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Demo mode: simulate log streaming with periodic log messages
function startDemoLogStreaming(serverId: string): void {
  const state = getOrCreateStreamState(serverId);
  if (state.demoInterval) clearInterval(state.demoInterval);

  console.log(`[DEMO] Demo log streaming started for ${serverId}`);

  state.demoInterval = setInterval(
    () => {
      const set = clientsByServer.get(serverId);
      if (!set || set.size === 0) {
        stopDemoLogStreaming(serverId);
        return;
      }

      const logLine = getNextDemoLogLine();
      const parsed = parseLogLine(logLine);

      if (parsed) {
        broadcast(serverId, { type: 'log', ...parsed });

        const playerEvent = processLogLine(logLine);
        if (playerEvent) {
          broadcast(serverId, {
            type: 'player_event',
            event: playerEvent.event,
            player: playerEvent.player,
            timestamp: new Date().toISOString(),
          });
        }
      }
    },
    3000 + Math.random() * 5000,
  );
}

function stopDemoLogStreaming(serverId: string): void {
  const state = streamsByServer.get(serverId);
  if (state?.demoInterval) {
    clearInterval(state.demoInterval);
    state.demoInterval = null;
    console.log(`[DEMO] Demo log streaming stopped for ${serverId}`);
  }
}

async function startLogStreaming(serverId: string): Promise<void> {
  if (isDemoMode()) {
    startDemoLogStreaming(serverId);
    return;
  }

  const state = getOrCreateStreamState(serverId);

  if (state.restartTimeout) {
    clearTimeout(state.restartTimeout);
    state.restartTimeout = null;
  }

  if (state.stream) {
    state.stream.removeAllListeners();
    state.stream = null;
  }

  try {
    const docker = getDockerInstance();
    const server = await getServer(serverId);
    const containerName = server?.containerName;
    if (!containerName) {
      console.error(`[Console:${serverId}] Unknown container for server`);
      return;
    }
    const container = docker.getContainer(containerName);

    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 0,
      timestamps: true,
    });

    state.stream = stream;
    console.log(`Log streaming started for server ${serverId}`);

    // Stateful: Docker frames (no TTY) are split arbitrarily across chunks.
    const decoder = createDockerOutputDecoder();
    stream.on('data', (chunk: Buffer) => {
      const lines = decoder.push(chunk).split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = parseLogLine(trimmed);
        if (parsed) {
          broadcast(serverId, { type: 'log', ...parsed });

          const playerEvent = processLogLine(trimmed);
          if (playerEvent) {
            broadcast(serverId, {
              type: 'player_event',
              ...playerEvent,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    });

    stream.on('error', (error: Error) => {
      console.error(`Log stream error (${serverId}):`, error);
      broadcast(serverId, { type: 'error', message: error.message });
      scheduleStreamRestart(serverId);
    });

    stream.on('end', () => {
      console.log(`Log stream ended (${serverId})`);
      scheduleStreamRestart(serverId);
    });

    stream.on('close', () => {
      console.log(`Log stream closed (${serverId})`);
      scheduleStreamRestart(serverId);
    });
  } catch (error) {
    console.error(`Failed to start log streaming (${serverId}):`, error);
    broadcast(serverId, { type: 'error', message: 'Failed to connect to container logs' });
    scheduleStreamRestart(serverId);
  }
}

function scheduleStreamRestart(serverId: string): void {
  const state = getOrCreateStreamState(serverId);
  const set = clientsByServer.get(serverId);
  if (set && set.size > 0 && !state.restartTimeout) {
    console.log(`Scheduling log stream restart for ${serverId} in 3 seconds...`);
    state.restartTimeout = setTimeout(() => {
      state.restartTimeout = null;
      const stillHasClients = clientsByServer.get(serverId);
      if (stillHasClients && stillHasClients.size > 0) {
        console.log(`Restarting log stream for ${serverId}...`);
        startLogStreaming(serverId);
      }
    }, 3000);
  }
}

function stopLogStreaming(serverId: string): void {
  stopDemoLogStreaming(serverId);

  const state = streamsByServer.get(serverId);
  if (!state) return;
  if (state.restartTimeout) {
    clearTimeout(state.restartTimeout);
    state.restartTimeout = null;
  }
  if (state.stream) {
    state.stream.removeAllListeners();
    state.stream = null;
  }
}
