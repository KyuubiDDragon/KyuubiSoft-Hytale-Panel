import { logger } from '../utils/logger.js';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import type { PlayerInfo } from '../types/index.js';
import { recordDeathPosition, getLastDeathPosition } from './chatLog.js';
import {
  isDemoMode,
  getDemoOnlinePlayers,
  getDemoOfflinePlayers,
  getDemoAllPlayers,
  getDemoPlayerCount,
  getDemoPlayerStatistics,
  getDemoDailyActivity,
  getDemoAllPlayersUnified,
  getDemoPlayerInventory,
  getDemoPlayerDetails,
  getDemoDeathPositions,
} from './demoData.js';

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
  // 2026-05 saves carry the display name on the Nameplate component instead.
  Nameplate?: { Text: string };
  // 2026-05 layout: inventory containers are top-level components, each wrapping
  // the actual container under `.Inventory` (older saves nested them under
  // Player.Inventory.{Storage,Armor,...}).
  StorageInventory?: { Inventory?: PlayerFileInventoryContainer };
  ArmorInventory?: { Inventory?: PlayerFileInventoryContainer };
  HotbarInventory?: { Inventory?: PlayerFileInventoryContainer; ActiveSlot?: number };
  UtilityInventory?: { Inventory?: PlayerFileInventoryContainer; ActiveSlot?: number };
  BackpackInventory?: { Inventory?: PlayerFileInventoryContainer };
  ToolInventory?: { Inventory?: PlayerFileInventoryContainer; ActiveSlot?: number };
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
let playersLoadPromise: Promise<void> | null = null; // SECURITY: Prevent race condition during load

// SECURITY: Debounced save to prevent race conditions and excessive disk I/O
let saveTimeout: NodeJS.Timeout | null = null;
let savePromise: Promise<void> | null = null;
const SAVE_DEBOUNCE_MS = 1000; // Wait 1 second before saving to batch changes

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

// Load players from file (with race condition protection)
async function loadPlayers(): Promise<void> {
  // SECURITY: If already loaded, return immediately
  if (playersLoaded) return;

  // SECURITY: If currently loading, wait for existing load to complete
  // This prevents multiple concurrent loads from corrupting state
  if (playersLoadPromise) {
    return playersLoadPromise;
  }

  // Start the load and store the promise so concurrent calls can wait
  playersLoadPromise = (async () => {
    try {
      const content = await readFile(await getPlayersPath(), 'utf-8');
      const data: PlayerEntry[] = JSON.parse(content);
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (isValidPlayerName(entry.name)) {
            players.set(entry.name, entry);
          }
        }
        logger.info(`[Players] Loaded ${players.size} players from players.json`);
      }
    } catch {
      logger.info('[Players] No players.json found, starting fresh');
    }
    playersLoaded = true;
  })();

  return playersLoadPromise;
}

// SECURITY: Debounced save - prevents race conditions and excessive disk I/O
// Multiple rapid changes will be batched into a single write
function debouncedSavePlayers(): void {
  // Clear existing timeout to reset the debounce
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }

  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    // Perform the actual save
    savePromise = (async () => {
      try {
        const data = Array.from(players.values());
        await writeFile(await getPlayersPath(), JSON.stringify(data, null, 2), 'utf-8');
      } catch (err) {
        logger.error('[Players] Failed to save players:', err);
      } finally {
        savePromise = null;
      }
    })();
  }, SAVE_DEBOUNCE_MS);
}

// Save players to file (deprecated - use debouncedSavePlayers for normal operations)
// This is kept for explicit immediate saves (e.g., on shutdown)
async function savePlayers(): Promise<void> {
  // If there's a pending debounced save, cancel it and save immediately
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  // Wait for any in-progress save to complete
  if (savePromise) {
    await savePromise;
  }
  const data = Array.from(players.values());
  await writeFile(await getPlayersPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// Set player online
function setPlayerOnline(name: string, extraInfo: { uuid?: string; world?: string } = {}): void {
  const now = new Date().toISOString();
  const existing = players.get(name);

  if (existing) {
    existing.lastSeen = now;
    if (extraInfo.uuid) existing.uuid = extraInfo.uuid;
    if (extraInfo.world) existing.world = extraInfo.world;
    // A repeated join of someone already online does not start a new session.
    if (!existing.online) {
      existing.online = true;
      existing.currentSessionStart = now;
      existing.sessionCount++;
    }
  } else {
    players.set(name, {
      name,
      online: true,
      uuid: extraInfo.uuid,
      world: extraInfo.world,
      firstSeen: now,
      lastSeen: now,
      currentSessionStart: now,
      playTime: 0,
      sessionCount: 1,
    });
  }

  // SECURITY: Use debounced save to prevent race conditions
  debouncedSavePlayers();
}

// Set player offline; the session ends `at` (now by default).
function setPlayerOffline(name: string, at: Date = new Date()): void {
  const player = players.get(name);
  if (!player || !player.online) return;

  player.online = false;
  player.lastSeen = at.toISOString();

  // Calculate session duration if we have session start
  if (player.currentSessionStart) {
    const sessionStart = new Date(player.currentSessionStart);
    const sessionDuration = Math.max(0, Math.floor((at.getTime() - sessionStart.getTime()) / 1000));
    player.playTime += sessionDuration;
    player.currentSessionStart = undefined;
  }

  // SECURITY: Use debounced save to prevent race conditions
  debouncedSavePlayers();
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Runs fn once players.json is loaded, so the load cannot overwrite the change. */
function whenLoaded(fn: () => void): void {
  if (playersLoaded) fn();
  else void loadPlayers().then(fn);
}

/**
 * A player came online on some server (services/playerPresence.ts, which
 * reports each join once). For someone already online only the details change.
 */
export function notePlayerOnline(name: string, info: { uuid?: string; world?: string } = {}): void {
  if (!isValidPlayerName(name)) return;
  whenLoaded(() => setPlayerOnline(name, info));
}

/** A player is offline on every server now. */
export function notePlayerOffline(name: string): void {
  whenLoaded(() => setPlayerOffline(name));
}

/**
 * The online flags of players.json set to who is online now (panel start).
 * Someone still marked online from before is closed at the time last seen,
 * since when they left is unknown.
 */
export async function syncOnlinePlayers(online: Set<string>): Promise<void> {
  await loadPlayers();
  for (const player of players.values()) {
    if (player.online && !online.has(player.name)) {
      setPlayerOffline(player.name, new Date(player.lastSeen));
    }
  }
  for (const name of online) {
    if (isValidPlayerName(name) && !players.get(name)?.online) setPlayerOnline(name);
  }
}

// Get online players
export async function getOnlinePlayers(serverId?: string): Promise<PlayerInfo[]> {
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoOnlinePlayers();
  }

  await loadPlayers();
  const now = new Date();

  // Prefer the KyuubiSoft plugin's authoritative online list when the plugin is
  // reachable — it reads the live server player list directly (no log-parsing
  // lag, no missed/duplicated lines). Each entry is enriched with the locally
  // tracked session start where we have it. Dynamic import avoids any module
  // load-order cycle with kyuubiApi → servers → docker → players.
  try {
    const kyuubiApi = await import('./kyuubiApi.js');
    if (await kyuubiApi.isPluginRunning(serverId)) {
      const resp = await kyuubiApi.getPlayersFromPlugin(serverId);
      const data = resp.success
        ? (resp.data as { players?: Array<{ name?: string }> } | undefined)
        : undefined;
      if (data && Array.isArray(data.players)) {
        return data.players
          .filter((p): p is { name: string } => typeof p?.name === 'string' && p.name.length > 0)
          .map((p) => {
            const start = players.get(p.name)?.currentSessionStart;
            const durationMs = start ? now.getTime() - new Date(start).getTime() : 0;
            return {
              name: p.name,
              joined_at: start ?? now.toISOString(),
              session_duration_seconds: Math.floor(durationMs / 1000),
              session_duration: formatDuration(durationMs),
            };
          });
      }
    }
  } catch {
    // Plugin unavailable / errored — fall back to log-based tracking below.
  }

  // Fallback: who the panel saw join on this server (the plugin's events, or
  // the server's join/leave log records while there is no plugin).
  const { onlinePlayers, isWatching } = await import('./playerPresence.js');
  const { resolveServerId } = await import('./servers.js');
  const id = await resolveServerId(serverId).catch(() => null);
  if (id && isWatching(id)) {
    return onlinePlayers(id).map((p) => {
      const start = players.get(p.name)?.currentSessionStart ?? p.since;
      const durationMs = Math.max(0, now.getTime() - new Date(start).getTime());
      return {
        name: p.name,
        joined_at: start,
        session_duration_seconds: Math.floor(durationMs / 1000),
        session_duration: formatDuration(durationMs),
      };
    });
  }

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
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoOfflinePlayers();
  }

  await loadPlayers();
  return Array.from(players.values())
    .filter((p) => !p.online)
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
}

// Get all players
export async function getAllPlayers(): Promise<PlayerEntry[]> {
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoAllPlayers();
  }

  await loadPlayers();
  return Array.from(players.values()).sort(
    (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
  );
}

// Get player count
export async function getPlayerCount(): Promise<number> {
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoPlayerCount();
  }

  await loadPlayers();
  return Array.from(players.values()).filter((p) => p.online).length;
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

// Initialize player tracking. Who is online comes from services/playerPresence.ts.
export async function initializePlayerTracking(): Promise<void> {
  logger.info('[Players] Initializing player tracking...');
  await loadPlayers();
  const onlineCount = Array.from(players.values()).filter((p) => p.online).length;
  logger.info(`[Players] Initialized with ${players.size} total players, ${onlineCount} online`);
}

// Clear all online players (server stop/restart)
export function clearOnlinePlayers(): void {
  for (const player of players.values()) {
    if (player.online) {
      setPlayerOffline(player.name);
    }
  }
  logger.info('[Players] Cleared all online players (server stop/restart)');
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
  const onlineCount = Array.from(players.values()).filter((p) => p.online).length;
  if (onlineCount > peakOnlineToday) {
    peakOnlineToday = onlineCount;
  }
}

export async function getPlayerStatistics(): Promise<PlayerStatistics> {
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoPlayerStatistics();
  }

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
    .map((p) => ({ name: p.name, playTime: p.playTime, sessions: p.sessionCount }));

  const newPlayersLast7Days = allPlayers.filter(
    (p) => new Date(p.firstSeen) >= sevenDaysAgo,
  ).length;
  const activePlayersLast7Days = allPlayers.filter(
    (p) => new Date(p.lastSeen) >= sevenDaysAgo,
  ).length;

  return {
    totalPlayers,
    totalPlaytime,
    averagePlaytime: totalPlayers > 0 ? Math.round(totalPlaytime / totalPlayers) : 0,
    averageSessionsPerPlayer:
      totalPlayers > 0 ? Math.round((totalSessions / totalPlayers) * 10) / 10 : 0,
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
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoDailyActivity(days);
  }

  await loadPlayers();

  const result: DailyActivity[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    const playersOnDay = Array.from(players.values()).filter((p) => {
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
export function formatItemName(itemId: string): string {
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
function parseInventoryContainer(
  container: PlayerFileInventoryContainer | undefined,
): ParsedInventoryItem[] {
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
        const displayName = getPlayerNameFromFile(data);

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
 * Resolve a player's display name across save layouts.
 * 2026-05 stores it on Components.Nameplate.Text; older saves used
 * Components.DisplayName.DisplayName.RawText.
 */
function getPlayerNameFromFile(data: PlayerFileData): string | undefined {
  return data.Components?.Nameplate?.Text || data.Components?.DisplayName?.DisplayName?.RawText;
}

/**
 * Get player inventory by name
 */
export async function getPlayerInventoryFromFile(
  playerName: string,
): Promise<ParsedPlayerInventory | null> {
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoPlayerInventory(playerName);
  }

  const uuid = await findPlayerUuidByName(playerName);
  if (!uuid) return null;

  const data = await readPlayerFile(uuid);
  if (!data) return null;

  const comps = data.Components;
  // 2026-05 layout: each container is a top-level component wrapping the actual
  // container under `.Inventory`. Older saves nested them under Player.Inventory.
  const legacy = comps?.Player?.Inventory;
  const storageC = comps?.StorageInventory?.Inventory ?? legacy?.Storage;
  const armorC = comps?.ArmorInventory?.Inventory ?? legacy?.Armor;
  const hotbarC = comps?.HotbarInventory?.Inventory ?? legacy?.HotBar;
  const utilityC = comps?.UtilityInventory?.Inventory ?? legacy?.Utility;
  const backpackC = comps?.BackpackInventory?.Inventory ?? legacy?.Backpack;
  const toolsC = comps?.ToolInventory?.Inventory ?? legacy?.Tool;

  // Only bail when the save carries no inventory containers at all.
  if (!storageC && !armorC && !hotbarC && !utilityC && !backpackC && !toolsC) {
    return null;
  }

  const displayName = getPlayerNameFromFile(data) || playerName;

  const storage = parseInventoryContainer(storageC);
  const armor = parseInventoryContainer(armorC);
  const hotbar = parseInventoryContainer(hotbarC);
  const utility = parseInventoryContainer(utilityC);
  const backpack = parseInventoryContainer(backpackC);
  const tools = parseInventoryContainer(toolsC);

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
    // ActiveSlot now lives on the outer Hotbar component; fall back to the
    // legacy Player.Inventory field.
    activeHotbarSlot: comps?.HotbarInventory?.ActiveSlot ?? legacy?.ActiveHotbarSlot ?? 0,
    totalSlots:
      (storageC?.Capacity || 0) +
      (armorC?.Capacity || 0) +
      (hotbarC?.Capacity || 0) +
      (utilityC?.Capacity || 0) +
      (backpackC?.Capacity || 0) +
      (toolsC?.Capacity || 0),
    usedSlots: allItems.length,
    capacities: {
      storage: storageC?.Capacity || 36,
      armor: armorC?.Capacity || 4,
      hotbar: hotbarC?.Capacity || 9,
      utility: utilityC?.Capacity || 4,
      backpack: backpackC?.Capacity || 0,
      tools: toolsC?.Capacity || 2,
    },
  };
}

/**
 * Get player details by name
 */
export async function getPlayerDetailsFromFile(
  playerName: string,
): Promise<ParsedPlayerDetails | null> {
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoPlayerDetails(playerName);
  }

  const uuid = await findPlayerUuidByName(playerName);
  if (!uuid) return null;

  const data = await readPlayerFile(uuid);
  if (!data) return null;

  const components = data.Components;
  const player = components?.Player;
  const entityStats = components?.EntityStats;
  const transform = components?.Transform;
  const displayName = getPlayerNameFromFile(data) || playerName;

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
    position: transform?.Position
      ? {
          x: Math.round(transform.Position.X * 100) / 100,
          y: Math.round(transform.Position.Y * 100) / 100,
          z: Math.round(transform.Position.Z * 100) / 100,
        }
      : null,
    rotation: transform?.Rotation
      ? {
          pitch: transform.Rotation.Pitch,
          yaw: transform.Rotation.Yaw,
          roll: transform.Rotation.Roll,
        }
      : null,
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
        const displayName = getPlayerNameFromFile(data);

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
export async function getPlayerDeathPositionsFromFile(
  playerName: string,
): Promise<ParsedDeathPosition[]> {
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoDeathPositions(playerName);
  }

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
 * Also includes online players who don't have JSON files yet (e.g., after folder deletion)
 */
export async function getAllPlayersUnified(): Promise<UnifiedPlayerEntry[]> {
  // Demo mode: return mock data
  if (isDemoMode()) {
    return getDemoAllPlayersUnified();
  }

  await loadPlayers(); // Load session tracking data

  const result: UnifiedPlayerEntry[] = [];
  const includedPlayerNames = new Set<string>(); // Track which players we've already added

  // Get list of online player names for quick lookup
  const onlinePlayerNames = new Set(
    Array.from(players.values())
      .filter((p) => p.online)
      .map((p) => p.name.toLowerCase()),
  );

  // First, read players from JSON files
  try {
    const playersDir = getUniversePlayersPath();
    const files = await readdir(playersDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await readFile(path.join(playersDir, file), 'utf-8');
        const data: PlayerFileData = JSON.parse(content);
        const displayName = getPlayerNameFromFile(data);

        if (!displayName) continue;

        const uuid = file.replace('.json', '');
        const isOnline = onlinePlayerNames.has(displayName.toLowerCase());

        // Get session tracking data if available
        // First try exact name match, then fall back to UUID match
        // This handles player name changes: the file has the new name,
        // but players.json still has the old name as key
        let sessionData = players.get(displayName);
        if (!sessionData) {
          for (const entry of players.values()) {
            if (entry.uuid === uuid) {
              // Found by UUID - player changed their name
              // Update the Map: remove old key, add new key with updated name
              const oldName = entry.name;
              entry.name = displayName;
              players.delete(oldName);
              players.set(displayName, entry);
              sessionData = entry;
              logger.info(
                `[Players] Name change detected: "${oldName}" -> "${displayName}" (UUID: ${uuid})`,
              );
              debouncedSavePlayers();
              break;
            }
          }
        }

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
          position: transform?.Position
            ? {
                x: Math.round(transform.Position.X * 100) / 100,
                y: Math.round(transform.Position.Y * 100) / 100,
                z: Math.round(transform.Position.Z * 100) / 100,
              }
            : undefined,
          health: healthStat?.Value,
          maxHealth,
          lastSeen: sessionData?.lastSeen,
          playTime: sessionData?.playTime,
          sessionCount: sessionData?.sessionCount,
        });

        includedPlayerNames.add(displayName.toLowerCase());
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory might not exist, continue to add online players from session tracking
  }

  // Second, add online players from session tracking who don't have JSON files
  // This ensures players are shown even if their JSON files were deleted
  for (const player of players.values()) {
    if (player.online && !includedPlayerNames.has(player.name.toLowerCase())) {
      result.push({
        name: player.name,
        uuid: player.uuid || '',
        online: true,
        world: player.world,
        lastSeen: player.lastSeen,
        playTime: player.playTime,
        sessionCount: player.sessionCount,
      });
      includedPlayerNames.add(player.name.toLowerCase());
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
}
