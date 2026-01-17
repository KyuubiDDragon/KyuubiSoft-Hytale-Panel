import { getLogs } from './docker.js';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import type { PlayerInfo } from '../types/index.js';

// Extended online player info
interface OnlinePlayerData {
  joinedAt: Date;
  uuid?: string;
  ip?: string;
  world?: string;
  lastActivity?: Date;
}

// Player tracking state
const onlinePlayers: Map<string, OnlinePlayerData> = new Map();
let onlinePlayersLoaded = false;

// Blacklist of names that should never be considered players
const PLAYER_NAME_BLACKLIST = new Set([
  'client',
  'server',
  'system',
  'admin',
  'console',
  'websocket',
  'socket',
  'connection',
  'user',
  'player',  // generic "player" without actual name
]);

// Minimum player name length to be considered valid
const MIN_PLAYER_NAME_LENGTH = 3;

function isValidPlayerName(name: string): boolean {
  if (!name || name.length < MIN_PLAYER_NAME_LENGTH) return false;
  if (PLAYER_NAME_BLACKLIST.has(name.toLowerCase())) return false;
  // Player names should be alphanumeric with underscores, start with a letter
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) return false;
  return true;
}

// Player history tracking
export interface PlayerHistoryEntry {
  name: string;
  uuid?: string;
  firstSeen: string;
  lastSeen: string;
  playTime: number; // Total playtime in seconds
  sessionCount: number;
}

let playerHistory: Map<string, PlayerHistoryEntry> = new Map();
let historyLoaded = false;

async function getHistoryPath(): Promise<string> {
  return path.join(config.serverPath, 'player-history.json');
}

async function getOnlinePlayersPath(): Promise<string> {
  return path.join(config.serverPath, 'online-players.json');
}

interface OnlinePlayerEntry {
  name: string;
  joinedAt: string;
  uuid?: string;
  ip?: string;
  world?: string;
  lastActivity?: string;
}

async function loadOnlinePlayers(): Promise<void> {
  if (onlinePlayersLoaded) return;
  try {
    const content = await readFile(await getOnlinePlayersPath(), 'utf-8');
    const data: OnlinePlayerEntry[] = JSON.parse(content);
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (isValidPlayerName(entry.name)) {
          onlinePlayers.set(entry.name, {
            joinedAt: new Date(entry.joinedAt),
            uuid: entry.uuid,
            ip: entry.ip,
            world: entry.world,
            lastActivity: entry.lastActivity ? new Date(entry.lastActivity) : undefined,
          });
        }
      }
      console.log(`[Players] Loaded ${onlinePlayers.size} online players from persistent storage`);
    }
  } catch {
    // File doesn't exist yet, start with empty list
    console.log('[Players] No persistent online players file found, starting fresh');
  }
  onlinePlayersLoaded = true;
}

async function saveOnlinePlayers(): Promise<void> {
  const data: OnlinePlayerEntry[] = [];
  for (const [name, playerData] of onlinePlayers) {
    data.push({
      name,
      joinedAt: playerData.joinedAt.toISOString(),
      uuid: playerData.uuid,
      ip: playerData.ip,
      world: playerData.world,
      lastActivity: playerData.lastActivity?.toISOString(),
    });
  }
  await writeFile(await getOnlinePlayersPath(), JSON.stringify(data, null, 2), 'utf-8');
}

async function loadPlayerHistory(): Promise<void> {
  if (historyLoaded) return;
  try {
    const content = await readFile(await getHistoryPath(), 'utf-8');
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      for (const entry of data) {
        playerHistory.set(entry.name, entry);
      }
    }
  } catch {
    // File doesn't exist yet, start with empty history
  }
  historyLoaded = true;
}

async function savePlayerHistory(): Promise<void> {
  const data = Array.from(playerHistory.values());
  await writeFile(await getHistoryPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function recordPlayerJoin(name: string, uuid?: string): void {
  const now = new Date().toISOString();
  const existing = playerHistory.get(name);

  if (existing) {
    existing.lastSeen = now;
    existing.sessionCount++;
    if (uuid && !existing.uuid) {
      existing.uuid = uuid;
    }
  } else {
    playerHistory.set(name, {
      name,
      uuid,
      firstSeen: now,
      lastSeen: now,
      playTime: 0,
      sessionCount: 1,
    });
  }

  // Save async (don't await to not block)
  savePlayerHistory().catch(err => console.error('Failed to save player history:', err));
}

function recordPlayerLeave(name: string): void {
  const existing = playerHistory.get(name);
  const playerData = onlinePlayers.get(name);

  if (existing && playerData) {
    const sessionDuration = Math.floor((Date.now() - playerData.joinedAt.getTime()) / 1000);
    existing.playTime += sessionDuration;
    existing.lastSeen = new Date().toISOString();

    // Save async
    savePlayerHistory().catch(err => console.error('Failed to save player history:', err));
  }
}

export async function getPlayerHistory(): Promise<PlayerHistoryEntry[]> {
  await loadPlayerHistory();
  return Array.from(playerHistory.values()).sort((a, b) =>
    new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
  );
}

export async function getOfflinePlayers(): Promise<PlayerHistoryEntry[]> {
  await loadPlayerHistory();
  // Scan logs to ensure onlinePlayers map is up-to-date before filtering
  await scanLogs();
  const onlineNames = new Set(onlinePlayers.keys());
  return Array.from(playerHistory.values())
    .filter(p => !onlineNames.has(p.name))
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
}

// Patterns for player events - Hytale Server specific patterns first
// Player names can contain letters, numbers, underscores
const JOIN_PATTERNS = [
  // Hytale Server specific patterns (from actual logs)
  /\[Universe\|P\]\s+Adding player '(\w+)/i,
  /\[World\|.*?\]\s+Player '(\w+)' joined world/i,
  /\[World\|.*?\]\s+Adding player '(\w+)' to world/i,
  /Starting authenticated flow for (\w+)/i,
  /Connection complete for (\w+)/i,
  /Identity token validated for (\w+)/i,
  // Generic fallback patterns (more specific to avoid false positives)
  /Player\s+(\w+)\s+joined/i,
  /Player\s+(\w+)\s+connected to the server/i,
  /(\w+)\s+joined the game/i,
  /(\w+)\s+joined the server/i,
  /(\w+)\s+has joined the game/i,
  /(\w+)\s+logged in with entity id/i,
];

// Additional patterns to extract more player info
const UUID_PATTERNS = [
  /UUID of player (\w+) is ([a-f0-9-]+)/i,
  /(\w+)\[.*?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
  /Identity token validated for (\w+).*?([a-f0-9-]{36})/i,
];

const IP_PATTERNS = [
  /(\w+)\[\/([0-9.]+):\d+\]/i,
  /(\w+) logged in with.*from \/([0-9.]+)/i,
  /Connection from \/([0-9.]+):\d+.*player[:\s]+(\w+)/i,
  /(\w+).*connected from ([0-9.]+)/i,
];

const WORLD_PATTERNS = [
  /\[World\|(\w+)\]\s+Player '(\w+)'/i,
  /(\w+) joined world '?(\w+)'?/i,
  /Adding player '(\w+)' to world '?(\w+)'?/i,
];

// Helper to extract additional info from log line
function extractPlayerInfo(line: string, playerName: string): Partial<OnlinePlayerData> {
  const info: Partial<OnlinePlayerData> = {};

  // Try to extract UUID
  for (const pattern of UUID_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      // Check if player name matches (could be in different capture groups)
      if (match[1]?.toLowerCase() === playerName.toLowerCase()) {
        info.uuid = match[2];
      } else if (match[2]?.toLowerCase() === playerName.toLowerCase()) {
        info.uuid = match[1];
      }
      break;
    }
  }

  // Try to extract IP
  for (const pattern of IP_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      if (match[1]?.toLowerCase() === playerName.toLowerCase()) {
        info.ip = match[2];
      } else if (match[2]?.toLowerCase() === playerName.toLowerCase()) {
        info.ip = match[1];
      }
      break;
    }
  }

  // Try to extract World
  for (const pattern of WORLD_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      if (match[1]?.toLowerCase() === playerName.toLowerCase()) {
        info.world = match[2];
      } else if (match[2]?.toLowerCase() === playerName.toLowerCase()) {
        info.world = match[1];
      }
      break;
    }
  }

  return info;
}

const LEAVE_PATTERNS = [
  // Hytale Server specific patterns (from actual logs)
  /Disconnecting (\w+) at/i,
  /\[Universe\|P\]\s+Removing player '(\w+)/i,
  /\[PlayerSystems\]\s+Removing player '(\w+)/i,
  // Generic fallback patterns
  /Player\s+(\w+)\s+left/i,
  /Player\s+(\w+)\s+disconnected/i,
  /(\w+)\s+left the game/i,
  /(\w+)\s+left the server/i,
  /(\w+)\s+has left/i,
  /(\w+)\s+disconnected/i,
  /(\w+)\s+logged out/i,
  /(\w+)\s+quit/i,
  /(\w+)\s+timed out/i,
  /(\w+)\s+lost connection/i,
];

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export async function scanLogs(): Promise<void> {
  // Load persisted online players first
  await loadOnlinePlayers();

  const logs = await getLogs(500);
  if (!logs) return;

  const lines = logs.split('\n');
  let changed = false;

  for (const line of lines) {
    // Check for join
    for (const pattern of JOIN_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const player = match[1];
        if (isValidPlayerName(player)) {
          const existing = onlinePlayers.get(player);
          if (!existing) {
            // New player - extract additional info
            const extraInfo = extractPlayerInfo(line, player);
            onlinePlayers.set(player, {
              joinedAt: new Date(),
              lastActivity: new Date(),
              ...extraInfo,
            });
            changed = true;
          } else {
            // Update existing player info if we find more details
            const extraInfo = extractPlayerInfo(line, player);
            if (extraInfo.uuid && !existing.uuid) existing.uuid = extraInfo.uuid;
            if (extraInfo.ip && !existing.ip) existing.ip = extraInfo.ip;
            if (extraInfo.world) existing.world = extraInfo.world;
            existing.lastActivity = new Date();
            changed = true;
          }
        }
        break;
      }
    }

    // Check for leave
    for (const pattern of LEAVE_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const player = match[1];
        if (isValidPlayerName(player) && onlinePlayers.has(player)) {
          onlinePlayers.delete(player);
          changed = true;
        }
        break;
      }
    }
  }

  // Persist changes
  if (changed) {
    saveOnlinePlayers().catch(err => console.error('Failed to save online players:', err));
  }
}

export async function getOnlinePlayers(): Promise<PlayerInfo[]> {
  await scanLogs();

  const now = new Date();
  const players: PlayerInfo[] = [];

  for (const [name, playerData] of onlinePlayers) {
    const durationMs = now.getTime() - playerData.joinedAt.getTime();
    players.push({
      name,
      joined_at: playerData.joinedAt.toISOString(),
      session_duration_seconds: Math.floor(durationMs / 1000),
      session_duration: formatDuration(durationMs),
    });
  }

  return players;
}

export async function getPlayerCount(): Promise<number> {
  await scanLogs();
  return onlinePlayers.size;
}

export function removePlayer(name: string): void {
  if (onlinePlayers.has(name)) {
    onlinePlayers.delete(name);
    saveOnlinePlayers().catch(err => console.error('Failed to save online players:', err));
  }
}

/**
 * Initialize player tracking - loads persisted data and scans logs
 * Call this on server startup to restore state
 */
export async function initializePlayerTracking(): Promise<void> {
  console.log('[Players] Initializing player tracking...');
  await loadOnlinePlayers();
  await loadPlayerHistory();
  await scanLogs();
  console.log(`[Players] Initialized with ${onlinePlayers.size} online players`);
}

/**
 * Clear all online players - called when server stops or restarts
 * This ensures no stale players remain in the online list after server restart
 */
export function clearOnlinePlayers(): void {
  // Record leave for all online players before clearing
  for (const [name] of onlinePlayers) {
    recordPlayerLeave(name);
  }
  onlinePlayers.clear();
  // Clear the persisted file as well
  saveOnlinePlayers().catch(err => console.error('Failed to clear online players file:', err));
  console.log('[Players] Cleared online players list (server stop/restart)');
}

export function processLogLine(line: string): { event: 'join' | 'leave'; player: string } | null {
  // Initialize history and online players loading
  loadPlayerHistory().catch(() => {});
  loadOnlinePlayers().catch(() => {});

  // Check for join
  for (const pattern of JOIN_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      const player = match[1];
      // Validate player name to avoid false positives like "client"
      if (!isValidPlayerName(player)) {
        continue;
      }

      // Extract additional info from the log line
      const extraInfo = extractPlayerInfo(line, player);
      const existing = onlinePlayers.get(player);

      if (existing) {
        // Update existing player with new info
        if (extraInfo.uuid && !existing.uuid) existing.uuid = extraInfo.uuid;
        if (extraInfo.ip && !existing.ip) existing.ip = extraInfo.ip;
        if (extraInfo.world) existing.world = extraInfo.world;
        existing.lastActivity = new Date();
      } else {
        // New player
        onlinePlayers.set(player, {
          joinedAt: new Date(),
          lastActivity: new Date(),
          ...extraInfo,
        });
      }

      recordPlayerJoin(player, extraInfo.uuid);
      // Persist the change
      saveOnlinePlayers().catch(err => console.error('Failed to save online players:', err));
      return { event: 'join', player };
    }
  }

  // Check for leave
  for (const pattern of LEAVE_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      const player = match[1];
      // Validate player name to avoid false positives
      if (!isValidPlayerName(player)) {
        continue;
      }
      recordPlayerLeave(player);
      onlinePlayers.delete(player);
      // Persist the change
      saveOnlinePlayers().catch(err => console.error('Failed to save online players:', err));
      return { event: 'leave', player };
    }
  }

  return null;
}

// Player statistics
export interface PlayerStatistics {
  totalPlayers: number;
  totalPlaytime: number; // in seconds
  averagePlaytime: number;
  averageSessionsPerPlayer: number;
  topPlayers: { name: string; playTime: number; sessions: number }[];
  newPlayersLast7Days: number;
  activePlayersLast7Days: number;
  peakOnlineToday: number;
}

// Track peak players
let peakOnlineToday = 0;
let peakResetDate = new Date().toDateString();

function updatePeakOnline(): void {
  const today = new Date().toDateString();
  if (today !== peakResetDate) {
    peakOnlineToday = 0;
    peakResetDate = today;
  }
  if (onlinePlayers.size > peakOnlineToday) {
    peakOnlineToday = onlinePlayers.size;
  }
}

export async function getPlayerStatistics(): Promise<PlayerStatistics> {
  await loadPlayerHistory();
  updatePeakOnline();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const players = Array.from(playerHistory.values());
  const totalPlayers = players.length;
  const totalPlaytime = players.reduce((sum, p) => sum + p.playTime, 0);
  const totalSessions = players.reduce((sum, p) => sum + p.sessionCount, 0);

  // Top 10 players by playtime
  const topPlayers = players
    .sort((a, b) => b.playTime - a.playTime)
    .slice(0, 10)
    .map(p => ({
      name: p.name,
      playTime: p.playTime,
      sessions: p.sessionCount,
    }));

  // New players in last 7 days
  const newPlayersLast7Days = players.filter(
    p => new Date(p.firstSeen) >= sevenDaysAgo
  ).length;

  // Active players in last 7 days
  const activePlayersLast7Days = players.filter(
    p => new Date(p.lastSeen) >= sevenDaysAgo
  ).length;

  return {
    totalPlayers,
    totalPlaytime,
    averagePlaytime: totalPlayers > 0 ? Math.round(totalPlaytime / totalPlayers) : 0,
    averageSessionsPerPlayer: totalPlayers > 0 ? Math.round((totalSessions / totalPlayers) * 10) / 10 : 0,
    topPlayers,
    newPlayersLast7Days,
    activePlayersLast7Days,
    peakOnlineToday,
  };
}

// Daily activity for charts (last 7 days)
export interface DailyActivity {
  date: string;
  uniquePlayers: number;
  totalSessions: number;
}

export async function getDailyActivity(days: number = 7): Promise<DailyActivity[]> {
  await loadPlayerHistory();

  const result: DailyActivity[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    // Count players active on this day
    const playersOnDay = Array.from(playerHistory.values()).filter(p => {
      const lastSeen = new Date(p.lastSeen);
      return lastSeen.toISOString().split('T')[0] === dateStr;
    });

    result.push({
      date: dateStr,
      uniquePlayers: playersOnDay.length,
      totalSessions: playersOnDay.reduce((sum, p) => sum + 1, 0), // Simplified: 1 session per active day
    });
  }

  return result;
}
