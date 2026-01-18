import { getLogs } from './docker.js';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import type { PlayerInfo } from '../types/index.js';
import { recordDeathPosition, getLastDeathPosition } from './chatLog.js';

// ============================================================
// Player Data File Interfaces (from server/universe/players/)
// ============================================================

export interface PlayerFileInventoryItem {
  Id: string;
  Quantity: number;
  Durability: number;
  MaxDurability: number;
  OverrideDroppedItemAnimation?: boolean;
}

export interface PlayerFileInventoryContainer {
  Id: string;
  Capacity: number;
  Items: Record<string, PlayerFileInventoryItem>;
}

export interface PlayerFileInventory {
  Version: number;
  Storage: PlayerFileInventoryContainer;
  Armor: PlayerFileInventoryContainer;
  HotBar: PlayerFileInventoryContainer;
  Utility: PlayerFileInventoryContainer;
  Backpack: PlayerFileInventoryContainer;
  Tool?: PlayerFileInventoryContainer;
  ActiveHotbarSlot: number;
  ActiveToolsSlot?: number;
  ActiveUtilitySlot?: number;
  SortType?: string;
}

export interface PlayerFileStat {
  Id: string;
  Value: number;
  Modifiers?: Record<string, unknown>;
}

export interface PlayerFileEntityStats {
  Version: number;
  Stats: Record<string, PlayerFileStat>;
}

export interface PlayerFileTransform {
  Position: { X: number; Y: number; Z: number };
  Rotation: { Pitch: number; Yaw: number; Roll: number };
}

// Death position in PerWorldData
export interface PlayerFileDeathPositionEntry {
  MarkerId: string;
  Transform: {
    X: number;
    Y: number;
    Z: number;
    Pitch: number;
    Yaw: number;
    Roll: number;
  };
  Day: number;
}

// Per-world data structure
export interface PlayerFilePerWorldData {
  LastPosition?: {
    X: number;
    Y: number;
    Z: number;
    Pitch: number;
    Yaw: number;
    Roll: number;
  };
  LastMovementStates?: {
    Flying?: boolean;
  };
  FirstSpawn?: boolean;
  DeathPositions?: PlayerFileDeathPositionEntry[];
}

export interface PlayerFilePlayerData {
  BlockIdVersion?: number;
  World?: string;
  KnownRecipes?: string[];
  DiscoveredZones?: string[];
  DiscoveredInstances?: unknown[];
  PerWorldData?: Record<string, PlayerFilePerWorldData>;
  ReputationData?: Record<string, unknown>;
  ActiveObjectiveUUIDs?: string[];
}

export interface PlayerFileMemory {
  Id: string;
  NPCRole: string;
  TranslationKey: string;
  IsMemoriesNameOverridden: boolean;
  CapturedTimestamp: number;
  FoundLocationNameKey: string;
}

// Death position data from PlayerDeathPositionData component
export interface PlayerFileDeathPosition {
  MarkerId?: string;
  Transform?: PlayerFileTransform;
  Day?: number;
}

export interface PlayerFileComponents {
  Transform?: PlayerFileTransform;
  Player?: {
    Version: number;
    UUID?: { $binary: string; $type: string };
    Inventory?: PlayerFileInventory;
    PlayerData?: PlayerFilePlayerData;
    GameMode?: string;
    HotbarManager?: unknown;
    BlockPlacementOverride?: boolean;
  };
  EntityStats?: PlayerFileEntityStats;
  DisplayName?: { DisplayName: { RawText: string } };
  PlayerMemories?: { Capacity: number; Memories: PlayerFileMemory[] };
  HeadRotation?: { Rotation: { Pitch: number; Yaw: number; Roll: number } };
  UniqueItemUsages?: { UniqueItemUsed: string[] };
  // Death position data (if player has died)
  PlayerDeathPositionData?: PlayerFileDeathPosition;
  DeathPosition?: PlayerFileDeathPosition;
}

export interface PlayerFileData {
  Components: PlayerFileComponents;
}

// Parsed player inventory for API response
export interface ParsedInventoryItem {
  slot: number;
  itemId: string;
  displayName: string;
  amount: number;
  durability: number;
  maxDurability: number;
}

export interface ParsedPlayerInventory {
  uuid: string;
  name: string;
  storage: ParsedInventoryItem[];
  armor: ParsedInventoryItem[];
  hotbar: ParsedInventoryItem[];
  utility: ParsedInventoryItem[];
  backpack: ParsedInventoryItem[];
  tools: ParsedInventoryItem[];
  activeHotbarSlot: number;
  totalSlots: number;
  usedSlots: number;
  // Individual container capacities
  capacities: {
    storage: number;
    armor: number;
    hotbar: number;
    utility: number;
    backpack: number;
    tools: number;
  };
}

export interface ParsedPlayerStats {
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  oxygen: number;
  mana: number;
  immunity: number;
}

export interface ParsedPlayerDetails {
  uuid: string;
  name: string;
  world: string;
  gameMode: string;
  position: { x: number; y: number; z: number } | null;
  rotation: { pitch: number; yaw: number; roll: number } | null;
  stats: ParsedPlayerStats;
  discoveredZones: string[];
  memoriesCount: number;
  uniqueItemsUsed: string[];
}

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

// ============================================================
// Player Data File Reading (from server/universe/players/)
// ============================================================

/**
 * Get path to universe players directory
 */
function getUniversePlayersPath(): string {
  return path.join(config.serverPath, 'universe', 'players');
}

/**
 * Convert item ID to display name (e.g., "Weapon_Sword_Adamantite" -> "Adamantite Sword")
 */
function formatItemName(itemId: string): string {
  // Remove common prefixes and format
  const parts = itemId.split('_');
  // Reverse certain patterns for readability
  if (parts[0] === 'Weapon' || parts[0] === 'Tool' || parts[0] === 'Armor' || parts[0] === 'Food') {
    // "Weapon_Sword_Adamantite" -> "Adamantite Sword"
    const type = parts.slice(1, -1).join(' ');
    const material = parts[parts.length - 1];
    return `${material} ${type}`.trim();
  }
  // Default: just replace underscores with spaces
  return parts.join(' ');
}

/**
 * Parse inventory container to list of items
 */
function parseInventoryContainer(container: PlayerFileInventoryContainer | undefined): ParsedInventoryItem[] {
  if (!container || !container.Items) return [];

  const items: ParsedInventoryItem[] = [];
  for (const [slotStr, item] of Object.entries(container.Items)) {
    const slot = parseInt(slotStr, 10);
    items.push({
      slot,
      itemId: item.Id,
      displayName: formatItemName(item.Id),
      amount: item.Quantity,
      durability: item.Durability,
      maxDurability: item.MaxDurability,
    });
  }
  return items.sort((a, b) => a.slot - b.slot);
}

/**
 * Find player UUID by name from our players list
 */
async function findPlayerUuidByName(playerName: string): Promise<string | null> {
  await loadPlayers();
  const player = players.get(playerName);
  if (player?.uuid) {
    return player.uuid;
  }

  // Try to find by scanning player files
  try {
    const playersDir = getUniversePlayersPath();
    const files = await readdir(playersDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await readFile(path.join(playersDir, file), 'utf-8');
        const data: PlayerFileData = JSON.parse(content);
        const displayName = data.Components?.DisplayName?.DisplayName?.RawText;

        if (displayName?.toLowerCase() === playerName.toLowerCase()) {
          return file.replace('.json', '');
        }
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory might not exist
  }

  return null;
}

/**
 * Read raw player data from JSON file
 */
async function readPlayerFile(uuid: string): Promise<PlayerFileData | null> {
  try {
    const filePath = path.join(getUniversePlayersPath(), `${uuid}.json`);
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get player inventory by name
 */
export async function getPlayerInventoryFromFile(playerName: string): Promise<ParsedPlayerInventory | null> {
  const uuid = await findPlayerUuidByName(playerName);
  if (!uuid) return null;

  const data = await readPlayerFile(uuid);
  if (!data) return null;

  const inventory = data.Components?.Player?.Inventory;
  if (!inventory) return null;

  const displayName = data.Components?.DisplayName?.DisplayName?.RawText || playerName;

  const storage = parseInventoryContainer(inventory.Storage);
  const armor = parseInventoryContainer(inventory.Armor);
  const hotbar = parseInventoryContainer(inventory.HotBar);
  const utility = parseInventoryContainer(inventory.Utility);
  const backpack = parseInventoryContainer(inventory.Backpack);
  const tools = parseInventoryContainer(inventory.Tool);

  const allItems = [...storage, ...armor, ...hotbar, ...utility, ...backpack, ...tools];

  return {
    uuid,
    name: displayName,
    storage,
    armor,
    hotbar,
    utility,
    backpack,
    tools,
    activeHotbarSlot: inventory.ActiveHotbarSlot || 0,
    totalSlots: (inventory.Storage?.Capacity || 0) +
                (inventory.Armor?.Capacity || 0) +
                (inventory.HotBar?.Capacity || 0) +
                (inventory.Utility?.Capacity || 0) +
                (inventory.Backpack?.Capacity || 0),
    usedSlots: allItems.length,
    capacities: {
      storage: inventory.Storage?.Capacity || 36,
      armor: inventory.Armor?.Capacity || 4,
      hotbar: inventory.HotBar?.Capacity || 9,
      utility: inventory.Utility?.Capacity || 4,
      backpack: inventory.Backpack?.Capacity || 0,
      tools: inventory.Tool?.Capacity || 2,
    },
  };
}

/**
 * Get player details by name
 */
export async function getPlayerDetailsFromFile(playerName: string): Promise<ParsedPlayerDetails | null> {
  const uuid = await findPlayerUuidByName(playerName);
  if (!uuid) return null;

  const data = await readPlayerFile(uuid);
  if (!data) return null;

  const components = data.Components;
  const player = components?.Player;
  const entityStats = components?.EntityStats;
  const transform = components?.Transform;
  const displayName = components?.DisplayName?.DisplayName?.RawText || playerName;

  // Parse stats
  const healthStat = entityStats?.Stats?.Health;
  const staminaStat = entityStats?.Stats?.Stamina;
  const oxygenStat = entityStats?.Stats?.Oxygen;
  const manaStat = entityStats?.Stats?.Mana;
  const immunityStat = entityStats?.Stats?.Immunity;

  // Calculate max health from modifiers
  let maxHealth = 100; // Base health
  if (healthStat?.Modifiers) {
    for (const mod of Object.values(healthStat.Modifiers)) {
      if ((mod as { Amount?: number }).Amount) {
        maxHealth += (mod as { Amount: number }).Amount;
      }
    }
  }

  // Check for death position data and store it if found
  const deathData = components?.PlayerDeathPositionData || components?.DeathPosition;
  if (deathData?.Transform?.Position) {
    const deathPos = deathData.Transform.Position;
    const world = player?.PlayerData?.World || 'unknown';
    // Record this death position (asynchronously, don't wait)
    recordDeathPosition(displayName, world, deathPos.X, deathPos.Y, deathPos.Z).catch(() => {});
  }

  return {
    uuid,
    name: displayName,
    world: player?.PlayerData?.World || 'unknown',
    gameMode: player?.GameMode || 'unknown',
    position: transform?.Position ? {
      x: Math.round(transform.Position.X * 100) / 100,
      y: Math.round(transform.Position.Y * 100) / 100,
      z: Math.round(transform.Position.Z * 100) / 100,
    } : null,
    rotation: transform?.Rotation ? {
      pitch: transform.Rotation.Pitch,
      yaw: transform.Rotation.Yaw,
      roll: transform.Rotation.Roll,
    } : null,
    stats: {
      health: healthStat?.Value || 0,
      maxHealth,
      stamina: staminaStat?.Value || 0,
      maxStamina: 10, // Default max stamina
      oxygen: oxygenStat?.Value || 100,
      mana: manaStat?.Value || 0,
      immunity: immunityStat?.Value || 0,
    },
    discoveredZones: player?.PlayerData?.DiscoveredZones || [],
    memoriesCount: components?.PlayerMemories?.Memories?.length || 0,
    uniqueItemsUsed: components?.UniqueItemUsages?.UniqueItemUsed || [],
  };
}

/**
 * Get all available player files (for listing all known players)
 */
export async function getAllPlayerFiles(): Promise<{ uuid: string; name: string }[]> {
  try {
    const playersDir = getUniversePlayersPath();
    const files = await readdir(playersDir);
    const result: { uuid: string; name: string }[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await readFile(path.join(playersDir, file), 'utf-8');
        const data: PlayerFileData = JSON.parse(content);
        const displayName = data.Components?.DisplayName?.DisplayName?.RawText;

        if (displayName) {
          result.push({
            uuid: file.replace('.json', ''),
            name: displayName,
          });
        }
      } catch {
        // Skip invalid files
      }
    }

    return result;
  } catch {
    return [];
  }
}

// Unified player entry with data from JSON files and online status
export interface UnifiedPlayerEntry {
  name: string;
  uuid: string;
  online: boolean;
  world?: string;
  gameMode?: string;
  position?: { x: number; y: number; z: number };
  health?: number;
  maxHealth?: number;
  // From session tracking
  lastSeen?: string;
  playTime?: number;
  sessionCount?: number;
}

// Parsed death position for API response
export interface ParsedDeathPosition {
  id: string;
  world: string;
  day: number;
  position: {
    x: number;
    y: number;
    z: number;
  };
  rotation: {
    pitch: number;
    yaw: number;
    roll: number;
  };
}

/**
 * Get player death positions from file
 * Returns array sorted by most recent (last in array = most recent)
 */
export async function getPlayerDeathPositionsFromFile(playerName: string): Promise<ParsedDeathPosition[]> {
  const uuid = await findPlayerUuidByName(playerName);
  if (!uuid) return [];

  const data = await readPlayerFile(uuid);
  if (!data) return [];

  const playerData = data.Components?.Player?.PlayerData;
  if (!playerData?.PerWorldData) return [];

  const result: ParsedDeathPosition[] = [];

  // Iterate through all worlds
  for (const [worldName, worldData] of Object.entries(playerData.PerWorldData)) {
    if (!worldData.DeathPositions) continue;

    for (const death of worldData.DeathPositions) {
      result.push({
        id: death.MarkerId,
        world: worldName,
        day: death.Day,
        position: {
          x: Math.round(death.Transform.X * 100) / 100,
          y: Math.round(death.Transform.Y * 100) / 100,
          z: Math.round(death.Transform.Z * 100) / 100,
        },
        rotation: {
          pitch: death.Transform.Pitch,
          yaw: death.Transform.Yaw,
          roll: death.Transform.Roll,
        },
      });
    }
  }

  // Sort by day (ascending), so last element is most recent
  // The array from file is already in order, but we keep this for safety
  return result;
}

/**
 * Get all players from JSON files with online status merged in
 * This is the primary source of truth - all players who have ever played
 */
export async function getAllPlayersUnified(): Promise<UnifiedPlayerEntry[]> {
  await loadPlayers(); // Load session tracking data

  try {
    const playersDir = getUniversePlayersPath();
    const files = await readdir(playersDir);
    const result: UnifiedPlayerEntry[] = [];

    // Get list of online player names for quick lookup
    const onlinePlayerNames = new Set(
      Array.from(players.values())
        .filter(p => p.online)
        .map(p => p.name.toLowerCase())
    );

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await readFile(path.join(playersDir, file), 'utf-8');
        const data: PlayerFileData = JSON.parse(content);
        const displayName = data.Components?.DisplayName?.DisplayName?.RawText;

        if (!displayName) continue;

        const uuid = file.replace('.json', '');
        const isOnline = onlinePlayerNames.has(displayName.toLowerCase());

        // Get session tracking data if available
        const sessionData = players.get(displayName);

        // Extract data from player file
        const transform = data.Components?.Transform;
        const playerData = data.Components?.Player;
        const entityStats = data.Components?.EntityStats;
        const healthStat = entityStats?.Stats?.Health;

        // Calculate max health
        let maxHealth = 100;
        if (healthStat?.Modifiers) {
          for (const mod of Object.values(healthStat.Modifiers)) {
            if ((mod as { Amount?: number }).Amount) {
              maxHealth += (mod as { Amount: number }).Amount;
            }
          }
        }

        result.push({
          name: displayName,
          uuid,
          online: isOnline,
          world: playerData?.PlayerData?.World,
          gameMode: playerData?.GameMode,
          position: transform?.Position ? {
            x: Math.round(transform.Position.X * 100) / 100,
            y: Math.round(transform.Position.Y * 100) / 100,
            z: Math.round(transform.Position.Z * 100) / 100,
          } : undefined,
          health: healthStat?.Value,
          maxHealth,
          lastSeen: sessionData?.lastSeen,
          playTime: sessionData?.playTime,
          sessionCount: sessionData?.sessionCount,
        });
      } catch {
        // Skip invalid files
      }
    }

    // Sort: online first, then by last seen (most recent first)
    result.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (a.lastSeen && b.lastSeen) {
        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
      }
      return a.name.localeCompare(b.name);
    });

    return result;
  } catch {
    return [];
  }
}
