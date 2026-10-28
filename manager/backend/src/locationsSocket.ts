/**
 * WebSocket for live player positions, one server per socket:
 *   /api/servers/:serverId/players/locations/ws, or
 *   /api/players/locations/ws with `?serverId=<id>`; without either it is the
 *   default server (clients from before multi-server).
 *
 * SECURITY: the socket exposes live player UUIDs + world coordinates, so it
 * enforces the same players.view gate as GET /api/players/locations, on the
 * socket's server. It accepts a single-use WS ticket (preferred) or an access
 * token (legacy fallback, mirrors the console WS). A socket for a named
 * server needs a ticket issued for that server, the default one an unscoped
 * ticket. The server is only looked up after authentication, so the answer
 * doesn't tell which ids exist; while MULTISERVER_ENABLED is off only the
 * compose server is reachable, as on the scoped HTTP routes.
 *
 * Every socket is pinged; one that misses a ping is closed, and the right is
 * checked again on every ping (a revoked or narrowed API key, a changed role
 * or server list closes it).
 */
import type { IncomingMessage } from 'http';
import type { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { verifyToken, verifyWsTicket } from './services/auth.js';
import { hasPermission } from './services/roles.js';
import { scopeAllows } from './services/commandPolicy.js';
import { getActiveApiKeyGrant } from './services/apiKeys.js';
import { resolveServerId } from './services/servers.js';
import { getServerContext, UnknownServerError } from './services/serverContext.js';
import * as playerLocations from './services/playerLocations.js';

export const LOCATIONS_WS_PATH = '/api/players/locations/ws';
const SCOPED_LOCATIONS_WS = /^\/api\/servers\/([^/?]+)\/players\/locations\/ws$/;
const DEFAULT_HEARTBEAT_MS = 30_000;

/** Whether an upgrade path (without query) belongs to this socket. */
export function isLocationsSocketPath(pathname: string): boolean {
  return pathname === LOCATIONS_WS_PATH || SCOPED_LOCATIONS_WS.test(pathname);
}

interface LocationsContext {
  username: string;
  serverId: string;
  apiKeyScopes?: string[];
  apiKeyServerIds?: string[];
  apiKeyId?: string;
}

/** The server id the client named (path or query), if any. */
function namedServer(url: URL): string | undefined {
  return (
    SCOPED_LOCATIONS_WS.exec(url.pathname)?.[1] ?? url.searchParams.get('serverId') ?? undefined
  );
}

/** The socket's server, or the close code and reason for a server it may not stream. */
async function socketServer(
  named: string | undefined,
): Promise<{ serverId: string } | { code: number; reason: string }> {
  if (!named) return { serverId: await resolveServerId() };
  try {
    const ctx = await getServerContext(named);
    if (!config.multiserverEnabled && ctx.kind !== 'compose') {
      return { code: 4003, reason: 'Multiserver is disabled' };
    }
    return { serverId: ctx.id };
  } catch (err) {
    if (err instanceof UnknownServerError) return { code: 4004, reason: 'Unknown server' };
    throw err;
  }
}

/** Takes over the key's current scopes and servers; false once it was revoked or expired. */
function refreshKeyGrant(ctx: LocationsContext): boolean {
  if (ctx.apiKeyId === undefined) return true;
  const grant = getActiveApiKeyGrant(ctx.apiKeyId);
  if (!grant) return false;
  ctx.apiKeyScopes = grant.scopes;
  ctx.apiKeyServerIds = grant.serverIds ?? undefined;
  return true;
}

// A ticket requested with an API key only opens this stream if the key itself
// is scoped for players.view and covers the server.
async function mayView(ctx: LocationsContext): Promise<boolean> {
  return (
    refreshKeyGrant(ctx) &&
    scopeAllows(ctx.apiKeyScopes, 'players.view') &&
    (ctx.apiKeyServerIds === undefined || ctx.apiKeyServerIds.includes(ctx.serverId)) &&
    (await hasPermission(ctx.username, 'players.view', ctx.serverId))
  );
}

/** The socket's user and server, or null after closing it with the reason. */
async function authenticate(
  socket: WebSocket,
  req: IncomingMessage,
): Promise<LocationsContext | null> {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const named = namedServer(url);
  const ticket = url.searchParams.get('ticket');
  const token = url.searchParams.get('token');
  let identity: Omit<LocationsContext, 'serverId'> | null = null;
  if (ticket) {
    const r = verifyWsTicket(ticket, named);
    if (r.valid && r.username) {
      identity = {
        username: r.username,
        apiKeyScopes: r.apiKeyScopes,
        apiKeyServerIds: r.apiKeyServerIds,
        apiKeyId: r.apiKeyId,
      };
    }
  } else if (token) {
    const r = verifyToken(token, 'access');
    if (r) identity = { username: r.username };
  }
  if (!identity) {
    socket.close(4001, 'Authentication required');
    return null;
  }
  const target = await socketServer(named);
  if (!('serverId' in target)) {
    socket.close(target.code, target.reason);
    return null;
  }
  const ctx: LocationsContext = { ...identity, serverId: target.serverId };
  if (!(await mayView(ctx))) {
    socket.close(4003, 'Permission denied: players.view required');
    return null;
  }
  return ctx;
}

function stream(socket: WebSocket, ctx: LocationsContext, heartbeatMs: number): void {
  const send = (frame: unknown) => {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* socket may already be closed */
    }
  };
  send({ type: 'snapshot', samples: playerLocations.getLatestSnapshot(ctx.serverId) });
  const unsubscribe = playerLocations.addListener((s) => {
    if (s.serverId === ctx.serverId) send({ type: 'sample', sample: s });
  });

  let alive = true;
  let checking = false;
  socket.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      socket.terminate();
      return;
    }
    if (checking) return;
    checking = true;
    mayView(ctx)
      .then((allowed) => {
        if (!allowed) socket.close(4003, 'Permission denied: players.view required');
      })
      // A failing lookup is not a revoked right; the next ping asks again.
      .catch((err) => console.error('[Locations WS] permission re-check failed:', err))
      .finally(() => {
        checking = false;
      });
  }, heartbeatMs);
  heartbeat.unref?.();

  const stop = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  socket.on('close', stop);
  socket.on('error', stop);
}

export interface LocationsSocketOptions {
  /** Ping and re-check interval (tests shorten it). */
  heartbeatMs?: number;
}

export function setupLocationsSocket(
  wss: WebSocketServer,
  options: LocationsSocketOptions = {},
): void {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    authenticate(socket, req)
      .then((ctx) => {
        if (ctx) stream(socket, ctx, heartbeatMs);
      })
      .catch(() => socket.close(4001, 'Authentication failed'));
  });
}
