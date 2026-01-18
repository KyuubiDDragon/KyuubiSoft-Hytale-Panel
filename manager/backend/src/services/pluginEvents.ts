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

// WebSocket connection state
let ws: WebSocket | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let isConnecting = false;
let isShuttingDown = false;

// Reconnection settings
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 60000; // 1 minute max
let currentReconnectDelay = RECONNECT_DELAY;

// Event types from the plugin
interface PluginEvent {
  type: string;
  timestamp: string;
}

interface PlayerChatEvent extends PluginEvent {
  type: 'player_chat';
  player: string;
  message: string;
}

interface PlayerDeathEvent extends PluginEvent {
  type: 'player_death';
  player: string;
  cause: string;
  world?: string;
  x?: number;
  y?: number;
  z?: number;
}

interface PlayerJoinEvent extends PluginEvent {
  type: 'player_join';
  player: string;
  uuid: string;
}

interface PlayerLeaveEvent extends PluginEvent {
  type: 'player_leave';
  player: string;
  uuid: string;
}

type PluginEventData = PlayerChatEvent | PlayerDeathEvent | PlayerJoinEvent | PlayerLeaveEvent;

/**
 * Get the plugin host for WebSocket connection
 */
function getPluginHost(): string {
  return process.env.GAME_CONTAINER_NAME || config.gameContainerName || 'hytale';
}

/**
 * Handle incoming event from the plugin
 */
async function handleEvent(event: PluginEventData): Promise<void> {
  switch (event.type) {
    case 'player_chat':
      console.log(`[Chat] ${event.player}: ${event.message}`);
      await addChatMessage(event.player, event.message);
      break;

    case 'player_death':
      console.log(`[Death] ${event.player} died${event.cause ? ` (${event.cause})` : ''}`);
      if (event.world && event.x !== undefined && event.y !== undefined && event.z !== undefined) {
        await recordDeathPosition(event.player, event.world, event.x, event.y, event.z);
      }
      break;

    case 'player_join':
      console.log(`[Join] ${event.player}`);
      // Player join is already handled by the player tracking service
      break;

    case 'player_leave':
      console.log(`[Leave] ${event.player}`);
      // Player leave is already handled by the player tracking service
      break;

    default:
      console.log(`[Plugin Event] Unknown event type: ${(event as PluginEvent).type}`);
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

  console.log(`Connecting to plugin WebSocket at ${url}...`);

  try {
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('Connected to plugin WebSocket');
      isConnecting = false;
      currentReconnectDelay = RECONNECT_DELAY; // Reset reconnect delay on successful connection
    });

    ws.on('message', async (data: WebSocket.Data) => {
      try {
        const event = JSON.parse(data.toString()) as PluginEventData;
        await handleEvent(event);
      } catch (error) {
        console.error('Failed to parse plugin event:', error);
      }
    });

    ws.on('close', () => {
      console.log('Plugin WebSocket closed');
      isConnecting = false;
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', (error) => {
      // Only log if not a connection refused error (which is expected when plugin is not running)
      if (!(error as NodeJS.ErrnoException).code?.includes('ECONNREFUSED')) {
        console.error('Plugin WebSocket error:', error.message);
      }
      isConnecting = false;
    });
  } catch (error) {
    console.error('Failed to create WebSocket connection:', error);
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
  console.log('Initializing plugin events connection...');
  connectToPluginWebSocket();
}
