import { Router, Request, Response } from 'express';
import { readFile, writeFile, readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { logActivity, getActivityLog, clearActivityLog, type ActivityLogEntry } from '../services/activityLog.js';
import type { AuthenticatedRequest } from '../types/index.js';

// Configure multer for file uploads
const modsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.modsPath);
  },
  filename: (_req, file, cb) => {
    cb(null, file.originalname);
  },
});

const pluginsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.pluginsPath);
  },
  filename: (_req, file, cb) => {
    cb(null, file.originalname);
  },
});

const uploadMod = multer({
  storage: modsStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jar', '.zip', '.js', '.lua', '.dll', '.so'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: .jar, .zip, .js, .lua, .dll, .so'));
    }
  },
});

const uploadPlugin = multer({
  storage: pluginsStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jar', '.zip', '.js', '.lua', '.dll', '.so'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: .jar, .zip, .js, .lua, .dll, .so'));
    }
  },
});

const router = Router();

// ============== WHITELIST ==============

interface WhitelistData {
  enabled: boolean;
  list: string[];
}

async function getWhitelistPath(): Promise<string> {
  return path.join(config.serverPath, 'whitelist.json');
}

async function readWhitelist(): Promise<WhitelistData> {
  try {
    const content = await readFile(await getWhitelistPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { enabled: false, list: [] };
  }
}

async function writeWhitelist(data: WhitelistData): Promise<void> {
  await writeFile(await getWhitelistPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// GET /api/management/whitelist
router.get('/whitelist', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const data = await readWhitelist();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read whitelist' });
  }
});

// PUT /api/management/whitelist/enabled
router.put('/whitelist/enabled', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const data = await readWhitelist();
    data.enabled = enabled;
    await writeWhitelist(data);
    res.json({ success: true, enabled });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update whitelist' });
  }
});

// POST /api/management/whitelist/add
router.post('/whitelist/add', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { player } = req.body;
    if (!player || typeof player !== 'string') {
      res.status(400).json({ error: 'player name required' });
      return;
    }
    const data = await readWhitelist();
    if (!data.list.includes(player)) {
      data.list.push(player);
      await writeWhitelist(data);
    }
    res.json({ success: true, list: data.list });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add to whitelist' });
  }
});

// DELETE /api/management/whitelist/:player
router.delete('/whitelist/:player', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { player } = req.params;
    const data = await readWhitelist();
    data.list = data.list.filter(p => p !== player);
    await writeWhitelist(data);
    res.json({ success: true, list: data.list });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove from whitelist' });
  }
});

// ============== BANS ==============

// Hytale server bans.json format
interface HytaleBanEntry {
  type: 'infinite' | 'temporary';
  target: string; // UUID
  by: string; // UUID of admin (00000000-0000-0000-0000-000000000000 for console)
  timestamp: number; // Unix timestamp in ms
  reason: string;
}

// Our display format with player name
interface BanEntry {
  player: string; // Player name for display
  target?: string; // UUID from Hytale
  reason?: string;
  bannedAt: string;
  bannedBy?: string;
}

// Separate file to store player name -> UUID mapping for display
interface BanNameMapping {
  [uuid: string]: string; // UUID -> player name
}

async function getBansPath(): Promise<string> {
  return path.join(config.serverPath, 'bans.json');
}

async function getBansMappingPath(): Promise<string> {
  return path.join(config.serverPath, 'bans-names.json');
}

async function readBansMapping(): Promise<BanNameMapping> {
  try {
    const content = await readFile(await getBansMappingPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeBansMapping(mapping: BanNameMapping): Promise<void> {
  await writeFile(await getBansMappingPath(), JSON.stringify(mapping, null, 2), 'utf-8');
}

async function readBans(): Promise<BanEntry[]> {
  try {
    const content = await readFile(await getBansPath(), 'utf-8');
    const data = JSON.parse(content);
    const mapping = await readBansMapping();

    if (Array.isArray(data)) {
      // Check if it's Hytale format (has 'target' and 'timestamp')
      if (data.length > 0 && 'target' in data[0] && 'timestamp' in data[0]) {
        // Convert Hytale format to our display format
        return (data as HytaleBanEntry[]).map(ban => ({
          player: mapping[ban.target] || ban.target.substring(0, 8) + '...', // Show UUID prefix if no name
          target: ban.target,
          reason: ban.reason !== 'No reason.' ? ban.reason : undefined,
          bannedAt: new Date(ban.timestamp).toISOString(),
          bannedBy: ban.by === '00000000-0000-0000-0000-000000000000' ? 'Console' : (mapping[ban.by] || 'Admin'),
        }));
      }
      // Legacy format - return as is
      return data as BanEntry[];
    }
    return [];
  } catch {
    return [];
  }
}

// GET /api/management/bans
router.get('/bans', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const bans = await readBans();
    res.json({ bans });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read bans' });
  }
});

// POST /api/management/bans/add - Stores name mapping, server command handles actual ban
router.post('/bans/add', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { player, reason } = req.body;
    if (!player || typeof player !== 'string') {
      res.status(400).json({ error: 'player name required' });
      return;
    }

    // Import docker service to execute ban command
    const { execCommand } = await import('../services/docker.js');

    // First kick the player
    await execCommand(`/kick ${player} ${reason || 'You have been banned'}`);

    // Execute ban command - server will update bans.json
    const banCommand = reason ? `/ban ${player} ${reason}` : `/ban ${player}`;
    const result = await execCommand(banCommand);

    if (!result.success) {
      res.status(500).json({ error: result.error || 'Failed to ban player' });
      return;
    }

    // Log activity
    await logActivity(
      req.user || 'Admin',
      'ban',
      'player',
      true,
      player,
      reason || undefined
    );

    // Wait a moment for server to update bans.json, then read it
    await new Promise(resolve => setTimeout(resolve, 500));
    const bans = await readBans();

    // Try to store the player name mapping for future display
    // We need to find the new ban entry by checking which UUID doesn't have a name
    const mapping = await readBansMapping();
    let updated = false;
    for (const ban of bans) {
      if (ban.target && !mapping[ban.target]) {
        // This might be the new ban - store the name
        mapping[ban.target] = player;
        updated = true;
      }
    }
    if (updated) {
      await writeBansMapping(mapping);
      // Re-read bans with updated mapping
      const updatedBans = await readBans();
      res.json({ success: true, bans: updatedBans });
      return;
    }

    res.json({ success: true, bans });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add ban' });
  }
});

// DELETE /api/management/bans/:player - Execute unban command (works online and offline)
router.delete('/bans/:player', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { player } = req.params;

    // Import docker service to check status and execute commands
    const { execCommand, getStatus } = await import('../services/docker.js');

    // First, find the player's UUID from our mapping
    const mapping = await readBansMapping();
    let playerUuid: string | undefined;
    let playerName = player;

    // Check if the input is already a UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(player)) {
      playerUuid = player;
      playerName = mapping[player] || player;
    } else {
      // It's a name, find the UUID
      const uuidEntry = Object.entries(mapping).find(([, name]) => name === player);
      if (uuidEntry) {
        playerUuid = uuidEntry[0];
      }
    }

    // Check if server is running
    const status = await getStatus();
    const serverRunning = status.running;

    let commandSent = false;
    if (serverRunning) {
      // Server is online - try unban command with both name and UUID
      // Try with player name first
      let result = await execCommand(`/unban ${playerName}`);
      if (result.success) {
        commandSent = true;
        console.log(`Unban command sent for player name: ${playerName}`);
      }

      // Also try with UUID if we have it
      if (playerUuid && playerUuid !== playerName) {
        result = await execCommand(`/unban ${playerUuid}`);
        if (result.success) {
          commandSent = true;
          console.log(`Unban command sent for UUID: ${playerUuid}`);
        }
      }

      // Wait a moment for server to process
      if (commandSent) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // ALWAYS directly modify bans.json as well (server might not update the file)
    const bansPath = await getBansPath();
    let fileModified = false;

    try {
      const content = await readFile(bansPath, 'utf-8');
      const bansData = JSON.parse(content);

      if (Array.isArray(bansData)) {
        const originalLength = bansData.length;

        // Filter out the ban (check both target UUID and name mapping)
        const filteredBans = bansData.filter((ban: HytaleBanEntry) => {
          const banName = mapping[ban.target];
          // Remove if target matches UUID or name matches player
          if (playerUuid && ban.target === playerUuid) return false;
          if (banName === playerName) return false;
          if (ban.target === player) return false; // Direct match
          return true;
        });

        if (filteredBans.length < originalLength) {
          // Write back the filtered bans
          await writeFile(bansPath, JSON.stringify(filteredBans, null, 2), 'utf-8');
          fileModified = true;
          console.log(`Removed ${originalLength - filteredBans.length} ban(s) from bans.json`);

          // Also update our name mapping (remove the unbanned player)
          if (playerUuid) {
            delete mapping[playerUuid];
            await writeBansMapping(mapping);
          }
        }
      }
    } catch (fileError) {
      console.error('Error modifying bans.json:', fileError);
    }

    // Log activity
    const details = serverRunning
      ? (commandSent ? 'Command sent + file modified' : 'File modified only')
      : 'Direct file modification (server offline)';
    await logActivity(req.user || 'Admin', 'unban', 'player', true, playerName, details);

    const bans = await readBans();
    res.json({ success: true, bans, fileModified, commandSent });
  } catch (error) {
    console.error('Unban error:', error);
    res.status(500).json({ error: 'Failed to remove ban' });
  }
});

// ============== PERMISSIONS ==============

// Hytale permissions.json format:
// {
//   "users": { "UUID": { "groups": ["Group1", "Group2"] } },
//   "groups": { "GroupName": ["permission1", "permission2"] }
// }

interface HytalePermissionsData {
  users: { [uuid: string]: { groups: string[] } };
  groups: { [name: string]: string[] };
}

// Our display format with player names
interface PermissionUser {
  uuid: string;
  name: string; // Display name
  groups: string[];
}

interface PermissionGroup {
  name: string;
  permissions: string[];
}

interface PermissionsDisplayData {
  users: PermissionUser[];
  groups: PermissionGroup[];
}

// Name mapping file for permissions (UUID -> player name)
interface PermissionsNameMapping {
  [uuid: string]: string;
}

async function getPermissionsPath(): Promise<string> {
  return path.join(config.serverPath, 'permissions.json');
}

async function getPermissionsNameMappingPath(): Promise<string> {
  return path.join(config.serverPath, 'permissions-names.json');
}

async function readPermissionsNameMapping(): Promise<PermissionsNameMapping> {
  try {
    const content = await readFile(await getPermissionsNameMappingPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writePermissionsNameMapping(mapping: PermissionsNameMapping): Promise<void> {
  await writeFile(await getPermissionsNameMappingPath(), JSON.stringify(mapping, null, 2), 'utf-8');
}

async function readHytalePermissions(): Promise<HytalePermissionsData> {
  try {
    const content = await readFile(await getPermissionsPath(), 'utf-8');
    const data = JSON.parse(content);
    return {
      users: data.users || {},
      groups: data.groups || {},
    };
  } catch {
    return { users: {}, groups: {} };
  }
}

async function writeHytalePermissions(data: HytalePermissionsData): Promise<void> {
  await writeFile(await getPermissionsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// Convert Hytale format to display format
async function readPermissionsDisplay(): Promise<PermissionsDisplayData> {
  const hytale = await readHytalePermissions();
  const mapping = await readPermissionsNameMapping();

  const users: PermissionUser[] = Object.entries(hytale.users).map(([uuid, userData]) => ({
    uuid,
    name: mapping[uuid] || uuid.substring(0, 8) + '...',
    groups: userData.groups || [],
  }));

  const groups: PermissionGroup[] = Object.entries(hytale.groups).map(([name, permissions]) => ({
    name,
    permissions: permissions || [],
  }));

  return { users, groups };
}

// GET /api/management/permissions
router.get('/permissions', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const data = await readPermissionsDisplay();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read permissions' });
  }
});

// POST /api/management/permissions/users
router.post('/permissions/users', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, uuid, groups } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }

    const hytale = await readHytalePermissions();
    const mapping = await readPermissionsNameMapping();

    // If UUID provided, use it; otherwise we need to get it from the server
    let targetUuid = uuid;

    if (!targetUuid) {
      // Try to find existing UUID for this player name in mapping
      const existingEntry = Object.entries(mapping).find(([, n]) => n === name);
      if (existingEntry) {
        targetUuid = existingEntry[0];
      } else {
        // Generate a placeholder - the server will use the correct UUID when the player joins
        // For now, store the name as a temporary key
        targetUuid = `name:${name}`;
      }
    }

    // Update Hytale permissions
    hytale.users[targetUuid] = { groups: groups || [] };
    await writeHytalePermissions(hytale);

    // Update name mapping
    mapping[targetUuid] = name;
    await writePermissionsNameMapping(mapping);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, users: displayData.users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user permissions' });
  }
});

// DELETE /api/management/permissions/users/:identifier (can be UUID or name)
router.delete('/permissions/users/:identifier', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    const hytale = await readHytalePermissions();
    const mapping = await readPermissionsNameMapping();

    // Try to find the UUID - identifier could be UUID or name
    let targetUuid = identifier;
    if (!hytale.users[identifier]) {
      // Not a UUID, try to find by name
      const entry = Object.entries(mapping).find(([, name]) => name === identifier);
      if (entry) {
        targetUuid = entry[0];
      }
    }

    // Remove from Hytale permissions
    delete hytale.users[targetUuid];
    await writeHytalePermissions(hytale);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, users: displayData.users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// POST /api/management/permissions/groups
router.post('/permissions/groups', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, permissions } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }

    const hytale = await readHytalePermissions();

    // Update group permissions (Hytale format: groups are objects with permission arrays)
    hytale.groups[name] = permissions || [];
    await writeHytalePermissions(hytale);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, groups: displayData.groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// DELETE /api/management/permissions/groups/:name
router.delete('/permissions/groups/:name', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const hytale = await readHytalePermissions();

    // Remove group from Hytale permissions
    delete hytale.groups[name];
    await writeHytalePermissions(hytale);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, groups: displayData.groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove group' });
  }
});

// ============== WORLDS ==============

interface WorldInfo {
  name: string;
  path: string;
  size: number;
  lastModified: string;
}

// Possible world paths to check
function getWorldsPaths(): string[] {
  return [
    path.join(config.dataPath, 'worlds'),
    path.join(config.serverPath, 'worlds'),
    path.join(config.serverPath, 'data', 'worlds'),
    path.join(config.dataPath),
  ];
}

async function scanWorldsInPath(worldsPath: string): Promise<WorldInfo[]> {
  const worlds: WorldInfo[] = [];
  try {
    const entries = await readdir(worldsPath);

    for (const entry of entries) {
      const entryPath = path.join(worldsPath, entry);
      try {
        const stats = await stat(entryPath);
        if (stats.isDirectory()) {
          // Check if it looks like a world (has level.dat or world files)
          let isWorld = false;
          let size = 0;
          try {
            const files = await readdir(entryPath);
            // A world directory typically has certain files
            isWorld = files.length > 0;
            for (const file of files) {
              try {
                const fileStat = await stat(path.join(entryPath, file));
                size += fileStat.size;
              } catch {
                // Ignore
              }
            }
          } catch {
            // Ignore
          }

          if (isWorld) {
            worlds.push({
              name: entry,
              path: entryPath,
              size,
              lastModified: stats.mtime.toISOString(),
            });
          }
        }
      } catch {
        // Skip entries that can't be read
      }
    }
  } catch {
    // Path doesn't exist or can't be read
  }
  return worlds;
}

// GET /api/management/worlds
router.get('/worlds', authMiddleware, async (_req: Request, res: Response) => {
  try {
    let worlds: WorldInfo[] = [];
    const checkedPaths: string[] = [];

    // Check all possible world paths
    for (const worldsPath of getWorldsPaths()) {
      checkedPaths.push(worldsPath);
      const found = await scanWorldsInPath(worldsPath);
      // Avoid duplicates
      for (const world of found) {
        if (!worlds.some(w => w.path === world.path)) {
          worlds.push(world);
        }
      }
    }

    res.json({ worlds, checkedPaths });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read worlds' });
  }
});

// ============== MODS & PLUGINS ==============

interface ModInfo {
  name: string;
  filename: string;
  size: number;
  lastModified: string;
  enabled: boolean;
}

async function scanDirectory(dirPath: string, type: 'mod' | 'plugin'): Promise<ModInfo[]> {
  const items: ModInfo[] = [];
  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);
      try {
        const stats = await stat(entryPath);
        if (stats.isFile()) {
          // Check for common mod/plugin extensions
          const ext = path.extname(entry).toLowerCase();
          const isValidFile = ['.jar', '.zip', '.js', '.lua', '.dll', '.so'].includes(ext);
          const isDisabled = entry.endsWith('.disabled');

          if (isValidFile || isDisabled) {
            items.push({
              name: entry.replace('.disabled', '').replace(ext, ''),
              filename: entry,
              size: stats.size,
              lastModified: stats.mtime.toISOString(),
              enabled: !isDisabled,
            });
          }
        }
      } catch {
        // Skip entries that can't be read
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return items;
}

// GET /api/management/mods
router.get('/mods', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const mods = await scanDirectory(config.modsPath, 'mod');
    res.json({ mods, path: config.modsPath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read mods' });
  }
});

// GET /api/management/plugins
router.get('/plugins', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const plugins = await scanDirectory(config.pluginsPath, 'plugin');
    res.json({ plugins, path: config.pluginsPath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read plugins' });
  }
});

// PUT /api/management/mods/:filename/toggle
router.put('/mods/:filename/toggle', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(config.modsPath, filename);
    const disabledPath = filePath.endsWith('.disabled')
      ? filePath.slice(0, -9)
      : filePath + '.disabled';

    const { rename } = await import('fs/promises');

    if (filename.endsWith('.disabled')) {
      await rename(filePath, disabledPath);
    } else {
      await rename(filePath, disabledPath);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle mod' });
  }
});

// PUT /api/management/plugins/:filename/toggle
router.put('/plugins/:filename/toggle', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(config.pluginsPath, filename);
    const disabledPath = filePath.endsWith('.disabled')
      ? filePath.slice(0, -9)
      : filePath + '.disabled';

    const { rename } = await import('fs/promises');

    if (filename.endsWith('.disabled')) {
      await rename(filePath, disabledPath);
    } else {
      await rename(filePath, disabledPath);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle plugin' });
  }
});

// ============== PERFORMANCE STATS HISTORY ==============

interface StatsEntry {
  timestamp: string;
  cpu: number;
  memory: number;
  players: number;
}

const statsHistory: StatsEntry[] = [];
const MAX_STATS_HISTORY = 60; // Keep 60 entries (e.g., 1 hour at 1 per minute)

export function addStatsEntry(entry: Omit<StatsEntry, 'timestamp'>): void {
  statsHistory.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  // Keep only the last MAX_STATS_HISTORY entries
  while (statsHistory.length > MAX_STATS_HISTORY) {
    statsHistory.shift();
  }
}

// GET /api/management/stats/history
router.get('/stats/history', authMiddleware, async (_req: Request, res: Response) => {
  res.json({ history: statsHistory });
});

// ============== FILE UPLOAD FOR MODS & PLUGINS ==============

// POST /api/management/mods/upload
router.post('/mods/upload', authMiddleware, uploadMod.single('file'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    await logActivity(
      req.user || 'unknown',
      'upload_mod',
      'mod',
      true,
      req.file.originalname,
      `Uploaded mod: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`
    );

    res.json({
      success: true,
      filename: req.file.originalname,
      size: req.file.size,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload mod' });
  }
});

// POST /api/management/plugins/upload
router.post('/plugins/upload', authMiddleware, uploadPlugin.single('file'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    await logActivity(
      req.user || 'unknown',
      'upload_plugin',
      'mod',
      true,
      req.file.originalname,
      `Uploaded plugin: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`
    );

    res.json({
      success: true,
      filename: req.file.originalname,
      size: req.file.size,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload plugin' });
  }
});

// DELETE /api/management/mods/:filename
router.delete('/mods/:filename', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(config.modsPath, filename);
    await unlink(filePath);

    await logActivity(
      req.user || 'unknown',
      'delete_mod',
      'mod',
      true,
      filename,
      `Deleted mod: ${filename}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete mod' });
  }
});

// DELETE /api/management/plugins/:filename
router.delete('/plugins/:filename', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(config.pluginsPath, filename);
    await unlink(filePath);

    await logActivity(
      req.user || 'unknown',
      'delete_plugin',
      'mod',
      true,
      filename,
      `Deleted plugin: ${filename}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete plugin' });
  }
});

// ============== MOD/PLUGIN CONFIG FILES ==============

// GET /api/management/mods/:filename/configs
router.get('/mods/:filename/configs', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const modName = filename.replace(/\.(jar|zip|disabled)$/i, '');

    // Check common config locations
    const configPaths = [
      path.join(config.modsPath, modName),
      path.join(config.modsPath, 'config', modName),
      path.join(config.serverPath, 'config', modName),
      path.join(config.dataPath, 'config', modName),
    ];

    const configs: { name: string; path: string }[] = [];

    for (const configPath of configPaths) {
      try {
        const entries = await readdir(configPath);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (['.json', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.properties'].includes(ext)) {
            configs.push({
              name: entry,
              path: path.join(configPath, entry),
            });
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    res.json({ configs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get mod configs' });
  }
});

// GET /api/management/plugins/:filename/configs
router.get('/plugins/:filename/configs', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const pluginName = filename.replace(/\.(jar|zip|disabled)$/i, '');

    // Check common config locations
    const configPaths = [
      path.join(config.pluginsPath, pluginName),
      path.join(config.pluginsPath, 'config', pluginName),
      path.join(config.serverPath, 'plugins', pluginName),
      path.join(config.dataPath, 'plugins', pluginName),
    ];

    const configs: { name: string; path: string }[] = [];

    for (const configPath of configPaths) {
      try {
        const entries = await readdir(configPath);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (['.json', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.properties'].includes(ext)) {
            configs.push({
              name: entry,
              path: path.join(configPath, entry),
            });
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    res.json({ configs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get plugin configs' });
  }
});

// GET /api/management/config/read
router.get('/config/read', authMiddleware, async (req: Request, res: Response) => {
  try {
    const configPath = req.query.path as string;
    if (!configPath) {
      res.status(400).json({ error: 'Path required' });
      return;
    }

    // Security: ensure path is within allowed directories
    const normalizedPath = path.normalize(configPath);
    const allowedPrefixes = [config.modsPath, config.pluginsPath, config.serverPath, config.dataPath];
    const isAllowed = allowedPrefixes.some(prefix => normalizedPath.startsWith(prefix));

    if (!isAllowed) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const content = await readFile(configPath, 'utf-8');
    res.json({ content, path: configPath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read config' });
  }
});

// PUT /api/management/config/write
router.put('/config/write', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { path: configPath, content } = req.body;
    if (!configPath || content === undefined) {
      res.status(400).json({ error: 'Path and content required' });
      return;
    }

    // Security: ensure path is within allowed directories
    const normalizedPath = path.normalize(configPath);
    const allowedPrefixes = [config.modsPath, config.pluginsPath, config.serverPath, config.dataPath];
    const isAllowed = allowedPrefixes.some(prefix => normalizedPath.startsWith(prefix));

    if (!isAllowed) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await writeFile(configPath, content, 'utf-8');

    await logActivity(
      req.user || 'unknown',
      'edit_config',
      'config',
      true,
      path.basename(configPath),
      `Edited config: ${configPath}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to write config' });
  }
});

// ============== ACTIVITY LOG ==============

// GET /api/management/activity
router.get('/activity', authMiddleware, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as ActivityLogEntry['category'] | undefined;
    const user = req.query.user as string | undefined;

    const result = getActivityLog({ limit, offset, category, user });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get activity log' });
  }
});

// DELETE /api/management/activity
router.delete('/activity', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await clearActivityLog();

    await logActivity(
      req.user || 'unknown',
      'clear_activity_log',
      'system',
      true,
      undefined,
      'Cleared activity log'
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear activity log' });
  }
});

// Helper function to log activity from other routes
export { logActivity };

export default router;
