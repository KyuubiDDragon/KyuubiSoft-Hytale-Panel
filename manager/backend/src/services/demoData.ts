/**
 * Demo Data Service
 *
 * Provides mock data for demo mode, allowing the panel to run
 * without a real Hytale server for demonstration purposes.
 */

import type { ServerStatus, ServerStats, PlayerInfo } from '../types/index.js';
import type { PlayerEntry, PlayerStatistics, DailyActivity, UnifiedPlayerEntry, ParsedPlayerInventory, ParsedPlayerDetails, ParsedDeathPosition } from './players.js';

// ============================================================
// Demo Configuration
// ============================================================

const DEMO_SERVER_NAME = 'KyuubiSoft Demo Server';
const DEMO_UPTIME_START = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago

// ============================================================
// Mock Player Data
// ============================================================

const DEMO_PLAYERS: PlayerEntry[] = [
  {
    name: 'KyuubiDDragon',
    online: true,
    uuid: '550e8400-e29b-41d4-a716-446655440001',
    ip: '192.168.1.100',
    world: 'Orbis',
    firstSeen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date().toISOString(),
    currentSessionStart: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    playTime: 432000, // 120 hours
    sessionCount: 156,
  },
  {
    name: 'DragonSlayer99',
    online: true,
    uuid: '550e8400-e29b-41d4-a716-446655440002',
    ip: '192.168.1.101',
    world: 'Orbis',
    firstSeen: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date().toISOString(),
    currentSessionStart: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    playTime: 324000, // 90 hours
    sessionCount: 89,
  },
  {
    name: 'CrystalMiner',
    online: true,
    uuid: '550e8400-e29b-41d4-a716-446655440003',
    ip: '192.168.1.102',
    world: 'Nexus',
    firstSeen: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date().toISOString(),
    currentSessionStart: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    playTime: 216000, // 60 hours
    sessionCount: 72,
  },
  {
    name: 'ShadowWalker',
    online: false,
    uuid: '550e8400-e29b-41d4-a716-446655440004',
    ip: '192.168.1.103',
    world: 'Orbis',
    firstSeen: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    playTime: 180000, // 50 hours
    sessionCount: 45,
  },
  {
    name: 'ForestExplorer',
    online: false,
    uuid: '550e8400-e29b-41d4-a716-446655440005',
    ip: '192.168.1.104',
    world: 'Wilderness',
    firstSeen: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    playTime: 108000, // 30 hours
    sessionCount: 28,
  },
  {
    name: 'StormBringer',
    online: false,
    uuid: '550e8400-e29b-41d4-a716-446655440006',
    ip: '192.168.1.105',
    world: 'Orbis',
    firstSeen: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    playTime: 72000, // 20 hours
    sessionCount: 15,
  },
  {
    name: 'IronCrafter',
    online: false,
    uuid: '550e8400-e29b-41d4-a716-446655440007',
    ip: '192.168.1.106',
    world: 'Nexus',
    firstSeen: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    playTime: 36000, // 10 hours
    sessionCount: 8,
  },
  {
    name: 'NightHunter',
    online: false,
    uuid: '550e8400-e29b-41d4-a716-446655440008',
    ip: '192.168.1.107',
    world: 'Orbis',
    firstSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    lastSeen: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    playTime: 18000, // 5 hours
    sessionCount: 4,
  },
];

// ============================================================
// Server Status & Stats
// ============================================================

export function getDemoStatus(): ServerStatus {
  return {
    status: 'running',
    running: true,
    id: 'demo123456ab',
    name: 'hytale-demo',
    created: DEMO_UPTIME_START.toISOString(),
    started_at: DEMO_UPTIME_START.toISOString(),
  };
}

export function getDemoStats(): ServerStats {
  // Simulate realistic fluctuating values
  const baseTime = Date.now();
  const cpuVariation = Math.sin(baseTime / 10000) * 15 + Math.random() * 10;
  const memVariation = Math.sin(baseTime / 30000) * 5 + Math.random() * 3;

  const cpuPercent = Math.max(15, Math.min(85, 45 + cpuVariation));
  const memoryMb = Math.max(2500, Math.min(3800, 3200 + memVariation * 100));
  const memoryLimitMb = 4096;

  return {
    cpu_percent: Math.round(cpuPercent * 100) / 100,
    memory_bytes: memoryMb * 1024 * 1024,
    memory_limit_bytes: memoryLimitMb * 1024 * 1024,
    memory_percent: Math.round((memoryMb / memoryLimitMb) * 10000) / 100,
    memory_mb: Math.round(memoryMb * 10) / 10,
    memory_limit_mb: memoryLimitMb,
  };
}

// ============================================================
// Player Data
// ============================================================

export function getDemoOnlinePlayers(): PlayerInfo[] {
  const now = new Date();
  return DEMO_PLAYERS
    .filter(p => p.online && p.currentSessionStart)
    .map(p => {
      const sessionStart = new Date(p.currentSessionStart!);
      const durationMs = now.getTime() - sessionStart.getTime();
      const totalSeconds = Math.floor(durationMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);

      return {
        name: p.name,
        joined_at: p.currentSessionStart!,
        session_duration_seconds: totalSeconds,
        session_duration: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
      };
    });
}

export function getDemoOfflinePlayers(): PlayerEntry[] {
  return DEMO_PLAYERS.filter(p => !p.online);
}

export function getDemoAllPlayers(): PlayerEntry[] {
  return [...DEMO_PLAYERS].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
  });
}

export function getDemoPlayerCount(): number {
  return DEMO_PLAYERS.filter(p => p.online).length;
}

export function getDemoPlayerStatistics(): PlayerStatistics {
  const totalPlayers = DEMO_PLAYERS.length;
  const totalPlaytime = DEMO_PLAYERS.reduce((sum, p) => sum + p.playTime, 0);
  const totalSessions = DEMO_PLAYERS.reduce((sum, p) => sum + p.sessionCount, 0);

  return {
    totalPlayers,
    totalPlaytime,
    averagePlaytime: Math.round(totalPlaytime / totalPlayers),
    averageSessionsPerPlayer: Math.round((totalSessions / totalPlayers) * 10) / 10,
    topPlayers: DEMO_PLAYERS
      .sort((a, b) => b.playTime - a.playTime)
      .slice(0, 10)
      .map(p => ({ name: p.name, playTime: p.playTime, sessions: p.sessionCount })),
    newPlayersLast7Days: 3,
    activePlayersLast7Days: 6,
    peakOnlineToday: 5,
  };
}

export function getDemoDailyActivity(days: number = 7): DailyActivity[] {
  const result: DailyActivity[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    // Simulate realistic activity with weekend peaks
    const dayOfWeek = date.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const baseActivity = isWeekend ? 6 : 4;
    const variation = Math.floor(Math.random() * 3);

    result.push({
      date: dateStr,
      uniquePlayers: baseActivity + variation,
      totalSessions: (baseActivity + variation) * 2,
    });
  }

  return result;
}

export function getDemoAllPlayersUnified(): UnifiedPlayerEntry[] {
  return DEMO_PLAYERS.map(p => ({
    name: p.name,
    uuid: p.uuid || '',
    online: p.online,
    world: p.world,
    gameMode: 'Adventure',
    position: {
      x: Math.round((Math.random() * 2000 - 1000) * 100) / 100,
      y: Math.round((64 + Math.random() * 50) * 100) / 100,
      z: Math.round((Math.random() * 2000 - 1000) * 100) / 100,
    },
    health: Math.round(50 + Math.random() * 50),
    maxHealth: 100,
    lastSeen: p.lastSeen,
    playTime: p.playTime,
    sessionCount: p.sessionCount,
  })).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (b.playTime || 0) - (a.playTime || 0);
  });
}

export function getDemoPlayerInventory(playerName: string): ParsedPlayerInventory | null {
  const player = DEMO_PLAYERS.find(p => p.name.toLowerCase() === playerName.toLowerCase());
  if (!player) return null;

  return {
    uuid: player.uuid || '',
    name: player.name,
    storage: [
      { slot: 0, itemId: 'Material_IronIngot', displayName: 'Iron Ingot', amount: 64, durability: 0, maxDurability: 0 },
      { slot: 1, itemId: 'Material_GoldIngot', displayName: 'Gold Ingot', amount: 32, durability: 0, maxDurability: 0 },
      { slot: 2, itemId: 'Material_Diamond', displayName: 'Diamond', amount: 16, durability: 0, maxDurability: 0 },
      { slot: 5, itemId: 'Food_Apple', displayName: 'Apple', amount: 24, durability: 0, maxDurability: 0 },
      { slot: 8, itemId: 'Material_Wood_Oak', displayName: 'Oak Wood', amount: 64, durability: 0, maxDurability: 0 },
    ],
    armor: [
      { slot: 0, itemId: 'Armor_Helmet_Iron', displayName: 'Iron Helmet', amount: 1, durability: 150, maxDurability: 165 },
      { slot: 1, itemId: 'Armor_Chestplate_Iron', displayName: 'Iron Chestplate', amount: 1, durability: 200, maxDurability: 240 },
      { slot: 2, itemId: 'Armor_Leggings_Iron', displayName: 'Iron Leggings', amount: 1, durability: 180, maxDurability: 225 },
      { slot: 3, itemId: 'Armor_Boots_Iron', displayName: 'Iron Boots', amount: 1, durability: 160, maxDurability: 195 },
    ],
    hotbar: [
      { slot: 0, itemId: 'Weapon_Sword_Diamond', displayName: 'Diamond Sword', amount: 1, durability: 1200, maxDurability: 1561 },
      { slot: 1, itemId: 'Tool_Pickaxe_Diamond', displayName: 'Diamond Pickaxe', amount: 1, durability: 1400, maxDurability: 1561 },
      { slot: 2, itemId: 'Tool_Axe_Iron', displayName: 'Iron Axe', amount: 1, durability: 200, maxDurability: 250 },
      { slot: 4, itemId: 'Food_Bread', displayName: 'Bread', amount: 32, durability: 0, maxDurability: 0 },
      { slot: 8, itemId: 'Weapon_Bow', displayName: 'Bow', amount: 1, durability: 350, maxDurability: 384 },
    ],
    utility: [
      { slot: 0, itemId: 'Item_Torch', displayName: 'Torch', amount: 64, durability: 0, maxDurability: 0 },
    ],
    backpack: [],
    tools: [
      { slot: 0, itemId: 'Tool_FishingRod', displayName: 'Fishing Rod', amount: 1, durability: 60, maxDurability: 64 },
    ],
    activeHotbarSlot: 0,
    totalSlots: 55,
    usedSlots: 15,
    capacities: {
      storage: 36,
      armor: 4,
      hotbar: 9,
      utility: 4,
      backpack: 0,
      tools: 2,
    },
  };
}

export function getDemoPlayerDetails(playerName: string): ParsedPlayerDetails | null {
  const player = DEMO_PLAYERS.find(p => p.name.toLowerCase() === playerName.toLowerCase());
  if (!player) return null;

  return {
    uuid: player.uuid || '',
    name: player.name,
    world: player.world || 'Orbis',
    gameMode: 'Adventure',
    position: {
      x: Math.round((Math.random() * 2000 - 1000) * 100) / 100,
      y: Math.round((64 + Math.random() * 50) * 100) / 100,
      z: Math.round((Math.random() * 2000 - 1000) * 100) / 100,
    },
    rotation: {
      pitch: Math.round(Math.random() * 180 - 90),
      yaw: Math.round(Math.random() * 360),
      roll: 0,
    },
    stats: {
      health: Math.round(50 + Math.random() * 50),
      maxHealth: 100,
      stamina: Math.round(5 + Math.random() * 5),
      maxStamina: 10,
      oxygen: 100,
      mana: Math.round(Math.random() * 100),
      immunity: Math.round(Math.random() * 100),
    },
    discoveredZones: ['Spawn', 'Forest', 'Mountains', 'Desert', 'Ocean Shore'],
    memoriesCount: Math.floor(Math.random() * 20),
    uniqueItemsUsed: ['Weapon_Sword_Diamond', 'Tool_Pickaxe_Diamond', 'Weapon_Bow'],
  };
}

export function getDemoDeathPositions(playerName: string): ParsedDeathPosition[] {
  const player = DEMO_PLAYERS.find(p => p.name.toLowerCase() === playerName.toLowerCase());
  if (!player) return [];

  return [
    {
      id: 'death-001',
      world: 'Orbis',
      day: 15,
      position: { x: 234.5, y: 45.0, z: -128.3 },
      rotation: { pitch: 0, yaw: 180, roll: 0 },
    },
    {
      id: 'death-002',
      world: 'Orbis',
      day: 22,
      position: { x: -567.2, y: 72.0, z: 891.4 },
      rotation: { pitch: -15, yaw: 90, roll: 0 },
    },
  ];
}

// ============================================================
// Performance Metrics (KyuubiAPI simulation)
// ============================================================

export function getDemoPerformanceMetrics() {
  const baseTime = Date.now();
  const tpsVariation = Math.sin(baseTime / 5000) * 2 + Math.random();
  const msptVariation = Math.sin(baseTime / 8000) * 5 + Math.random() * 3;

  return {
    tps: Math.max(18, Math.min(20, 19.5 + tpsVariation * 0.3)),
    mspt: Math.max(20, Math.min(50, 35 + msptVariation)),
    playerCount: getDemoPlayerCount(),
    uptime: Math.floor((Date.now() - DEMO_UPTIME_START.getTime()) / 1000),
    worldTime: Math.floor((Date.now() / 50) % 24000), // Minecraft-style day cycle
    weather: 'clear',
  };
}

export function getDemoJvmMetrics() {
  const baseTime = Date.now();
  const heapVariation = Math.sin(baseTime / 20000) * 200 + Math.random() * 100;

  const heapUsed = Math.round(2800 + heapVariation);
  const heapMax = 4096;

  return {
    heapUsed: heapUsed,
    heapMax: heapMax,
    heapPercent: Math.round((heapUsed / heapMax) * 100),
    gcCount: Math.floor(baseTime / 60000) % 100,
    gcTime: Math.floor(Math.random() * 50),
    threads: 45 + Math.floor(Math.random() * 10),
    cpuLoad: Math.round((40 + Math.random() * 20) * 100) / 100,
  };
}

// ============================================================
// Memory Stats
// ============================================================

export function getDemoMemoryStats() {
  const heapUsed = 2.8 + Math.random() * 0.5;

  return {
    available: true,
    physical: {
      total: 62.7,
      free: 5.8 + Math.random() * 2,
    },
    swap: {
      total: 7.6,
      free: 5.5 + Math.random(),
    },
    heap: {
      init: 4.0,
      used: Math.round(heapUsed * 10) / 10,
      committed: 4.0,
      max: 16.0,
    },
    raw: `Total Physical Memory: 62.7 GiB
Free Physical Memory: ${(5.8 + Math.random() * 2).toFixed(1)} GiB
Total Swap Memory: 7.6 GiB
Free Swap Memory: ${(5.5 + Math.random()).toFixed(1)} GiB
Heap Memory Usage:
Init: 4.0 GiB
Used: ${heapUsed.toFixed(1)} GiB
Committed: 4.0 GiB
Max: 16.0 GiB`,
  };
}

// ============================================================
// Backup Data
// ============================================================

export interface DemoBackup {
  name: string;
  size: number;
  created: string;
  type: 'manual' | 'scheduled';
}

export function getDemoBackups(): DemoBackup[] {
  const backups: DemoBackup[] = [];
  const now = Date.now();

  // Generate some realistic backup entries
  for (let i = 0; i < 10; i++) {
    const daysAgo = i * 1 + Math.random();
    const isScheduled = i % 3 !== 0;
    const date = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);

    backups.push({
      name: `backup_${dateStr}.tar.gz`,
      size: Math.floor(150 + Math.random() * 100) * 1024 * 1024, // 150-250 MB
      created: date.toISOString(),
      type: isScheduled ? 'scheduled' : 'manual',
    });
  }

  return backups.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
}

// ============================================================
// Console Logs
// ============================================================

const DEMO_LOG_MESSAGES = [
  '[Server] Server started on port 5520',
  '[Universe|P] Adding player \'KyuubiDDragon\' to universe',
  '[World|Orbis] Player \'KyuubiDDragon\' joined world',
  '[Universe|P] Adding player \'DragonSlayer99\' to universe',
  '[World|Orbis] Player \'DragonSlayer99\' joined world',
  '[Universe|P] Adding player \'CrystalMiner\' to universe',
  '[World|Nexus] Player \'CrystalMiner\' joined world',
  '[Server] TPS: 19.8, MSPT: 35.2ms',
  '[World|Orbis] Entity spawned at (234, 65, -128)',
  '[Server] Auto-save started...',
  '[Server] Auto-save completed in 245ms',
  '[Chat] <KyuubiDDragon> Hello everyone!',
  '[Chat] <DragonSlayer99> Hey! Ready for the dungeon?',
  '[Server] GC completed: freed 128MB in 23ms',
  '[World|Orbis] Weather changed to clear',
  '[Server] TPS: 19.9, MSPT: 32.1ms',
  '[KyuubiAPI] Metrics endpoint served',
  '[Server] Chunk loaded at (15, 8)',
  '[World|Nexus] NPC spawned: Blacksmith',
  '[Server] TPS: 20.0, MSPT: 28.5ms',
];

export function getDemoLogs(tail: number = 100): string {
  const logs: string[] = [];
  const now = Date.now();

  for (let i = 0; i < Math.min(tail, 50); i++) {
    const timestamp = new Date(now - (50 - i) * 5000).toISOString();
    const message = DEMO_LOG_MESSAGES[i % DEMO_LOG_MESSAGES.length];
    logs.push(`${timestamp} ${message}`);
  }

  return logs.join('\n');
}

// Real-time log simulation
let logIndex = 0;
export function getNextDemoLogLine(): string {
  const timestamp = new Date().toISOString();
  const message = DEMO_LOG_MESSAGES[logIndex % DEMO_LOG_MESSAGES.length];
  logIndex++;
  return `${timestamp} ${message}`;
}

// ============================================================
// Quick Settings
// ============================================================

export function getDemoQuickSettings() {
  return {
    serverName: DEMO_SERVER_NAME,
    motd: 'Welcome to KyuubiSoft Demo Server!',
    password: '',
    maxPlayers: 100,
    maxViewRadius: 32,
    defaultGameMode: 'Adventure',
  };
}

// ============================================================
// Activity Log
// ============================================================

export interface DemoActivityEntry {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  category: string;
}

export function getDemoActivityLog(): DemoActivityEntry[] {
  const entries: DemoActivityEntry[] = [];
  const now = Date.now();
  const actions = [
    { action: 'Server started', category: 'server', details: 'Server started successfully' },
    { action: 'Player kicked', category: 'player', details: 'Kicked player: TestUser (Reason: AFK)' },
    { action: 'Backup created', category: 'backup', details: 'Manual backup created: backup_2026-01-24.tar.gz' },
    { action: 'Config updated', category: 'config', details: 'Updated MOTD setting' },
    { action: 'Mod enabled', category: 'mods', details: 'Enabled mod: EasyWebMap' },
    { action: 'User logged in', category: 'auth', details: 'Admin user logged in' },
    { action: 'Command executed', category: 'command', details: 'Executed: /weather clear' },
    { action: 'Scheduled restart', category: 'scheduler', details: 'Scheduled restart executed' },
  ];

  for (let i = 0; i < 20; i++) {
    const hoursAgo = i * 2 + Math.random() * 2;
    const actionData = actions[i % actions.length];

    entries.push({
      id: `activity-${i}`,
      timestamp: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
      user: i % 3 === 0 ? 'System' : 'admin',
      action: actionData.action,
      details: actionData.details,
      category: actionData.category,
    });
  }

  return entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ============================================================
// Mod List
// ============================================================

export interface DemoMod {
  name: string;
  filename: string;
  enabled: boolean;
  size: number;
  version?: string;
}

export function getDemoMods(): DemoMod[] {
  return [
    { name: 'EasyWebMap', filename: 'EasyWebMap-1.2.0.jar', enabled: true, size: 2457600, version: '1.2.0' },
    { name: 'BetterChat', filename: 'BetterChat-0.5.1.jar', enabled: true, size: 524288, version: '0.5.1' },
    { name: 'AdminTools', filename: 'AdminTools-2.0.0.jar', enabled: true, size: 1048576, version: '2.0.0' },
    { name: 'CustomNPCs', filename: 'CustomNPCs-1.1.0.jar', enabled: false, size: 3145728, version: '1.1.0' },
  ];
}

export function getDemoPlugins(): DemoMod[] {
  return [
    { name: 'KyuubiAPI', filename: 'KyuubiAPI-1.2.1.jar', enabled: true, size: 1572864, version: '1.2.1' },
    { name: 'Essentials', filename: 'Essentials-3.0.0.jar', enabled: true, size: 2097152, version: '3.0.0' },
  ];
}

// ============================================================
// Worlds
// ============================================================

export interface DemoWorld {
  name: string;
  size: number;
  playerCount: number;
  lastPlayed: string;
}

export function getDemoWorlds(): DemoWorld[] {
  return [
    { name: 'Orbis', size: 1073741824, playerCount: 2, lastPlayed: new Date().toISOString() },
    { name: 'Nexus', size: 536870912, playerCount: 1, lastPlayed: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    { name: 'Wilderness', size: 268435456, playerCount: 0, lastPlayed: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() },
  ];
}

// ============================================================
// Chat Log
// ============================================================

export interface DemoChatMessage {
  timestamp: string;
  player: string;
  message: string;
  type: 'chat' | 'system' | 'command';
}

export function getDemoChatLog(): DemoChatMessage[] {
  const messages: DemoChatMessage[] = [];
  const now = Date.now();
  const chatData = [
    { player: 'KyuubiDDragon', message: 'Hello everyone!', type: 'chat' as const },
    { player: 'DragonSlayer99', message: 'Hey! Ready for the dungeon?', type: 'chat' as const },
    { player: 'KyuubiDDragon', message: 'Yeah, let me grab some supplies first', type: 'chat' as const },
    { player: 'CrystalMiner', message: 'Found some rare crystals in the cave!', type: 'chat' as const },
    { player: 'System', message: 'Server auto-save completed', type: 'system' as const },
    { player: 'DragonSlayer99', message: 'Nice! Can you share the coords?', type: 'chat' as const },
    { player: 'CrystalMiner', message: 'Sure, -567, 72, 891', type: 'chat' as const },
    { player: 'admin', message: '/weather clear', type: 'command' as const },
    { player: 'System', message: 'Weather set to clear', type: 'system' as const },
    { player: 'KyuubiDDragon', message: 'Great, clear skies for our adventure!', type: 'chat' as const },
  ];

  for (let i = 0; i < chatData.length; i++) {
    messages.push({
      timestamp: new Date(now - (chatData.length - i) * 30000).toISOString(),
      ...chatData[i],
    });
  }

  return messages;
}

// ============================================================
// Scheduler
// ============================================================

export interface DemoSchedulerTask {
  id: string;
  type: 'backup' | 'restart';
  enabled: boolean;
  schedule: string;
  lastRun?: string;
  nextRun: string;
}

export function getDemoSchedulerTasks(): DemoSchedulerTask[] {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(4, 0, 0, 0);

  return [
    {
      id: 'backup-daily',
      type: 'backup',
      enabled: true,
      schedule: '0 4 * * *',
      lastRun: new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString(),
      nextRun: tomorrow.toISOString(),
    },
    {
      id: 'restart-weekly',
      type: 'restart',
      enabled: true,
      schedule: '0 5 * * 0',
      lastRun: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      nextRun: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
}

// ============================================================
// Demo Mode Check
// ============================================================

import { config } from '../config.js';

export function isDemoMode(): boolean {
  return config.demoMode;
}

// ============================================================
// Update System
// ============================================================

export function getDemoUpdateStatus() {
  return {
    currentVersion: '1.0.0-demo',
    latestVersion: '1.0.1-demo',
    updateAvailable: true,
    releaseNotes: 'Demo release notes: Bug fixes and performance improvements.',
    downloadProgress: null,
    status: 'update_available',
  };
}

export function getDemoUpdateConfig() {
  return {
    autoCheck: true,
    autoDownload: false,
    checkInterval: 3600,
    notifyOnUpdate: true,
  };
}

export function getDemoVersionInfo() {
  return {
    serverVersion: '1.0.0-demo',
    panelVersion: '2.1.1',
    pluginVersion: '1.2.1',
    patchline: 'release',
  };
}

// ============================================================
// Plugin Update
// ============================================================

export function getDemoPluginUpdateStatus() {
  return {
    available: true,
    currentVersion: '1.2.0',
    latestVersion: '1.2.1',
    changelog: 'New features: Enhanced metrics, bug fixes for player tracking.',
  };
}

// ============================================================
// New Features Banner
// ============================================================

export function getDemoNewFeatures() {
  return {
    version: '2.1.1',
    features: [
      {
        title: 'Demo Mode',
        description: 'Run the panel without a real Hytale server for demonstration purposes.',
        icon: 'play-circle',
      },
      {
        title: 'Enhanced Performance Monitoring',
        description: 'Real-time TPS, MSPT and JVM metrics with historical graphs.',
        icon: 'activity',
      },
      {
        title: 'Player Statistics',
        description: 'Track player activity, playtime, and session history.',
        icon: 'users',
      },
    ],
    dismissed: false,
  };
}

// ============================================================
// Server Config Files
// ============================================================

export function getDemoConfigFiles() {
  return [
    { name: 'config.json', size: 4096, lastModified: new Date().toISOString() },
    { name: 'whitelist.json', size: 256, lastModified: new Date().toISOString() },
    { name: 'bans.json', size: 128, lastModified: new Date().toISOString() },
    { name: 'permissions.json', size: 512, lastModified: new Date().toISOString() },
  ];
}

export function getDemoServerConfig() {
  return {
    ServerName: 'KyuubiSoft Demo Server',
    MOTD: 'Welcome to the demo server!',
    MaxPlayers: 100,
    MaxViewRadius: 32,
    Password: '',
    Defaults: {
      GameMode: 'Adventure',
    },
    Network: {
      Port: 5520,
      BindAddress: '0.0.0.0',
    },
  };
}

// ============================================================
// Downloader / Auth Status
// ============================================================

export function getDemoDownloaderStatus() {
  return {
    authenticated: true,
    username: 'demo@example.com',
    lastAuth: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    patchline: 'release',
  };
}

// ============================================================
// Patchline Config
// ============================================================

export function getDemoPatchlineConfig() {
  return {
    patchline: 'release',
    acceptEarlyPlugins: false,
    disableSentry: false,
    allowOp: true,
  };
}

// ============================================================
// Roles
// ============================================================

export function getDemoRoles() {
  return [
    {
      id: 'admin',
      name: 'Admin',
      description: 'Full access to all features',
      permissions: ['*'],
      isDefault: false,
      isSystem: true,
    },
    {
      id: 'moderator',
      name: 'Moderator',
      description: 'Player management and monitoring',
      permissions: ['players.*', 'console.view', 'chat.view', 'server.view_status'],
      isDefault: false,
      isSystem: true,
    },
    {
      id: 'operator',
      name: 'Operator',
      description: 'Server operation and basic management',
      permissions: ['server.*', 'console.*', 'backups.view', 'scheduler.view'],
      isDefault: false,
      isSystem: true,
    },
    {
      id: 'viewer',
      name: 'Viewer',
      description: 'Read-only access',
      permissions: ['server.view_status', 'players.view', 'console.view'],
      isDefault: true,
      isSystem: true,
    },
  ];
}

// ============================================================
// Users
// ============================================================

export function getDemoUsers() {
  return [
    {
      username: 'admin',
      role: 'admin',
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      lastLogin: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    },
    {
      username: 'demo',
      role: 'viewer',
      createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      lastLogin: new Date().toISOString(),
    },
  ];
}

// ============================================================
// Whitelist
// ============================================================

export function getDemoWhitelist() {
  return {
    enabled: true,
    list: ['KyuubiDDragon', 'DragonSlayer', 'ShadowMage', 'IronForge', 'StormBringer'],
  };
}

// ============================================================
// Bans
// ============================================================

export function getDemoBans() {
  return {
    bans: [
      {
        player: 'GrieferX',
        target: 'demo-uuid-grieferx',
        reason: 'Griefing and harassment',
        bannedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        bannedBy: 'admin',
      },
      {
        player: 'HackerPro',
        target: 'demo-uuid-hackerpro',
        reason: 'Using exploits',
        bannedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        bannedBy: 'Console',
      },
    ],
  };
}

// ============================================================
// Permissions (Hytale server permissions)
// ============================================================

export function getDemoPermissions() {
  return {
    users: [
      { identifier: 'KyuubiDDragon', type: 'op', addedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
      { identifier: 'DragonSlayer', type: 'moderator', addedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString() },
    ],
    groups: [
      { name: 'admins', permissions: ['*'], description: 'Full server access' },
      { name: 'moderators', permissions: ['kick', 'ban', 'mute', 'teleport'], description: 'Moderation permissions' },
      { name: 'builders', permissions: ['build', 'tp'], description: 'Building permissions' },
    ],
  };
}

// ============================================================
// ModStore
// ============================================================

export function getDemoModStore() {
  return [
    {
      id: 'better-hud',
      name: 'Better HUD',
      description: 'Improved heads-up display with customizable elements',
      author: 'HUDMaster',
      version: '2.1.0',
      downloads: 15420,
      rating: 4.8,
      category: 'UI',
      installed: false,
    },
    {
      id: 'world-edit',
      name: 'World Edit Tools',
      description: 'Powerful world editing and building utilities',
      author: 'BuilderPro',
      version: '1.5.2',
      downloads: 28340,
      rating: 4.9,
      category: 'Tools',
      installed: true,
    },
    {
      id: 'custom-npcs',
      name: 'Custom NPCs',
      description: 'Create and customize NPCs with advanced AI',
      author: 'NPCCreator',
      version: '3.0.1',
      downloads: 12100,
      rating: 4.6,
      category: 'Gameplay',
      installed: false,
    },
  ];
}

// ============================================================
// Modtale Search Results
// ============================================================

export function getDemoModtaleResults() {
  return {
    results: [
      {
        id: 'modtale-1',
        name: 'Enhanced Graphics',
        slug: 'enhanced-graphics',
        description: 'High-quality textures and shader improvements',
        author: 'GraphicsTeam',
        downloads: 45000,
        followers: 1200,
        classification: 'Mod',
        featured: true,
      },
      {
        id: 'modtale-2',
        name: 'Combat Overhaul',
        slug: 'combat-overhaul',
        description: 'New combat mechanics and animations',
        author: 'CombatDev',
        downloads: 32000,
        followers: 890,
        classification: 'Mod',
        featured: false,
      },
    ],
    total: 2,
    page: 1,
    pageSize: 20,
  };
}

// ============================================================
// StackMart Search Results
// ============================================================

export function getDemoStackMartResults() {
  return {
    results: [
      {
        id: 'stackmart-1',
        name: 'Medieval Castle Pack',
        description: 'Pre-built medieval structures and decorations',
        author: 'CastleBuilder',
        downloads: 8500,
        rating: 4.7,
        category: 'Structures',
        price: 0,
      },
      {
        id: 'stackmart-2',
        name: 'Fantasy Creatures',
        description: 'New fantasy creature models and behaviors',
        author: 'CreatureStudio',
        downloads: 12300,
        rating: 4.5,
        category: 'Creatures',
        price: 0,
      },
    ],
    total: 2,
    page: 1,
    pageSize: 20,
  };
}

// ============================================================
// Assets
// ============================================================

export function getDemoAssetStatus() {
  return {
    extracted: true,
    extracting: false,
    archivePath: '/opt/hytale/assets.zip',
    extractPath: '/opt/hytale/assets',
    lastExtracted: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    fileCount: 15420,
    totalSize: 1024 * 1024 * 512, // 512 MB
    demo: true,
  };
}

export function getDemoAssetDirectory() {
  return [
    { name: 'Common', type: 'directory', size: 0, modified: new Date().toISOString() },
    { name: 'Textures', type: 'directory', size: 0, modified: new Date().toISOString() },
    { name: 'Models', type: 'directory', size: 0, modified: new Date().toISOString() },
    { name: 'Sounds', type: 'directory', size: 0, modified: new Date().toISOString() },
    { name: 'config.json', type: 'file', size: 2048, modified: new Date().toISOString() },
    { name: 'manifest.json', type: 'file', size: 1024, modified: new Date().toISOString() },
  ];
}

export function getDemoAssetTree() {
  return {
    name: 'assets',
    type: 'directory',
    children: [
      {
        name: 'Common',
        type: 'directory',
        children: [
          { name: 'Icons', type: 'directory', children: [] },
          { name: 'UI', type: 'directory', children: [] },
        ],
      },
      {
        name: 'Textures',
        type: 'directory',
        children: [
          { name: 'Blocks', type: 'directory', children: [] },
          { name: 'Items', type: 'directory', children: [] },
          { name: 'Entities', type: 'directory', children: [] },
        ],
      },
      {
        name: 'Models',
        type: 'directory',
        children: [
          { name: 'Characters', type: 'directory', children: [] },
          { name: 'Creatures', type: 'directory', children: [] },
        ],
      },
    ],
  };
}

export function getDemoAssetSearchResults(query: string) {
  return [
    { path: `Common/Icons/${query}_icon.png`, name: `${query}_icon.png`, type: 'file', size: 4096 },
    { path: `Textures/Items/${query}.png`, name: `${query}.png`, type: 'file', size: 8192 },
    { path: `Models/${query}_model.json`, name: `${query}_model.json`, type: 'file', size: 2048 },
  ];
}

export function getDemoItems() {
  return [
    { id: 'cobalt_sword', name: 'Cobalt Sword', category: 'weapon', rarity: 'rare' },
    { id: 'iron_pickaxe', name: 'Iron Pickaxe', category: 'tool', rarity: 'common' },
    { id: 'health_potion', name: 'Health Potion', category: 'consumable', rarity: 'common' },
    { id: 'dragon_scale_armor', name: 'Dragon Scale Armor', category: 'armor', rarity: 'legendary' },
    { id: 'magic_staff', name: 'Magic Staff', category: 'weapon', rarity: 'epic' },
    { id: 'wood_planks', name: 'Wood Planks', category: 'block', rarity: 'common' },
    { id: 'cobalt_ore', name: 'Cobalt Ore', category: 'block', rarity: 'uncommon' },
    { id: 'torch', name: 'Torch', category: 'utility', rarity: 'common' },
  ];
}
