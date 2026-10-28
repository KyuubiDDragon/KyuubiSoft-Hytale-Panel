/**
 * The console WebSocket: live server log, join/leave notes and commands.
 *
 * - Handlers are attached the moment a socket connects. Messages that arrive
 *   while it is still being authenticated are held and handled afterwards,
 *   and a socket that closes meanwhile is never registered.
 * - The log comes from the server's shared log stream (services/serverLogStream.ts):
 *   the end of the log first, then live entries, in batches.
 * - A socket that falls behind (its send buffer over HIGH_WATER_BYTES) gets no
 *   log batches until it has caught up, then a note how many entries it missed.
 * - The server pings every socket; one that does not answer until the next
 *   ping is closed. The console.view right is checked again on every ping.
 */
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { IncomingMessage } from 'http';
import { verifyToken, verifyWsTicket } from './services/auth.js';
import { execCommand } from './services/docker.js';
import { hasPermission } from './services/roles.js';
import { authorizeCommand, scopeAllows } from './services/commandPolicy.js';
import type { LogEntry, WsMessage } from './types/index.js';
import { getDefaultId, getServer } from './services/servers.js';
import {
  subscribeServerLogWithHistory,
  type LogHistoryOptions,
} from './services/serverLogStream.js';
import { onPresenceChange } from './services/playerPresence.js';
import type { AssembledLogEntry } from './services/logs.js';

// The end of the log a console starts with.
const HISTORY: LogHistoryOptions = { tail: 1_000, maxBytes: 512 * 1024, maxEntries: 200 };
// Commands of one console connection that may wait for their turn at once.
const MAX_WAITING_COMMANDS = 20;
// Commands one connection may send in a burst, and how fast that allowance comes back.
const COMMAND_BURST = 30;
const COMMAND_REFILL_PER_SECOND = 3;
// Messages held while a socket is being authenticated, and how long that may take.
const MAX_EARLY_MESSAGES = 32;
const AUTH_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
// Log batches pause above this much unsent data and resume below LOW_WATER_BYTES.
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;
// A socket with this much unsent data is not reading at all; it is closed.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

interface ClientContext {
  username: string;
  serverId: string;
  /** Scopes of the API key the socket's ticket was issued for (absent = normal login). */
  apiKeyScopes?: string[];
  /** Opened on /api/servers/:id/console/ws (rights of that server) or the legacy path. */
  scoped: boolean;
}

interface ConsoleClient {
  ws: WebSocket;
  ctx: ClientContext | null;
  closed: boolean;
  early: RawData[];
  earlyDropped: number;
  commandQueue: Promise<void>;
  waitingCommands: number;
  commandTokens: number;
  tokensAt: number;
  unsubscribeLog: (() => void) | null;
  /** Log entries left out while the socket was behind. */
  missed: number;
  behind: boolean;
  alive: boolean;
  checkingRights: boolean;
}

const clients = new Set<ConsoleClient>();

/** One log entry as the console receives it. */
interface WireLogEntry extends LogEntry {
  stream: 'stdout' | 'stderr';
  /** Docker receive time in nanoseconds, to skip entries a reconnect repeats. */
  cursor?: string;
}

function toWire({ entry, stream, cursor }: AssembledLogEntry): WireLogEntry {
  const wire: WireLogEntry = {
    timestamp: entry.timestamp,
    level: entry.level,
    message: entry.message,
    stream,
  };
  if (entry.logger) wire.logger = entry.logger;
  if (cursor !== null) wire.cursor = cursor.toString();
  return wire;
}

/** Sends if the socket is open; closes a socket that stopped reading. */
function send(client: ConsoleClient, message: object): boolean {
  const { ws } = client;
  if (client.closed || ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    console.warn(
      `[Console WS] Closing a console that stopped reading (server=${client.ctx?.serverId})`,
    );
    ws.terminate();
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

function sendMissedNote(client: ConsoleClient): void {
  if (client.missed === 0) return;
  if (send(client, { type: 'logs_dropped', count: client.missed, reason: 'slow_connection' })) {
    client.missed = 0;
  }
}

function sendLogs(client: ConsoleClient, entries: AssembledLogEntry[], extra: object = {}): void {
  if (client.closed) return;
  const buffered = client.ws.bufferedAmount;
  if (buffered > HIGH_WATER_BYTES || (client.behind && buffered > LOW_WATER_BYTES)) {
    client.behind = true;
    client.missed += entries.length;
    return;
  }
  client.behind = false;
  sendMissedNote(client);
  send(client, { type: 'log_batch', ...extra, entries: entries.map(toWire) });
}

/** A client's command request id, echoed back only if it is a short plain token. */
function commandRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * Run one command from the WS console and always answer it, so the client's
 * pending reply block is resolved even when something throws.
 */
async function runConsoleCommand(
  client: ConsoleClient,
  ctx: ClientContext,
  command: string,
  requestId: string | undefined,
): Promise<void> {
  const reply = (body: Record<string, unknown>) =>
    send(client, { type: 'command_response', requestId, command, ...body });
  try {
    // Same check as the HTTP console: whitelist, then the command's
    // tier on the SAME server it will run on (so a per-server operator
    // role is honoured), limited by the API key's scopes if any.
    const auth = await authorizeCommand(
      { username: ctx.username, apiKeyScopes: ctx.apiKeyScopes },
      command,
      ctx.serverId,
    );
    if (!auth.allowed) {
      reply({ success: false, error: auth.error });
      return;
    }

    const result = await execCommand(command, ctx.serverId, { actor: ctx.username });
    reply({
      success: result.success,
      output: result.output || result.message,
      lines: result.lines,
      status: result.status,
      via: result.via,
      error: result.error,
    });
  } catch (error) {
    console.error('WebSocket command error:', error);
    reply({ success: false, error: 'Command failed' });
  }
}

/** Token bucket: COMMAND_BURST at once, then COMMAND_REFILL_PER_SECOND. */
function takeCommandToken(client: ConsoleClient): boolean {
  const now = Date.now();
  const refill = ((now - client.tokensAt) / 1000) * COMMAND_REFILL_PER_SECOND;
  client.commandTokens = Math.min(COMMAND_BURST, client.commandTokens + refill);
  client.tokensAt = now;
  if (client.commandTokens < 1) return false;
  client.commandTokens -= 1;
  return true;
}

function queueCommand(client: ConsoleClient, ctx: ClientContext, message: WsMessage): void {
  if (typeof message.payload !== 'string' || !message.payload) return;
  const payload = message.payload;
  const requestId = commandRequestId(message.requestId);
  const refuse = (error: string) =>
    send(client, {
      type: 'command_response',
      requestId,
      command: payload,
      success: false,
      error,
    });

  if (client.waitingCommands >= MAX_WAITING_COMMANDS) {
    refuse(
      `Too many commands waiting (${MAX_WAITING_COMMANDS}); try again when the earlier ones have finished`,
    );
    return;
  }
  if (!takeCommandToken(client)) {
    refuse(
      `Too many commands in a short time (${COMMAND_REFILL_PER_SECOND} per second); wait a moment`,
    );
    return;
  }
  // Commands run one after another per console, in the order they were
  // typed, as they did when every command went to stdin.
  client.waitingCommands++;
  client.commandQueue = client.commandQueue
    .then(() => (client.closed ? undefined : runConsoleCommand(client, ctx, payload, requestId)))
    // The chain must go on whatever happened to one command.
    .catch((err) => console.error('WebSocket command queue error:', err))
    .finally(() => {
      client.waitingCommands--;
    });
}

function handleMessage(client: ConsoleClient, ctx: ClientContext, data: RawData): void {
  let message: WsMessage;
  try {
    message = JSON.parse(data.toString());
  } catch (error) {
    console.error('WebSocket message error:', error);
    return;
  }
  switch (message?.type) {
    case 'command':
      queueCommand(client, ctx, message);
      break;
    case 'ping':
      send(client, { type: 'pong' });
      break;
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

/** The socket's user and server, or null after closing it with the reason. */
async function authenticate(ws: WebSocket, req: IncomingMessage): Promise<ClientContext | null> {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const ticket = url.searchParams.get('ticket');
  const token = url.searchParams.get('token');

  // Determine which server this socket subscribes to BEFORE ticket verify
  // so we can enforce the ticket-server binding (a ticket issued for
  // server A cannot be used to open a WS for server B).
  const serverId = await resolveSocketServerId(req.url || '');
  if (!serverId) {
    ws.close(4004, 'Unknown server');
    return null;
  }

  // The scoped path /api/servers/:id/console/ws carries the id in the
  // URL; the legacy /api/console/ws path resolves to the default-server.
  // Only the scoped path passes expectedServerId so legacy tickets
  // (unscoped) still work for legacy clients.
  const scoped = url.pathname.startsWith('/api/servers/');
  const expectedServerId = scoped ? serverId : undefined;

  let username: string;
  let apiKeyScopes: string[] | undefined;

  if (ticket) {
    const ticketResult = verifyWsTicket(ticket, expectedServerId);
    if (!ticketResult.valid || !ticketResult.username) {
      ws.close(4001, 'Invalid or expired ticket');
      return null;
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
      return null;
    }
    username = tokenResult.username;
  } else {
    ws.close(4001, 'Authentication required (ticket or token)');
    return null;
  }

  const ctx: ClientContext = { username, serverId, apiKeyScopes, scoped };
  // A ticket requested with an API key carries the key's scopes; the key must
  // cover console.view itself, not just its owner. A failing rights lookup
  // (unreadable users file) closes the socket instead of leaving it hanging.
  let canViewLogs = false;
  try {
    canViewLogs = await mayViewConsole(ctx);
  } catch (err) {
    console.error('WebSocket permission check failed:', err);
    ws.close(1011, 'Permission check failed');
    return null;
  }
  if (!canViewLogs) {
    ws.close(4003, 'Permission denied: console.view required');
    return null;
  }
  return ctx;
}

async function mayViewConsole(ctx: ClientContext): Promise<boolean> {
  return (
    scopeAllows(ctx.apiKeyScopes, 'console.view') &&
    (await hasPermission(ctx.username, 'console.view', ctx.scoped ? ctx.serverId : undefined))
  );
}

function cleanUp(client: ConsoleClient): void {
  if (client.closed) return;
  client.closed = true;
  clients.delete(client);
  client.early = [];
  client.unsubscribeLog?.();
  client.unsubscribeLog = null;
  if (client.ctx) {
    console.log(`WebSocket client disconnected (server=${client.ctx.serverId})`);
  }
}

/** Socket is authenticated: handle what it sent meanwhile, start its log. */
function activate(client: ConsoleClient, ctx: ClientContext): void {
  client.ctx = ctx;
  clients.add(client);
  console.log(`WebSocket client connected: ${ctx.username} (server=${ctx.serverId})`);

  const early = client.early;
  client.early = [];
  for (const data of early) handleMessage(client, ctx, data);
  if (client.earlyDropped > 0) {
    send(client, {
      type: 'error',
      message: `${client.earlyDropped} messages sent before the console was ready were dropped`,
    });
    client.earlyDropped = 0;
  }

  client.unsubscribeLog = subscribeServerLogWithHistory(ctx.serverId, HISTORY, {
    onHistory: (entries, truncated) => sendLogs(client, entries, { history: true, truncated }),
    onEntries: (entries) => sendLogs(client, entries),
    onDropped: (count) => send(client, { type: 'logs_dropped', count, reason: 'burst' }),
    onError: (message) => send(client, { type: 'error', message }),
  });
}

function connect(ws: WebSocket, req: IncomingMessage): void {
  const client: ConsoleClient = {
    ws,
    ctx: null,
    closed: false,
    early: [],
    earlyDropped: 0,
    commandQueue: Promise.resolve(),
    waitingCommands: 0,
    commandTokens: COMMAND_BURST,
    tokensAt: Date.now(),
    unsubscribeLog: null,
    missed: 0,
    behind: false,
    alive: true,
    checkingRights: false,
  };
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (client.closed || isBinary) return;
    if (client.ctx) {
      handleMessage(client, client.ctx, data);
    } else if (client.early.length < MAX_EARLY_MESSAGES) {
      client.early.push(data);
    } else {
      client.earlyDropped++;
    }
  });
  ws.on('pong', () => {
    client.alive = true;
  });
  ws.on('close', () => cleanUp(client));
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    cleanUp(client);
  });

  const authTimer = setTimeout(() => {
    if (!client.ctx && !client.closed) ws.close(1011, 'Authentication timed out');
  }, AUTH_TIMEOUT_MS);
  authenticate(ws, req)
    .then((ctx) => {
      if (!ctx || client.closed) return;
      activate(client, ctx);
    })
    .catch((err) => {
      console.error('WebSocket setup failed:', err);
      if (!client.closed) ws.close(1011, 'Setup failed');
    })
    .finally(() => clearTimeout(authTimer));
}

/** Ping every console; close the ones that did not answer the last ping or lost the right. */
function heartbeat(): void {
  for (const client of [...clients]) {
    const { ws } = client;
    if (!client.alive) {
      ws.terminate();
      continue;
    }
    client.alive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
      continue;
    }
    if (client.behind && ws.bufferedAmount <= LOW_WATER_BYTES) {
      client.behind = false;
      sendMissedNote(client);
    }
    recheckRights(client);
  }
}

function recheckRights(client: ConsoleClient): void {
  const ctx = client.ctx;
  if (!ctx || client.checkingRights) return;
  client.checkingRights = true;
  mayViewConsole(ctx)
    .then((allowed) => {
      if (!allowed && !client.closed) {
        client.ws.close(4003, 'Permission denied: console.view required');
      }
    })
    // A failing lookup is not a revoked right; the next ping asks again.
    .catch((err) => console.error('WebSocket permission re-check failed:', err))
    .finally(() => {
      client.checkingRights = false;
    });
}

export interface ConsoleSocketOptions {
  /** Ping interval; a socket is closed when it misses one (tests shorten it). */
  heartbeatMs?: number;
}

export function setupWebSocket(wss: WebSocketServer, options: ConsoleSocketOptions = {}): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => connect(ws, req));

  const timer = setInterval(heartbeat, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  timer.unref?.();
  const stopPresence = onPresenceChange((change) => {
    for (const client of clients) {
      if (client.ctx?.serverId !== change.serverId) continue;
      send(client, {
        type: 'player_event',
        event: change.event,
        player: change.player,
        timestamp: change.timestamp,
      });
    }
  });
  wss.on('close', () => {
    clearInterval(timer);
    stopPresence();
  });
}
