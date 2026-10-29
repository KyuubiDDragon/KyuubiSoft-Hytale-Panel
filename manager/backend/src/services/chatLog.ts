/**
 * Chat Logging Service
 *
 * Stores chat messages per server, globally and per player, with daily file
 * rotation. Also tracks player death positions for teleportation.
 *
 * Each server has its own folders (services/perServerData.ts): the compose
 * server keeps `chat/` and `deaths/` in the manager data folder as before,
 * other servers use `servers/<id>/chat/` and `servers/<id>/deaths/`.
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import path from 'path';
import { isDemoMode, getDemoGlobalChatLog, getDemoPlayerChatLog } from './demoData.js';
import { onServerDeleted, resolveServerId } from './servers.js';
import { COMPOSE_SERVER_ID, isValidServerId, managerDataDir } from './perServerData.js';

// Chat message entry
export interface ChatMessage {
  id: string;
  timestamp: string;
  player: string;
  uuid?: string;
  message: string;
  /** Server the message was sent on; missing in entries from before per-server logs. */
  serverId?: string;
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

// In-memory cache for today's messages, per server
const todaysChatLogs = new Map<string, { dateKey: string; messages: ChatMessage[] }>();
// Death positions per server and normalized player name
const playerDeathPositions: Map<string, DeathPosition[]> = new Map();

// Limits
const MAX_DEATH_POSITIONS = 10; // Keep last 10 death positions per player

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';

interface ChatDirs {
  global: string;
  players: string;
  deaths: string;
}

// Data directory paths of one server
function chatDirs(serverId: string): ChatDirs {
  const root = managerDataDir(serverId);
  return {
    global: path.join(root, 'chat', 'global'),
    players: path.join(root, 'chat', 'players'),
    deaths: path.join(root, 'deaths'),
  };
}

// Generate unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Get date key for file naming (YYYY-MM-DD)
function getDateKey(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

// Parse date key back to Date
function parseDateKey(dateKey: string): Date {
  return new Date(dateKey + 'T00:00:00.000Z');
}

// Normalize player name for file storage (lowercase)
function normalizePlayerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

// Ensure directories exist
async function ensureDirectories(dirs: ChatDirs): Promise<void> {
  try {
    await mkdir(dirs.global, { recursive: true });
    await mkdir(dirs.players, { recursive: true });
    await mkdir(dirs.deaths, { recursive: true });
  } catch {
    // Directories may already exist
  }
}

// Get file path for global chat on a specific date
function getGlobalChatFilePath(dirs: ChatDirs, dateKey: string): string {
  return path.join(dirs.global, `${dateKey}.json`);
}

// Get file path for player chat on a specific date
function getPlayerChatFilePath(dirs: ChatDirs, playerName: string, dateKey: string): string {
  const normalized = normalizePlayerName(playerName);
  const playerDir = path.join(dirs.players, normalized);
  return path.join(playerDir, `${dateKey}.json`);
}

// Load messages from a specific date file
async function loadMessagesFromFile(filePath: string): Promise<ChatMessage[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Save messages to a file
async function saveMessagesToFile(
  dirs: ChatDirs,
  filePath: string,
  messages: ChatMessage[],
): Promise<void> {
  await ensureDirectories(dirs);
  // Ensure parent directory exists
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(messages, null, 2), 'utf-8');
}

// Get list of available date files in a directory
async function getAvailableDates(directory: string): Promise<string[]> {
  try {
    const files = await readdir(directory);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''))
      .sort()
      .reverse(); // Most recent first
  } catch {
    return [];
  }
}

// Load today's global chat log of a server
async function loadTodaysChatLog(
  serverId: string,
): Promise<{ dateKey: string; messages: ChatMessage[] }> {
  const today = getDateKey();
  const dirs = chatDirs(serverId);
  const current = todaysChatLogs.get(serverId);
  if (current?.dateKey === today) return current;
  // Day changed, save previous and load new
  if (current && current.messages.length > 0) {
    await saveMessagesToFile(dirs, getGlobalChatFilePath(dirs, current.dateKey), current.messages);
  }
  const next = {
    dateKey: today,
    messages: await loadMessagesFromFile(getGlobalChatFilePath(dirs, today)),
  };
  // A concurrent load for the same day may have won; keep its messages.
  const raced = todaysChatLogs.get(serverId);
  if (raced?.dateKey === today) return raced;
  todaysChatLogs.set(serverId, next);
  return next;
}

const deathKey = (serverId: string, normalized: string) => `${serverId}\u0000${normalized}`;

// The caches of a removed server go with it (its files stay on disk).
let deleteHookRegistered = false;
function forgetDeletedServers(): void {
  if (deleteHookRegistered) return;
  deleteHookRegistered = true;
  onServerDeleted((serverId) => {
    todaysChatLogs.delete(serverId);
    const prefix = deathKey(serverId, '');
    for (const key of [...playerDeathPositions.keys()]) {
      if (key.startsWith(prefix)) playerDeathPositions.delete(key);
    }
  });
}

// Load player death positions
async function loadPlayerDeathPositions(
  serverId: string,
  playerName: string,
): Promise<DeathPosition[]> {
  const normalized = normalizePlayerName(playerName);
  const key = deathKey(serverId, normalized);
  const cached = playerDeathPositions.get(key);
  if (cached) return cached;

  try {
    const filePath = path.join(chatDirs(serverId).deaths, `${normalized}.json`);
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      const positions = data.slice(-MAX_DEATH_POSITIONS);
      playerDeathPositions.set(key, positions);
      return positions;
    }
  } catch {
    // File doesn't exist
  }

  const empty: DeathPosition[] = [];
  playerDeathPositions.set(key, empty);
  return empty;
}

// Save player death positions
async function savePlayerDeathPositions(serverId: string, playerName: string): Promise<void> {
  const dirs = chatDirs(serverId);
  await ensureDirectories(dirs);
  const normalized = normalizePlayerName(playerName);
  const positions = playerDeathPositions.get(deathKey(serverId, normalized)) || [];
  const filePath = path.join(dirs.deaths, `${normalized}.json`);
  await writeFile(
    filePath,
    JSON.stringify(positions.slice(-MAX_DEATH_POSITIONS), null, 2),
    'utf-8',
  );
}

/**
 * Add a chat message sent on a server (stores globally and per player)
 */
export async function addChatMessage(
  serverId: string,
  player: string,
  message: string,
  uuid?: string,
): Promise<ChatMessage> {
  const entry: ChatMessage = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    player,
    uuid,
    message,
    serverId,
  };

  // Demo mode: return simulated entry without saving
  if (isDemoMode()) {
    return entry;
  }

  forgetDeletedServers();
  const dirs = chatDirs(serverId);
  const todays = await loadTodaysChatLog(serverId);

  // Add to today's global log
  todays.messages.push(entry);

  // Save global log
  saveMessagesToFile(dirs, getGlobalChatFilePath(dirs, todays.dateKey), todays.messages).catch(
    console.error,
  );

  // Save to player's daily log
  const playerFilePath = getPlayerChatFilePath(dirs, player, todays.dateKey);
  loadMessagesFromFile(playerFilePath)
    .then(async (playerMessages) => {
      playerMessages.push(entry);
      await saveMessagesToFile(dirs, playerFilePath, playerMessages);
    })
    .catch(console.error);

  return entry;
}

interface ChatLogOptions {
  days?: number; // Number of days to include (default: 7, 0 = all)
  limit?: number;
  offset?: number;
}

/** The date keys of `available` inside the `days` window (0 = all). */
function datesInRange(available: string[], days: number): string[] {
  if (days === 0) return available;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  return available.filter((dateKey) => parseDateKey(dateKey) >= cutoffDate);
}

/** Newest first, then offset and limit. */
function page(
  allMessages: ChatMessage[],
  options: ChatLogOptions | undefined,
): { messages: ChatMessage[]; total: number } {
  allMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  let result = allMessages;
  if (options?.offset) {
    result = result.slice(options.offset);
  }
  if (options?.limit) {
    result = result.slice(0, options.limit);
  }
  return { messages: result, total: allMessages.length };
}

/**
 * Get a server's global chat log with date range filter; `undefined` is the
 * default server.
 */
export async function getGlobalChatLog(
  options?: ChatLogOptions,
  serverId?: string,
): Promise<{ messages: ChatMessage[]; total: number; availableDays: number }> {
  // Demo mode: return mock chat data
  if (isDemoMode()) {
    return getDemoGlobalChatLog(options);
  }

  const id = await resolveServerId(serverId);
  const dirs = chatDirs(id);
  const todays = await loadTodaysChatLog(id);

  // Get available dates
  const availableDates = await getAvailableDates(dirs.global);
  const availableDays = availableDates.length;
  const allMessages: ChatMessage[] = [];

  // Load messages from each date
  for (const dateKey of datesInRange(availableDates, options?.days ?? 7)) {
    if (dateKey === todays.dateKey) {
      // Use cached today's messages
      allMessages.push(...todays.messages);
    } else {
      allMessages.push(...(await loadMessagesFromFile(getGlobalChatFilePath(dirs, dateKey))));
    }
  }

  return { ...page(allMessages, options), availableDays };
}

async function playerMessagesOn(
  serverId: string,
  playerName: string,
  days: number,
): Promise<{ messages: ChatMessage[]; availableDays: number }> {
  const dirs = chatDirs(serverId);
  const playerDir = path.join(dirs.players, normalizePlayerName(playerName));
  const availableDates = await getAvailableDates(playerDir);
  const messages: ChatMessage[] = [];
  for (const dateKey of datesInRange(availableDates, days)) {
    messages.push(
      ...(await loadMessagesFromFile(getPlayerChatFilePath(dirs, playerName, dateKey))),
    );
  }
  return { messages, availableDays: availableDates.length };
}

/**
 * Get a player's chat log on one server with date range filter; `undefined`
 * is the default server.
 */
export async function getPlayerChatLog(
  playerName: string,
  options?: ChatLogOptions,
  serverId?: string,
): Promise<{ messages: ChatMessage[]; total: number; availableDays: number }> {
  // Demo mode: return mock chat data for player
  if (isDemoMode()) {
    return getDemoPlayerChatLog(playerName, options);
  }

  const { messages, availableDays } = await playerMessagesOn(
    await resolveServerId(serverId),
    playerName,
    options?.days ?? 7,
  );
  return { ...page(messages, options), availableDays };
}

/**
 * Ids of every server with chat records on disk: the compose server and each
 * folder under servers/ (also of servers removed since).
 */
async function serversWithChatData(): Promise<string[]> {
  const ids = [COMPOSE_SERVER_ID];
  try {
    for (const name of await readdir(path.join(DATA_DIR, 'servers'))) {
      if (isValidServerId(name) && name !== COMPOSE_SERVER_ID) ids.push(name);
    }
  } catch {
    // No other server has records yet.
  }
  return ids;
}

/** The servers a data export or erasure covers: one server, or every one for null. */
async function chatScope(serverId: string | null): Promise<string[]> {
  return serverId === null ? serversWithChatData() : [serverId];
}

/**
 * A player's whole chat history on `serverId` (on every server for null),
 * newest first, each message with its server (data export).
 */
export async function getPlayerChatHistory(
  playerName: string,
  serverId: string | null,
): Promise<ChatMessage[]> {
  if (isDemoMode()) return [];
  const all: ChatMessage[] = [];
  for (const id of await chatScope(serverId)) {
    const { messages } = await playerMessagesOn(id, playerName, 0);
    all.push(...messages.map((m) => ({ ...m, serverId: m.serverId ?? id })));
  }
  return page(all, undefined).messages;
}

/**
 * Record a player death position on a server
 */
export async function recordDeathPosition(
  serverId: string,
  player: string,
  world: string,
  x: number,
  y: number,
  z: number,
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

  // Demo mode: return simulated entry without saving
  if (isDemoMode()) {
    return entry;
  }

  forgetDeletedServers();
  const positions = await loadPlayerDeathPositions(serverId, player);
  positions.push(entry);
  while (positions.length > MAX_DEATH_POSITIONS) {
    positions.shift();
  }

  // Save asynchronously
  savePlayerDeathPositions(serverId, player).catch(console.error);

  return entry;
}

/**
 * Get player's last death position on a server
 */
export async function getLastDeathPosition(
  playerName: string,
  serverId?: string,
): Promise<DeathPosition | null> {
  const positions = await loadPlayerDeathPositions(await resolveServerId(serverId), playerName);
  return positions.length > 0 ? positions[positions.length - 1] : null;
}

/**
 * Get all death positions for a player on a server
 */
export async function getPlayerDeathPositions(
  playerName: string,
  options?: {
    limit?: number;
  },
  serverId?: string,
): Promise<DeathPosition[]> {
  const positions = await loadPlayerDeathPositions(await resolveServerId(serverId), playerName);
  let result = [...positions].reverse(); // Most recent first

  if (options?.limit) {
    result = result.slice(0, options.limit);
  }

  return result;
}

/**
 * Erase a player's per-player chat history + death positions on `serverId`
 * (on every server for null; GDPR erasure). Their lines in the GLOBAL daily logs are left in place —
 * rewriting every global file is expensive and the global log is an
 * aggregate moderation record; the per-player store is the personal-data
 * copy. Returns true if every folder could be removed.
 */
export async function deletePlayerChatData(
  playerName: string,
  serverId: string | null,
): Promise<boolean> {
  if (isDemoMode()) return true;
  const normalized = normalizePlayerName(playerName);
  let ok = true;
  for (const id of await chatScope(serverId)) {
    const dirs = chatDirs(id);
    try {
      await rm(path.join(dirs.players, normalized), { recursive: true, force: true });
      await rm(path.join(dirs.deaths, `${normalized}.json`), { force: true });
      playerDeathPositions.delete(deathKey(id, normalized));
    } catch {
      ok = false;
    }
  }
  return ok;
}
