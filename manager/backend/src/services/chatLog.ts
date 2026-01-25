/**
 * Chat Logging Service
 *
 * Stores chat messages globally and per-player with daily file rotation.
 * Also tracks player death positions for teleportation.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import path from 'path';
import { isDemoMode, getDemoGlobalChatLog, getDemoPlayerChatLog } from './demoData.js';

// Chat message entry
export interface ChatMessage {
  id: string;
  timestamp: string;
  player: string;
  uuid?: string;
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

// In-memory cache for today's messages
let todaysChatLog: ChatMessage[] = [];
let currentDateKey: string = '';
const playerDeathPositions: Map<string, DeathPosition[]> = new Map();

// Limits
const MAX_DEATH_POSITIONS = 10; // Keep last 10 death positions per player

// Data directory paths
const DATA_DIR = process.env.DATA_PATH || '/app/data';
const CHAT_DIR = path.join(DATA_DIR, 'chat');
const GLOBAL_CHAT_DIR = path.join(CHAT_DIR, 'global');
const PLAYER_CHAT_DIR = path.join(CHAT_DIR, 'players');
const DEATHS_DIR = path.join(DATA_DIR, 'deaths');

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
async function ensureDirectories(): Promise<void> {
  try {
    await mkdir(GLOBAL_CHAT_DIR, { recursive: true });
    await mkdir(PLAYER_CHAT_DIR, { recursive: true });
    await mkdir(DEATHS_DIR, { recursive: true });
  } catch {
    // Directories may already exist
  }
}

// Get file path for global chat on a specific date
function getGlobalChatFilePath(dateKey: string): string {
  return path.join(GLOBAL_CHAT_DIR, `${dateKey}.json`);
}

// Get file path for player chat on a specific date
function getPlayerChatFilePath(playerName: string, dateKey: string): string {
  const normalized = normalizePlayerName(playerName);
  const playerDir = path.join(PLAYER_CHAT_DIR, normalized);
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
async function saveMessagesToFile(filePath: string, messages: ChatMessage[]): Promise<void> {
  await ensureDirectories();
  // Ensure parent directory exists
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(messages, null, 2), 'utf-8');
}

// Get list of available date files in a directory
async function getAvailableDates(directory: string): Promise<string[]> {
  try {
    const files = await readdir(directory);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse(); // Most recent first
  } catch {
    return [];
  }
}

// Load today's global chat log
async function loadTodaysChatLog(): Promise<void> {
  const today = getDateKey();
  if (currentDateKey !== today) {
    // Day changed, save previous and load new
    if (currentDateKey && todaysChatLog.length > 0) {
      await saveMessagesToFile(getGlobalChatFilePath(currentDateKey), todaysChatLog);
    }
    currentDateKey = today;
    todaysChatLog = await loadMessagesFromFile(getGlobalChatFilePath(today));
  }
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
export async function addChatMessage(player: string, message: string, uuid?: string): Promise<ChatMessage> {
  const entry: ChatMessage = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    player,
    uuid,
    message,
  };

  // Demo mode: return simulated entry without saving
  if (isDemoMode()) {
    return entry;
  }

  const today = getDateKey();
  await loadTodaysChatLog();

  // Add to today's global log
  todaysChatLog.push(entry);

  // Save global log
  saveMessagesToFile(getGlobalChatFilePath(today), todaysChatLog).catch(console.error);

  // Save to player's daily log
  const playerFilePath = getPlayerChatFilePath(player, today);
  loadMessagesFromFile(playerFilePath).then(async playerMessages => {
    playerMessages.push(entry);
    await saveMessagesToFile(playerFilePath, playerMessages);
  }).catch(console.error);

  return entry;
}

/**
 * Get global chat log with date range filter
 */
export async function getGlobalChatLog(options?: {
  days?: number; // Number of days to include (default: 7, 0 = all)
  limit?: number;
  offset?: number;
}): Promise<{ messages: ChatMessage[]; total: number; availableDays: number }> {
  // Demo mode: return mock chat data
  if (isDemoMode()) {
    return getDemoGlobalChatLog(options);
  }

  await loadTodaysChatLog();

  const days = options?.days ?? 7;
  const allMessages: ChatMessage[] = [];

  // Get available dates
  const availableDates = await getAvailableDates(GLOBAL_CHAT_DIR);
  const availableDays = availableDates.length;

  // Determine which dates to load
  let datesToLoad: string[];
  if (days === 0) {
    // Load all available dates
    datesToLoad = availableDates;
  } else {
    // Load only dates within the range
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    datesToLoad = availableDates.filter(dateKey => {
      const date = parseDateKey(dateKey);
      return date >= cutoffDate;
    });
  }

  // Load messages from each date
  for (const dateKey of datesToLoad) {
    if (dateKey === currentDateKey) {
      // Use cached today's messages
      allMessages.push(...todaysChatLog);
    } else {
      const messages = await loadMessagesFromFile(getGlobalChatFilePath(dateKey));
      allMessages.push(...messages);
    }
  }

  // Sort by timestamp descending (most recent first)
  allMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const total = allMessages.length;
  let result = allMessages;

  if (options?.offset) {
    result = result.slice(options.offset);
  }
  if (options?.limit) {
    result = result.slice(0, options.limit);
  }

  return { messages: result, total, availableDays };
}

/**
 * Get player chat log with date range filter
 */
export async function getPlayerChatLog(
  playerName: string,
  options?: {
    days?: number; // Number of days to include (default: 7, 0 = all)
    limit?: number;
    offset?: number;
  }
): Promise<{ messages: ChatMessage[]; total: number; availableDays: number }> {
  // Demo mode: return mock chat data for player
  if (isDemoMode()) {
    return getDemoPlayerChatLog(playerName, options);
  }

  const normalized = normalizePlayerName(playerName);
  const playerDir = path.join(PLAYER_CHAT_DIR, normalized);
  const days = options?.days ?? 7;
  const allMessages: ChatMessage[] = [];

  // Get available dates for this player
  const availableDates = await getAvailableDates(playerDir);
  const availableDays = availableDates.length;

  // Determine which dates to load
  let datesToLoad: string[];
  if (days === 0) {
    datesToLoad = availableDates;
  } else {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    datesToLoad = availableDates.filter(dateKey => {
      const date = parseDateKey(dateKey);
      return date >= cutoffDate;
    });
  }

  // Load messages from each date
  for (const dateKey of datesToLoad) {
    const messages = await loadMessagesFromFile(getPlayerChatFilePath(playerName, dateKey));
    allMessages.push(...messages);
  }

  // Sort by timestamp descending
  allMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const total = allMessages.length;
  let result = allMessages;

  if (options?.offset) {
    result = result.slice(options.offset);
  }
  if (options?.limit) {
    result = result.slice(0, options.limit);
  }

  return { messages: result, total, availableDays };
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

  // Demo mode: return simulated entry without saving
  if (isDemoMode()) {
    return entry;
  }

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
loadTodaysChatLog().catch(console.error);
