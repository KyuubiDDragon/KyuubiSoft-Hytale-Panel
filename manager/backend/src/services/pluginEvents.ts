/**
 * Plugin Events Service
 *
 * Connects to the KyuubiSoft API plugin's WebSocket(s) to receive real-time
 * events and processes chat messages, death events, etc.
 *
 * Multi-server: one WebSocket connection per registered server. The legacy
 * single-server boot path still works because `connectAll()` ensures the
 * registry is loaded, which auto-creates a default entry from env vars on
 * first run.
 */

import WebSocket from 'ws';
import { resolvePluginEndpoint } from './kyuubiApi.js';
import { addChatMessage, recordDeathPosition } from './chatLog.js';
import { parsePluginEvent, type PluginEvent } from '../schemas/pluginEvents.js';
import { eventBus, publish as publishPanelEvent } from './eventBus.js';
import { listServers, onServerAdded, onServerDeleted } from './servers.js';

// Reconnection settings
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 60000; // 1 minute max

interface WebSocketState {
  serverId: string;
  ws: WebSocket | null;
  reconnectTimeout: NodeJS.Timeout | null;
  isConnecting: boolean;
  isShuttingDown: boolean;
  currentReconnectDelay: number;
}

// Per-server WS connection state.
const connections = new Map<string, WebSocketState>();

type PluginEventData = PluginEvent;

function getOrCreateState(serverId: string): WebSocketState {
  let state = connections.get(serverId);
  if (!state) {
    state = {
      serverId,
      ws: null,
      reconnectTimeout: null,
      isConnecting: false,
      isShuttingDown: false,
      currentReconnectDelay: RECONNECT_DELAY,
    };
    connections.set(serverId, state);
  }
  return state;
}

/**
 * Handle incoming event from the plugin
 */
async function handleEvent(serverId: string, event: PluginEventData): Promise<void> {
  switch (event.type) {
    case 'player_chat':
      console.log(`[Chat:${serverId}] ${event.player}: ${event.message}`);
      await addChatMessage(event.player, event.message, event.uuid);
      eventBus.publish('player_chat', {
        player: event.player, uuid: event.uuid, message: event.message, serverId,
      });
      // Also publish to panel-event taxonomy so webhooks / notifications see it.
      break;

    case 'player_death':
      console.log(`[Death:${serverId}] ${event.player} died${event.cause ? ` (${event.cause})` : ''}`);
      if (event.world && event.x !== undefined && event.y !== undefined && event.z !== undefined) {
        await recordDeathPosition(event.player, event.world, event.x, event.y, event.z);
      }
      eventBus.publish('player_death', {
        player: event.player, cause: event.cause, world: event.world, x: event.x, y: event.y, z: event.z, serverId,
      });
      publishPanelEvent('player.death', {
        player: event.player, cause: event.cause, world: event.world, x: event.x, y: event.y, z: event.z,
      }, serverId);
      break;

    case 'player_join':
      console.log(`[Join:${serverId}] ${event.player}`);
      eventBus.publish('player_join', { player: event.player, uuid: event.uuid, serverId });
      publishPanelEvent('player.joined', { player: event.player, uuid: event.uuid }, serverId);
      break;

    case 'player_leave':
      console.log(`[Leave:${serverId}] ${event.player}`);
      eventBus.publish('player_leave', { player: event.player, uuid: event.uuid, serverId });
      publishPanelEvent('player.left', { player: event.player, uuid: event.uuid }, serverId);
      break;

    default:
      console.log(`[Plugin Event:${serverId}] Unknown event type: ${(event as PluginEvent).type}`);
  }
}

/**
 * Connect to a single plugin WebSocket for a specific server
 */
export async function connect(serverId: string): Promise<void> {
  const state = getOrCreateState(serverId);

  if (state.isShuttingDown || state.isConnecting || (state.ws && state.ws.readyState === WebSocket.OPEN)) {
    return;
  }

  state.isConnecting = true;
  const { host, port } = await resolvePluginEndpoint(serverId);
  const url = `ws://${host}:${port}/ws`;

  console.log(`[PluginEvents:${serverId}] Connecting to plugin WebSocket at ${url}...`);

  try {
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.on('open', () => {
      console.log(`[PluginEvents:${serverId}] Connected to plugin WebSocket`);
      state.isConnecting = false;
      state.currentReconnectDelay = RECONNECT_DELAY;
    });

    ws.on('message', async (data: WebSocket.Data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch (error) {
        console.error(`[PluginEvents:${serverId}] Malformed JSON:`, error);
        return;
      }
      const parsed = parsePluginEvent(raw);
      if (!parsed.ok) {
        // Plugin contract drift — surface loudly so it can be fixed instead of
        // silently feeding bad data into chat logs / death tracking.
        console.warn(`[PluginEvents:${serverId}] Rejected event: ${parsed.error}`, raw);
        return;
      }
      try {
        await handleEvent(serverId, parsed.event);
      } catch (error) {
        console.error(`[PluginEvents:${serverId}] Handler error:`, error);
      }
    });

    ws.on('close', () => {
      console.log(`[PluginEvents:${serverId}] WebSocket closed`);
      state.isConnecting = false;
      state.ws = null;
      scheduleReconnect(serverId);
    });

    ws.on('error', (error) => {
      // Only log if not a connection refused error (which is expected when plugin is not running)
      if (!(error as NodeJS.ErrnoException).code?.includes('ECONNREFUSED')) {
        console.error(`[PluginEvents:${serverId}] WebSocket error:`, error.message);
      }
      state.isConnecting = false;
    });
  } catch (error) {
    console.error(`[PluginEvents:${serverId}] Failed to create connection:`, error);
    state.isConnecting = false;
    scheduleReconnect(serverId);
  }
}

/**
 * Schedule a reconnection attempt for a specific server
 */
function scheduleReconnect(serverId: string): void {
  const state = connections.get(serverId);
  if (!state || state.isShuttingDown || state.reconnectTimeout) {
    return;
  }

  state.reconnectTimeout = setTimeout(() => {
    state.reconnectTimeout = null;
    connect(serverId);

    // Increase delay for next attempt (exponential backoff)
    state.currentReconnectDelay = Math.min(state.currentReconnectDelay * 1.5, MAX_RECONNECT_DELAY);
  }, state.currentReconnectDelay);
}

/**
 * Disconnect a single plugin WebSocket
 */
export function disconnect(serverId: string): void {
  const state = connections.get(serverId);
  if (!state) return;

  state.isShuttingDown = true;

  if (state.reconnectTimeout) {
    clearTimeout(state.reconnectTimeout);
    state.reconnectTimeout = null;
  }

  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
    state.ws = null;
  }

  connections.delete(serverId);
}

/**
 * Open WS connections for all currently-registered servers
 */
export async function connectAll(): Promise<void> {
  try {
    const servers = await listServers();
    for (const s of servers) {
      await connect(s.id);
    }
  } catch (err) {
    console.error('[PluginEvents] connectAll failed:', err);
  }
}

/**
 * Close all WS connections (used on shutdown)
 */
export function disconnectAll(): void {
  for (const serverId of Array.from(connections.keys())) {
    disconnect(serverId);
  }
}

/**
 * Check if connected to any plugin or to a specific server
 */
export function isConnectedToPlugin(serverId?: string): boolean {
  if (serverId) {
    const s = connections.get(serverId);
    return !!s?.ws && s.ws.readyState === WebSocket.OPEN;
  }
  for (const state of connections.values()) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/**
 * Initialize plugin events for all registered servers.
 * Called once at startup.
 */
let lifecycleHooksRegistered = false;

export function initializePluginEvents(): void {
  console.log('[PluginEvents] Initializing plugin events for all registered servers...');
  if (!lifecycleHooksRegistered) {
    onServerAdded((server) => connect(server.id));
    onServerDeleted((serverId) => disconnect(serverId));
    lifecycleHooksRegistered = true;
  }
  void connectAll();
}

// ---- Backward-compat shims used by index.ts and a few callers ----

/**
 * @deprecated Use `connect(serverId)` or `connectAll()` instead. Kept so the
 * single-server boot path used by the legacy index.ts still works.
 */
export function connectToPluginWebSocket(): void {
  void connectAll();
}

/**
 * @deprecated Use `disconnectAll()` instead. Preserved for SIGTERM/SIGINT
 * handlers in index.ts.
 */
export function disconnectFromPluginWebSocket(): void {
  disconnectAll();
}
