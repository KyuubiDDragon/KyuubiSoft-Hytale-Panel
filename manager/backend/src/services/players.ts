import { getLogs } from './docker.js';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import type { PlayerInfo } from '../types/index.js';

// Player tracking state
const onlinePlayers: Map<string, Date> = new Map();

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
  const joinTime = onlinePlayers.get(name);

  if (existing && joinTime) {
    const sessionDuration = Math.floor((Date.now() - joinTime.getTime()) / 1000);
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
  // Generic fallback patterns
  /Player\s+(\w+)\s+joined/i,
  /Player\s+(\w+)\s+connected/i,
  /(\w+)\s+joined the game/i,
  /(\w+)\s+joined the server/i,
  /(\w+)\s+has joined/i,
  /(\w+)\s+connected/i,
  /(\w+)\s+logged in/i,
];

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
  const logs = await getLogs(500);
  if (!logs) return;

  const lines = logs.split('\n');

  for (const line of lines) {
    // Check for join
    for (const pattern of JOIN_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const player = match[1];
        if (!onlinePlayers.has(player)) {
          onlinePlayers.set(player, new Date());
        }
        break;
      }
    }

    // Check for leave
    for (const pattern of LEAVE_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const player = match[1];
        onlinePlayers.delete(player);
        break;
      }
    }
  }
}

export async function getOnlinePlayers(): Promise<PlayerInfo[]> {
  await scanLogs();

  const now = new Date();
  const players: PlayerInfo[] = [];

  for (const [name, joinedAt] of onlinePlayers) {
    const durationMs = now.getTime() - joinedAt.getTime();
    players.push({
      name,
      joined_at: joinedAt.toISOString(),
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
  onlinePlayers.delete(name);
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
  console.log('[Players] Cleared online players list (server stop/restart)');
}

export function processLogLine(line: string): { event: 'join' | 'leave'; player: string } | null {
  // Initialize history loading
  loadPlayerHistory().catch(() => {});

  // Check for join
  for (const pattern of JOIN_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      const player = match[1];
      onlinePlayers.set(player, new Date());
      recordPlayerJoin(player);
      return { event: 'join', player };
    }
  }

  // Check for leave
  for (const pattern of LEAVE_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      const player = match[1];
      recordPlayerLeave(player);
      onlinePlayers.delete(player);
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
