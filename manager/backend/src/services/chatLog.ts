/**
 * Chat Logging Service
 *
 * Stores chat messages globally and per-player.
 * Also tracks player death positions for teleportation.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

// Chat message entry
export interface ChatMessage {
  id: string;
  timestamp: string;
  player: string;
  message: string;
}

// Death position entry
export interface DeathPosition {
  id: string;
  timestamp: string;
  player: string;
  world: string;
  x: number;
  y: number;
  z: number;
}

// In-memory storage
const globalChatLog: ChatMessage[] = [];
const playerChatLogs: Map<string, ChatMessage[]> = new Map();
const playerDeathPositions: Map<string, DeathPosition[]> = new Map();

// Limits
const MAX_GLOBAL_MESSAGES = 1000;
const MAX_PLAYER_MESSAGES = 200;
const MAX_DEATH_POSITIONS = 10; // Keep last 10 death positions per player

// Data directory paths
const DATA_DIR = process.env.DATA_PATH || '/app/data';
const CHAT_DIR = path.join(DATA_DIR, 'chat');
const GLOBAL_CHAT_FILE = path.join(CHAT_DIR, 'global.json');
const PLAYER_CHAT_DIR = path.join(CHAT_DIR, 'players');
const DEATHS_DIR = path.join(DATA_DIR, 'deaths');

// Generate unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Normalize player name for file storage (lowercase)
function normalizePlayerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

// Ensure directories exist
async function ensureDirectories(): Promise<void> {
  try {
    await mkdir(CHAT_DIR, { recursive: true });
    await mkdir(PLAYER_CHAT_DIR, { recursive: true });
    await mkdir(DEATHS_DIR, { recursive: true });
  } catch {
    // Directories may already exist
  }
}

// Load global chat log
export async function loadGlobalChatLog(): Promise<void> {
  try {
    const content = await readFile(GLOBAL_CHAT_FILE, 'utf-8');
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      globalChatLog.push(...data.slice(-MAX_GLOBAL_MESSAGES));
    }
  } catch {
    // File doesn't exist, start empty
  }
}

// Save global chat log
async function saveGlobalChatLog(): Promise<void> {
  await ensureDirectories();
  await writeFile(
    GLOBAL_CHAT_FILE,
    JSON.stringify(globalChatLog.slice(-MAX_GLOBAL_MESSAGES), null, 2),
    'utf-8'
  );
}

// Load player chat log
async function loadPlayerChatLog(playerName: string): Promise<ChatMessage[]> {
  const normalized = normalizePlayerName(playerName);
  const cached = playerChatLogs.get(normalized);
  if (cached) return cached;

  try {
    const filePath = path.join(PLAYER_CHAT_DIR, `${normalized}.json`);
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      const messages = data.slice(-MAX_PLAYER_MESSAGES);
      playerChatLogs.set(normalized, messages);
      return messages;
    }
  } catch {
    // File doesn't exist
  }

  const empty: ChatMessage[] = [];
  playerChatLogs.set(normalized, empty);
  return empty;
}

// Save player chat log
async function savePlayerChatLog(playerName: string): Promise<void> {
  await ensureDirectories();
  const normalized = normalizePlayerName(playerName);
  const messages = playerChatLogs.get(normalized) || [];
  const filePath = path.join(PLAYER_CHAT_DIR, `${normalized}.json`);
  await writeFile(
    filePath,
    JSON.stringify(messages.slice(-MAX_PLAYER_MESSAGES), null, 2),
    'utf-8'
  );
}

// Load player death positions
async function loadPlayerDeathPositions(playerName: string): Promise<DeathPosition[]> {
  const normalized = normalizePlayerName(playerName);
  const cached = playerDeathPositions.get(normalized);
  if (cached) return cached;

  try {
    const filePath = path.join(DEATHS_DIR, `${normalized}.json`);
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      const positions = data.slice(-MAX_DEATH_POSITIONS);
      playerDeathPositions.set(normalized, positions);
      return positions;
    }
  } catch {
    // File doesn't exist
  }

  const empty: DeathPosition[] = [];
  playerDeathPositions.set(normalized, empty);
  return empty;
}

// Save player death positions
async function savePlayerDeathPositions(playerName: string): Promise<void> {
  await ensureDirectories();
  const normalized = normalizePlayerName(playerName);
  const positions = playerDeathPositions.get(normalized) || [];
  const filePath = path.join(DEATHS_DIR, `${normalized}.json`);
  await writeFile(
    filePath,
    JSON.stringify(positions.slice(-MAX_DEATH_POSITIONS), null, 2),
    'utf-8'
  );
}

/**
 * Add a chat message (stores globally and per-player)
 */
export async function addChatMessage(player: string, message: string): Promise<ChatMessage> {
  const entry: ChatMessage = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    player,
    message,
  };

  // Add to global log
  globalChatLog.push(entry);
  while (globalChatLog.length > MAX_GLOBAL_MESSAGES) {
    globalChatLog.shift();
  }

  // Add to player log
  const playerLog = await loadPlayerChatLog(player);
  playerLog.push(entry);
  while (playerLog.length > MAX_PLAYER_MESSAGES) {
    playerLog.shift();
  }

  // Save asynchronously
  saveGlobalChatLog().catch(console.error);
  savePlayerChatLog(player).catch(console.error);

  return entry;
}

/**
 * Get global chat log
 */
export function getGlobalChatLog(options?: {
  limit?: number;
  offset?: number;
}): { messages: ChatMessage[]; total: number } {
  let messages = [...globalChatLog].reverse(); // Most recent first
  const total = messages.length;

  if (options?.offset) {
    messages = messages.slice(options.offset);
  }
  if (options?.limit) {
    messages = messages.slice(0, options.limit);
  }

  return { messages, total };
}

/**
 * Get player chat log
 */
export async function getPlayerChatLog(
  playerName: string,
  options?: {
    limit?: number;
    offset?: number;
  }
): Promise<{ messages: ChatMessage[]; total: number }> {
  const playerLog = await loadPlayerChatLog(playerName);
  let messages = [...playerLog].reverse(); // Most recent first
  const total = messages.length;

  if (options?.offset) {
    messages = messages.slice(options.offset);
  }
  if (options?.limit) {
    messages = messages.slice(0, options.limit);
  }

  return { messages, total };
}

/**
 * Record a player death position
 */
export async function recordDeathPosition(
  player: string,
  world: string,
  x: number,
  y: number,
  z: number
): Promise<DeathPosition> {
  const entry: DeathPosition = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    player,
    world,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    z: Math.round(z * 100) / 100,
  };

  const positions = await loadPlayerDeathPositions(player);
  positions.push(entry);
  while (positions.length > MAX_DEATH_POSITIONS) {
    positions.shift();
  }

  // Save asynchronously
  savePlayerDeathPositions(player).catch(console.error);

  return entry;
}

/**
 * Get player's last death position
 */
export async function getLastDeathPosition(playerName: string): Promise<DeathPosition | null> {
  const positions = await loadPlayerDeathPositions(playerName);
  return positions.length > 0 ? positions[positions.length - 1] : null;
}

/**
 * Get all death positions for a player
 */
export async function getPlayerDeathPositions(
  playerName: string,
  options?: {
    limit?: number;
  }
): Promise<DeathPosition[]> {
  const positions = await loadPlayerDeathPositions(playerName);
  let result = [...positions].reverse(); // Most recent first

  if (options?.limit) {
    result = result.slice(0, options.limit);
  }

  return result;
}

// Initialize on module load
loadGlobalChatLog().catch(console.error);
