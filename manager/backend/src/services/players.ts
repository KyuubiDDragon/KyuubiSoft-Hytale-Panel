import { getLogs } from './docker.js';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import type { PlayerInfo } from '../types/index.js';

// Single unified player entry - all data in one place
export interface PlayerEntry {
  name: string;
  online: boolean;
  uuid?: string;
  ip?: string;
  world?: string;
  firstSeen: string;
  lastSeen: string;
  currentSessionStart?: string; // When current session started (if online)
  playTime: number; // Total playtime in seconds
  sessionCount: number;
}

// In-memory player list
let players: Map<string, PlayerEntry> = new Map();
let playersLoaded = false;

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
  'player',
]);

const MIN_PLAYER_NAME_LENGTH = 3;

function isValidPlayerName(name: string): boolean {
  if (!name || name.length < MIN_PLAYER_NAME_LENGTH) return false;
  if (PLAYER_NAME_BLACKLIST.has(name.toLowerCase())) return false;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) return false;
  return true;
}

// File path for the unified players.json
async function getPlayersPath(): Promise<string> {
  return path.join(config.serverPath, 'players.json');
}

// Load players from file
async function loadPlayers(): Promise<void> {
  if (playersLoaded) return;
  try {
    const content = await readFile(await getPlayersPath(), 'utf-8');
    const data: PlayerEntry[] = JSON.parse(content);
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (isValidPlayerName(entry.name)) {
          players.set(entry.name, entry);
        }
      }
      console.log(`[Players] Loaded ${players.size} players from players.json`);
    }
  } catch {
    console.log('[Players] No players.json found, starting fresh');
  }
  playersLoaded = true;
}

// Save players to file
async function savePlayers(): Promise<void> {
  const data = Array.from(players.values());
  await writeFile(await getPlayersPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// Patterns for player events
const JOIN_PATTERNS = [
  /\[Universe\|P\]\s+Adding player '(\w+)/i,
  /\[World\|.*?\]\s+Player '(\w+)' joined world/i,
  /\[World\|.*?\]\s+Adding player '(\w+)' to world/i,
  /Starting authenticated flow for (\w+)/i,
  /Connection complete for (\w+)/i,
  /Identity token validated for (\w+)/i,
  /Player\s+(\w+)\s+joined/i,
  /Player\s+(\w+)\s+connected to the server/i,
  /(\w+)\s+joined the game/i,
  /(\w+)\s+joined the server/i,
  /(\w+)\s+has joined the game/i,
  /(\w+)\s+logged in with entity id/i,
];

const LEAVE_PATTERNS = [
  /Disconnecting (\w+) at/i,
  /\[Universe\|P\]\s+Removing player '(\w+)/i,
  /\[PlayerSystems\]\s+Removing player '(\w+)/i,
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

// Patterns to extract additional info
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

// Extract extra info from log line
function extractPlayerInfo(line: string, playerName: string): { uuid?: string; ip?: string; world?: string } {
  const info: { uuid?: string; ip?: string; world?: string } = {};

  for (const pattern of UUID_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      if (match[1]?.toLowerCase() === playerName.toLowerCase()) info.uuid = match[2];
      else if (match[2]?.toLowerCase() === playerName.toLowerCase()) info.uuid = match[1];
      break;
    }
  }

  for (const pattern of IP_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      if (match[1]?.toLowerCase() === playerName.toLowerCase()) info.ip = match[2];
      else if (match[2]?.toLowerCase() === playerName.toLowerCase()) info.ip = match[1];
      break;
    }
  }

  for (const pattern of WORLD_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      if (match[1]?.toLowerCase() === playerName.toLowerCase()) info.world = match[2];
      else if (match[2]?.toLowerCase() === playerName.toLowerCase()) info.world = match[1];
      break;
    }
  }

  return info;
}

// Set player online
function setPlayerOnline(name: string, extraInfo: { uuid?: string; ip?: string; world?: string } = {}): void {
  const now = new Date().toISOString();
  const existing = players.get(name);

  if (existing) {
    existing.online = true;
    existing.lastSeen = now;
    existing.currentSessionStart = now;
    existing.sessionCount++;
    if (extraInfo.uuid && !existing.uuid) existing.uuid = extraInfo.uuid;
    if (extraInfo.ip) existing.ip = extraInfo.ip;
    if (extraInfo.world) existing.world = extraInfo.world;
  } else {
    players.set(name, {
      name,
      online: true,
      uuid: extraInfo.uuid,
      ip: extraInfo.ip,
      world: extraInfo.world,
      firstSeen: now,
      lastSeen: now,
      currentSessionStart: now,
      playTime: 0,
      sessionCount: 1,
    });
  }

  savePlayers().catch(err => console.error('Failed to save players:', err));
}

// Set player offline
function setPlayerOffline(name: string): void {
  const player = players.get(name);
  if (!player) return;

  const now = new Date();
  player.online = false;
  player.lastSeen = now.toISOString();

  // Calculate session duration if we have session start
  if (player.currentSessionStart) {
    const sessionStart = new Date(player.currentSessionStart);
    const sessionDuration = Math.floor((now.getTime() - sessionStart.getTime()) / 1000);
    player.playTime += sessionDuration;
    player.currentSessionStart = undefined;
  }

  savePlayers().catch(err => console.error('Failed to save players:', err));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Scan logs to sync state
export async function scanLogs(): Promise<void> {
  await loadPlayers();

  const logs = await getLogs(500);
  if (!logs) return;

  const lines = logs.split('\n');

  for (const line of lines) {
    // Check for join
    for (const pattern of JOIN_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const player = match[1];
        if (isValidPlayerName(player)) {
          const existing = players.get(player);
          if (!existing || !existing.online) {
            const extraInfo = extractPlayerInfo(line, player);
            setPlayerOnline(player, extraInfo);
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
        if (isValidPlayerName(player)) {
          const existing = players.get(player);
          if (existing && existing.online) {
            setPlayerOffline(player);
          }
        }
        break;
      }
    }
  }
}

// Get online players
export async function getOnlinePlayers(): Promise<PlayerInfo[]> {
  await loadPlayers();

  const now = new Date();
  const result: PlayerInfo[] = [];

  for (const player of players.values()) {
    if (player.online && player.currentSessionStart) {
      const sessionStart = new Date(player.currentSessionStart);
      const durationMs = now.getTime() - sessionStart.getTime();
      result.push({
        name: player.name,
        joined_at: player.currentSessionStart,
        session_duration_seconds: Math.floor(durationMs / 1000),
        session_duration: formatDuration(durationMs),
      });
    }
  }

  return result;
}

// Get offline players
export async function getOfflinePlayers(): Promise<PlayerEntry[]> {
  await loadPlayers();
  return Array.from(players.values())
    .filter(p => !p.online)
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
}

// Get all players
export async function getAllPlayers(): Promise<PlayerEntry[]> {
  await loadPlayers();
  return Array.from(players.values())
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
}

// Get player count
export async function getPlayerCount(): Promise<number> {
  await loadPlayers();
  return Array.from(players.values()).filter(p => p.online).length;
}

// Get player history (for backwards compatibility)
export async function getPlayerHistory(): Promise<PlayerEntry[]> {
  return getAllPlayers();
}

// Remove player
export function removePlayer(name: string): void {
  if (players.has(name)) {
    setPlayerOffline(name);
  }
}

// Initialize player tracking
export async function initializePlayerTracking(): Promise<void> {
  console.log('[Players] Initializing player tracking...');
  await loadPlayers();
  await scanLogs();
  const onlineCount = Array.from(players.values()).filter(p => p.online).length;
  console.log(`[Players] Initialized with ${players.size} total players, ${onlineCount} online`);
}

// Clear all online players (server stop/restart)
export function clearOnlinePlayers(): void {
  for (const player of players.values()) {
    if (player.online) {
      setPlayerOffline(player.name);
    }
  }
  console.log('[Players] Cleared all online players (server stop/restart)');
}

// Process log line in real-time
export function processLogLine(line: string): { event: 'join' | 'leave'; player: string } | null {
  loadPlayers().catch(() => {});

  // Check for join
  for (const pattern of JOIN_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      const player = match[1];
      if (!isValidPlayerName(player)) continue;

      const extraInfo = extractPlayerInfo(line, player);
      setPlayerOnline(player, extraInfo);
      return { event: 'join', player };
    }
  }

  // Check for leave
  for (const pattern of LEAVE_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      const player = match[1];
      if (!isValidPlayerName(player)) continue;

      setPlayerOffline(player);
      return { event: 'leave', player };
    }
  }

  return null;
}

// Player statistics
export interface PlayerStatistics {
  totalPlayers: number;
  totalPlaytime: number;
  averagePlaytime: number;
  averageSessionsPerPlayer: number;
  topPlayers: { name: string; playTime: number; sessions: number }[];
  newPlayersLast7Days: number;
  activePlayersLast7Days: number;
  peakOnlineToday: number;
}

let peakOnlineToday = 0;
let peakResetDate = new Date().toDateString();

function updatePeakOnline(): void {
  const today = new Date().toDateString();
  if (today !== peakResetDate) {
    peakOnlineToday = 0;
    peakResetDate = today;
  }
  const onlineCount = Array.from(players.values()).filter(p => p.online).length;
  if (onlineCount > peakOnlineToday) {
    peakOnlineToday = onlineCount;
  }
}

export async function getPlayerStatistics(): Promise<PlayerStatistics> {
  await loadPlayers();
  updatePeakOnline();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const allPlayers = Array.from(players.values());
  const totalPlayers = allPlayers.length;
  const totalPlaytime = allPlayers.reduce((sum, p) => sum + p.playTime, 0);
  const totalSessions = allPlayers.reduce((sum, p) => sum + p.sessionCount, 0);

  const topPlayers = allPlayers
    .sort((a, b) => b.playTime - a.playTime)
    .slice(0, 10)
    .map(p => ({ name: p.name, playTime: p.playTime, sessions: p.sessionCount }));

  const newPlayersLast7Days = allPlayers.filter(p => new Date(p.firstSeen) >= sevenDaysAgo).length;
  const activePlayersLast7Days = allPlayers.filter(p => new Date(p.lastSeen) >= sevenDaysAgo).length;

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

// Daily activity
export interface DailyActivity {
  date: string;
  uniquePlayers: number;
  totalSessions: number;
}

export async function getDailyActivity(days: number = 7): Promise<DailyActivity[]> {
  await loadPlayers();

  const result: DailyActivity[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    const playersOnDay = Array.from(players.values()).filter(p => {
      const lastSeen = new Date(p.lastSeen);
      return lastSeen.toISOString().split('T')[0] === dateStr;
    });

    result.push({
      date: dateStr,
      uniquePlayers: playersOnDay.length,
      totalSessions: playersOnDay.length,
    });
  }

  return result;
}

// Export PlayerHistoryEntry as alias for backwards compatibility
export type PlayerHistoryEntry = PlayerEntry;
