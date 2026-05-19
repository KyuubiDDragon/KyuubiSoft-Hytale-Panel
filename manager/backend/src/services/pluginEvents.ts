import { logger } from '../utils/logger.js';
/**
 * Plugin Events Service
 *
 * Connects to the KyuubiSoft API plugin's WebSocket to receive real-time events
 * and processes chat messages, death events, etc.
 */

import WebSocket from 'ws';
import { config } from '../config.js';
import { PLUGIN_PORT } from './kyuubiApi.js';
import { addChatMessage, recordDeathPosition } from './chatLog.js';
import { parsePluginEvent, type PluginEvent } from '../schemas/pluginEvents.js';
import { eventBus } from './eventBus.js';

// WebSocket connection state
let ws: WebSocket | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let isConnecting = false;
let isShuttingDown = false;

// Reconnection settings
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 60000; // 1 minute max
let currentReconnectDelay = RECONNECT_DELAY;

type PluginEventData = PluginEvent;

/**
 * Get the plugin host for WebSocket connection
 * Note: config.gameContainerName already has STACK_NAME fallback built in
 */
function getPluginHost(): string {
  return config.gameContainerName;
}

/**
 * Handle incoming event from the plugin
 */
async function handleEvent(event: PluginEventData): Promise<void> {
  switch (event.type) {
    case 'player_chat':
      logger.info(`[Chat] ${event.player}: ${event.message}`);
      await addChatMessage(event.player, event.message, event.uuid);
      eventBus.publish('player_chat', { player: event.player, uuid: event.uuid, message: event.message });
      break;

    case 'player_death':
      logger.info(`[Death] ${event.player} died${event.cause ? ` (${event.cause})` : ''}`);
      if (event.world && event.x !== undefined && event.y !== undefined && event.z !== undefined) {
        await recordDeathPosition(event.player, event.world, event.x, event.y, event.z);
      }
      eventBus.publish('player_death', {
        player: event.player, cause: event.cause, world: event.world, x: event.x, y: event.y, z: event.z,
      });
      break;

    case 'player_join':
      logger.info(`[Join] ${event.player}`);
      eventBus.publish('player_join', { player: event.player, uuid: event.uuid });
      break;

    case 'player_leave':
      logger.info(`[Leave] ${event.player}`);
      eventBus.publish('player_leave', { player: event.player, uuid: event.uuid });
      break;

    default:
      logger.info(`[Plugin Event] Unknown event type: ${(event as PluginEvent).type}`);
  }
}

/**
 * Connect to the plugin WebSocket
 */
export function connectToPluginWebSocket(): void {
  if (isShuttingDown || isConnecting || (ws && ws.readyState === WebSocket.OPEN)) {
    return;
  }

  isConnecting = true;
  const host = getPluginHost();
  const url = `ws://${host}:${PLUGIN_PORT}/ws`;

  logger.info(`Connecting to plugin WebSocket at ${url}...`);

  try {
    ws = new WebSocket(url);

    ws.on('open', () => {
      logger.info('Connected to plugin WebSocket');
      isConnecting = false;
      currentReconnectDelay = RECONNECT_DELAY; // Reset reconnect delay on successful connection
    });

    ws.on('message', async (data: WebSocket.Data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch (error) {
        logger.error('[Plugin] Malformed JSON from plugin WebSocket:', error);
        return;
      }
      const parsed = parsePluginEvent(raw);
      if (!parsed.ok) {
        // Plugin contract drift — surface loudly so it can be fixed instead of
        // silently feeding bad data into chat logs / death tracking.
        logger.warn(`[Plugin] Rejected event: ${parsed.error}`, raw);
        return;
      }
      try {
        await handleEvent(parsed.event);
      } catch (error) {
        logger.error('[Plugin] Handler error:', error);
      }
    });

    ws.on('close', () => {
      logger.info('Plugin WebSocket closed');
      isConnecting = false;
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', (error) => {
      // Only log if not a connection refused error (which is expected when plugin is not running)
      if (!(error as NodeJS.ErrnoException).code?.includes('ECONNREFUSED')) {
        logger.error('Plugin WebSocket error:', error.message);
      }
      isConnecting = false;
    });
  } catch (error) {
    logger.error('Failed to create WebSocket connection:', error);
    isConnecting = false;
    scheduleReconnect();
  }
}

/**
 * Schedule a reconnection attempt
 */
function scheduleReconnect(): void {
  if (isShuttingDown || reconnectTimeout) {
    return;
  }

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectToPluginWebSocket();

    // Increase delay for next attempt (exponential backoff)
    currentReconnectDelay = Math.min(currentReconnectDelay * 1.5, MAX_RECONNECT_DELAY);
  }, currentReconnectDelay);
}

/**
 * Disconnect from the plugin WebSocket
 */
export function disconnectFromPluginWebSocket(): void {
  isShuttingDown = true;

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (ws) {
    ws.close();
    ws = null;
  }
}

/**
 * Check if connected to the plugin WebSocket
 */
export function isConnectedToPlugin(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

/**
 * Initialize plugin events connection
 * This should be called on server startup
 */
export function initializePluginEvents(): void {
  logger.info('Initializing plugin events connection...');
  connectToPluginWebSocket();
}
