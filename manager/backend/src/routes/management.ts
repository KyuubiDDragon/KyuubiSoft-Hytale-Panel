import { Router, Request, Response } from 'express';
import { readFile, writeFile, readdir, stat, unlink, realpath } from 'fs/promises';
import * as fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { config } from '../config.js';
import { logActivity, getActivityLog, clearActivityLog, type ActivityLogEntry } from '../services/activityLog.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { getRealPathIfSafe, isPathSafe, sanitizeFileName } from '../utils/pathSecurity.js';
import { isDemoMode, getDemoMods, getDemoPlugins, getDemoWorlds, getDemoActivityLog, getDemoWhitelist, getDemoBans, getDemoPermissions, getDemoModStore, getDemoModtaleResults, getDemoStackMartResults } from '../services/demoData.js';

// SECURITY: Magic bytes for file type verification
const FILE_SIGNATURES = {
  // ZIP/JAR files (PK\x03\x04 or PK\x05\x06 for empty)
  zip: [
    [0x50, 0x4B, 0x03, 0x04],
    [0x50, 0x4B, 0x05, 0x06],
    [0x50, 0x4B, 0x07, 0x08],
  ],
  // Lua script files start with -- or specific patterns
  lua: null, // Text file, check extension only
  // JavaScript files are text
  js: null, // Text file, check extension only
};

// SECURITY: Verify file magic bytes match expected type
function verifyFileMagic(filePath: string, expectedType: 'zip' | 'lua' | 'js'): boolean {
  try {
    const signatures = FILE_SIGNATURES[expectedType];
    if (!signatures) {
      // Text files - verify they don't contain binary data
      const buffer = Buffer.alloc(512);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, 512, 0);
      fs.closeSync(fd);
      // Check for null bytes (binary indicator)
      for (let i = 0; i < Math.min(buffer.length, 512); i++) {
        if (buffer[i] === 0) return false;
      }
      return true;
    }

    const buffer = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);

    return signatures.some(sig =>
      sig.every((byte, i) => buffer[i] === byte)
    );
  } catch {
    return false;
  }
}

// SECURITY: Generate safe filename with unique prefix
function generateSafeFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);
  // Sanitize the base name
  const safeName = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .substring(0, 100);
  // Add unique prefix to prevent overwrites
  const uniqueId = crypto.randomBytes(4).toString('hex');
  return `${safeName}_${uniqueId}${ext}`;
}
import { getAvailableMods, installMod, uninstallMod, updateMod, getLatestRelease, refreshRegistry, getRegistryInfo, getModRegistry, checkModUpdate } from '../services/modStore.js';
import {
  searchMods as modtaleSearch,
  getModDetails as modtaleGetDetails,
  installModFromModtale,
  uninstallModtale,
  checkModtaleStatus,
  getTags as modtaleGetTags,
  getClassifications as modtaleGetClassifications,
  getGameVersions as modtaleGetGameVersions,
  getFeaturedMods,
  getRecentMods,
  clearModtaleCache,
  isValidProjectId,
  isValidVersion,
  getInstalledModtaleInfo,
  type ModtaleSortOption,
  type ModtaleClassification,
} from '../services/modtale.js';
import {
  searchResources as stackmartSearch,
  getResourceDetails as stackmartGetDetails,
  installResourceFromStackMart,
  uninstallStackMart,
  checkStackMartStatus,
  getCategories as stackmartGetCategories,
  getPopularResources,
  getRecentResources,
  clearStackMartCache,
  isValidResourceId,
  getInstalledStackMartInfo,
  type StackMartSortOption,
  type StackMartCategory,
} from '../services/stackmart.js';
import {
  searchMods as curseforgeSearch,
  getModDetails as curseforgeGetDetails,
  getModFiles as curseforgeGetFiles,
  installModFromCurseForge,
  uninstallCurseForge,
  updateMod as curseforgeUpdateMod,
  checkCurseForgeStatus,
  getCategories as curseforgeGetCategories,
  getFeaturedMods as curseforgeFeatured,
  getRecentMods as curseforgeRecent,
  getPopularMods as curseforgePopular,
  checkForUpdates as curseforgeCheckUpdates,
  clearCurseForgeCache,
  isValidModId as isValidCurseForgeModId,
  getInstalledCurseForgeInfo,
  type CurseForgeSortField,
  type CurseForgeSortOrder,
} from '../services/curseforge.js';
import {
  getModInfo as cfwidgetGetMod,
  extractSlugFromUrl,
  trackMod as cfwidgetTrackMod,
  untrackMod as cfwidgetUntrackMod,
  checkModUpdate as cfwidgetCheckMod,
  checkAllUpdates as cfwidgetCheckAll,
  getUpdateStatus as cfwidgetStatus,
  updateInstalledVersion as cfwidgetUpdateVersion,
  installTrackedMod as cfwidgetInstallMod,
  uninstallTrackedMod as cfwidgetUninstallMod,
  clearCFWidgetCache,
} from '../services/cfwidget.js';
import { getUnifiedUpdateStatus } from '../services/unifiedUpdates.js';

// SECURITY: Allowed file extensions for uploads
// Removed .dll and .so as they are native executables
const ALLOWED_MOD_EXTENSIONS = ['.jar', '.zip', '.js', '.lua'];
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit (reduced from 100MB)

// Configure multer for file uploads with security improvements
const modsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.modsPath);
  },
  filename: (_req, file, cb) => {
    // SECURITY: Generate safe filename to prevent path traversal and overwrites
    cb(null, generateSafeFilename(file.originalname));
  },
});

const pluginsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.pluginsPath);
  },
  filename: (_req, file, cb) => {
    // SECURITY: Generate safe filename to prevent path traversal and overwrites
    cb(null, generateSafeFilename(file.originalname));
  },
});

const uploadMod = multer({
  storage: modsStorage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // SECURITY: Only allow safe extensions
    if (ALLOWED_MOD_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${ALLOWED_MOD_EXTENSIONS.join(', ')}`));
    }
  },
});

const uploadPlugin = multer({
  storage: pluginsStorage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // SECURITY: Only allow safe extensions
    if (ALLOWED_MOD_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${ALLOWED_MOD_EXTENSIONS.join(', ')}`));
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
router.get('/whitelist', authMiddleware, requirePermission('players.whitelist'), async (_req: Request, res: Response) => {
  // Demo mode: return demo whitelist
  if (isDemoMode()) {
    res.json(getDemoWhitelist());
    return;
  }

  try {
    const data = await readWhitelist();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read whitelist' });
  }
});

// PUT /api/management/whitelist/enabled
router.put('/whitelist/enabled', authMiddleware, requirePermission('players.whitelist'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate whitelist toggle
  if (isDemoMode()) {
    const { enabled } = req.body;
    res.json({ success: true, enabled, message: '[DEMO] Whitelist toggled (simulated)' });
    return;
  }

  try {
    const { enabled } = req.body;
    const username = req.user || 'system';
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const data = await readWhitelist();
    data.enabled = enabled;
    await writeWhitelist(data);
    await logActivity(username, 'whitelist_toggle', 'config', true, undefined, enabled ? 'Enabled whitelist' : 'Disabled whitelist');
    res.json({ success: true, enabled });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update whitelist' });
  }
});

// POST /api/management/whitelist/add
router.post('/whitelist/add', authMiddleware, requirePermission('players.whitelist'), async (req: Request, res: Response) => {
  // Demo mode: simulate adding to whitelist
  if (isDemoMode()) {
    const { player } = req.body;
    const demoList = getDemoWhitelist().list;
    res.json({ success: true, list: [...demoList, player], message: '[DEMO] Player added (simulated)' });
    return;
  }

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
router.delete('/whitelist/:player', authMiddleware, requirePermission('players.whitelist'), async (req: Request, res: Response) => {
  // Demo mode: simulate removing from whitelist
  if (isDemoMode()) {
    const { player } = req.params;
    const demoList = getDemoWhitelist().list.filter(p => p !== player);
    res.json({ success: true, list: demoList, message: '[DEMO] Player removed (simulated)' });
    return;
  }

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
router.get('/bans', authMiddleware, requirePermission('players.ban'), async (_req: Request, res: Response) => {
  // Demo mode: return demo bans
  if (isDemoMode()) {
    res.json(getDemoBans());
    return;
  }

  try {
    const bans = await readBans();
    res.json({ bans });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read bans' });
  }
});

// POST /api/management/bans/add - Stores name mapping, server command handles actual ban
router.post('/bans/add', authMiddleware, requirePermission('players.ban'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate banning
  if (isDemoMode()) {
    const { player, reason } = req.body;
    const demoBans = getDemoBans().bans;
    demoBans.push({
      player,
      target: `demo-uuid-${player.toLowerCase()}`,
      reason: reason || 'Banned by admin',
      bannedAt: new Date().toISOString(),
      bannedBy: 'admin',
    });
    res.json({ success: true, bans: demoBans, message: '[DEMO] Player banned (simulated)' });
    return;
  }

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
router.delete('/bans/:player', authMiddleware, requirePermission('players.unban'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate unbanning
  if (isDemoMode()) {
    const { player } = req.params;
    const demoBans = getDemoBans().bans.filter(b => b.player !== player);
    res.json({ success: true, bans: demoBans, message: '[DEMO] Player unbanned (simulated)' });
    return;
  }

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
router.get('/permissions', authMiddleware, requirePermission('players.permissions'), async (_req: Request, res: Response) => {
  // Demo mode: return demo permissions
  if (isDemoMode()) {
    res.json(getDemoPermissions());
    return;
  }

  try {
    const data = await readPermissionsDisplay();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read permissions' });
  }
});

// POST /api/management/permissions/users
router.post('/permissions/users', authMiddleware, requirePermission('players.permissions'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate adding user permission
  if (isDemoMode()) {
    const { name, groups } = req.body;
    const demoPerms = getDemoPermissions();
    demoPerms.users.push({ identifier: name, type: groups?.[0] || 'member', addedAt: new Date().toISOString() });
    res.json({ success: true, users: demoPerms.users, message: '[DEMO] User permission added (simulated)' });
    return;
  }

  try {
    const { name, uuid, groups } = req.body;
    const username = req.user || 'system';
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

    await logActivity(username, 'permissions_user_update', 'user', true, name, `Groups: ${(groups || []).join(', ') || 'none'}`);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, users: displayData.users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user permissions' });
  }
});

// DELETE /api/management/permissions/users/:identifier (can be UUID or name)
router.delete('/permissions/users/:identifier', authMiddleware, requirePermission('players.permissions'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate removing user permission
  if (isDemoMode()) {
    const { identifier } = req.params;
    const demoPerms = getDemoPermissions();
    demoPerms.users = demoPerms.users.filter(u => u.identifier !== identifier);
    res.json({ success: true, users: demoPerms.users, message: '[DEMO] User permission removed (simulated)' });
    return;
  }

  try {
    const { identifier } = req.params;
    const username = req.user || 'system';
    const hytale = await readHytalePermissions();
    const mapping = await readPermissionsNameMapping();

    // Try to find the UUID - identifier could be UUID or name
    let targetUuid = identifier;
    let displayName = identifier;
    if (!hytale.users[identifier]) {
      // Not a UUID, try to find by name
      const entry = Object.entries(mapping).find(([, name]) => name === identifier);
      if (entry) {
        targetUuid = entry[0];
        displayName = entry[1];
      }
    } else {
      displayName = mapping[identifier] || identifier;
    }

    // Remove from Hytale permissions
    delete hytale.users[targetUuid];
    await writeHytalePermissions(hytale);

    await logActivity(username, 'permissions_user_remove', 'user', true, displayName);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, users: displayData.users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// POST /api/management/permissions/groups
router.post('/permissions/groups', authMiddleware, requirePermission('players.permissions'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate creating group
  if (isDemoMode()) {
    const { name, permissions } = req.body;
    const demoPerms = getDemoPermissions();
    demoPerms.groups.push({ name, permissions: permissions || [], description: 'User created group' });
    res.json({ success: true, groups: demoPerms.groups, message: '[DEMO] Group created (simulated)' });
    return;
  }

  try {
    const { name, permissions } = req.body;
    const username = req.user || 'system';
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }

    const hytale = await readHytalePermissions();

    // Update group permissions (Hytale format: groups are objects with permission arrays)
    hytale.groups[name] = permissions || [];
    await writeHytalePermissions(hytale);

    await logActivity(username, 'permissions_group_update', 'user', true, name, `Permissions: ${(permissions || []).length} entries`);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, groups: displayData.groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// DELETE /api/management/permissions/groups/:name
router.delete('/permissions/groups/:name', authMiddleware, requirePermission('players.permissions'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate deleting group
  if (isDemoMode()) {
    const { name } = req.params;
    const demoPerms = getDemoPermissions();
    demoPerms.groups = demoPerms.groups.filter(g => g.name !== name);
    res.json({ success: true, groups: demoPerms.groups, message: '[DEMO] Group deleted (simulated)' });
    return;
  }

  try {
    const { name } = req.params;
    const username = req.user || 'system';
    const hytale = await readHytalePermissions();

    // Remove group from Hytale permissions
    delete hytale.groups[name];
    await writeHytalePermissions(hytale);

    await logActivity(username, 'permissions_group_remove', 'user', true, name);

    const displayData = await readPermissionsDisplay();
    res.json({ success: true, groups: displayData.groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove group' });
  }
});

// ============== WORLDS ==============

interface WorldFileInfo {
  name: string;
  path: string;  // relative path within world (e.g., "config.json" or "resources/Time.json")
  size: number;
  lastModified: string;
}

interface WorldInfo {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  hasConfig: boolean;
  files: WorldFileInfo[];  // All editable JSON files in this world
}

// Possible world paths to check - only actual world directories
function getWorldsPaths(): string[] {
  return [
    path.join(config.dataPath, 'worlds'),                    // /opt/hytale/data/worlds
    path.join(config.serverPath, 'universe', 'worlds'),      // /opt/hytale/server/universe/worlds (symlink)
    path.join(config.serverPath, 'worlds'),                  // /opt/hytale/server/worlds (fallback)
  ];
}

async function scanWorldFiles(worldPath: string): Promise<WorldFileInfo[]> {
  const files: WorldFileInfo[] = [];

  // Scan root level JSON files (config.json, etc.)
  try {
    const rootEntries = await readdir(worldPath, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.bak')) {
        const filePath = path.join(worldPath, entry.name);
        try {
          const stats = await stat(filePath);
          files.push({
            name: entry.name,
            path: entry.name,
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
          });
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Ignore
  }

  // Scan resources folder
  const resourcesPath = path.join(worldPath, 'resources');
  try {
    const resourceEntries = await readdir(resourcesPath, { withFileTypes: true });
    for (const entry of resourceEntries) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.bak')) {
        const filePath = path.join(resourcesPath, entry.name);
        try {
          const stats = await stat(filePath);
          files.push({
            name: entry.name,
            path: `resources/${entry.name}`,
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
          });
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // resources folder doesn't exist
  }

  return files;
}

async function scanWorldsInPath(worldsPath: string, seenRealPaths: Set<string>): Promise<WorldInfo[]> {
  const worlds: WorldInfo[] = [];
  try {
    const entries = await readdir(worldsPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const entryPath = path.join(worldsPath, entry.name);
      try {
        // Resolve symlinks to get the real path
        const realEntryPath = await realpath(entryPath);

        // Skip if we've already seen this real path (prevents duplicates from symlinks)
        if (seenRealPaths.has(realEntryPath)) {
          continue;
        }
        seenRealPaths.add(realEntryPath);

        const stats = await stat(entryPath);

        // Check if this is a real world by looking for config.json
        const configPath = path.join(entryPath, 'config.json');
        let hasConfig = false;
        try {
          await stat(configPath);
          hasConfig = true;
        } catch {
          // No config.json
        }

        // Scan all JSON files in this world
        const files = await scanWorldFiles(entryPath);

        // Calculate total size
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);

        // Only include directories that have config.json (actual worlds)
        if (hasConfig) {
          worlds.push({
            name: entry.name,
            path: entryPath,
            size: totalSize,
            lastModified: stats.mtime.toISOString(),
            hasConfig: true,
            files,
          });
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
router.get('/worlds', authMiddleware, requirePermission('worlds.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock worlds
  if (isDemoMode()) {
    const demoWorlds = getDemoWorlds();
    res.json({
      worlds: demoWorlds.map(w => ({
        name: w.name,
        path: `/opt/hytale/worlds/${w.name}`,
        size: w.size,
        lastModified: w.lastPlayed,
        hasConfig: true,
        playerCount: w.playerCount,
      })),
      checkedPaths: ['/opt/hytale/worlds'],
    });
    return;
  }

  try {
    let worlds: WorldInfo[] = [];
    const checkedPaths: string[] = [];
    const seenRealPaths = new Set<string>(); // Track real paths to prevent symlink duplicates

    // Check all possible world paths
    for (const worldsPath of getWorldsPaths()) {
      checkedPaths.push(worldsPath);
      const found = await scanWorldsInPath(worldsPath, seenRealPaths);
      worlds.push(...found);
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
  // Update info (optional - only for mods in registry)
  storeId?: string;
  installedVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
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
router.get('/mods', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock mods
  if (isDemoMode()) {
    const demoMods = getDemoMods();
    res.json({
      mods: demoMods.map(m => ({
        name: m.name,
        filename: m.filename,
        size: m.size,
        lastModified: new Date().toISOString(),
        enabled: m.enabled,
        installedVersion: m.version,
      })),
      path: '/opt/hytale/mods',
    });
    return;
  }

  try {
    const mods = await scanDirectory(config.modsPath, 'mod');

    // Get mod registry to check for updates
    const registry = await getModRegistry();

    // Enrich mods with update info from registry
    const enrichedMods = await Promise.all(mods.map(async (mod) => {
      // Try to match mod to registry entry by filename
      const modNameLower = mod.name.toLowerCase();
      const registryEntry = registry.find(entry =>
        modNameLower.includes(entry.id.toLowerCase()) ||
        modNameLower.includes(entry.name.toLowerCase())
      );

      if (registryEntry) {
        try {
          const updateInfo = await checkModUpdate(registryEntry.id);
          return {
            ...mod,
            storeId: registryEntry.id,
            installedVersion: updateInfo.installedVersion,
            latestVersion: updateInfo.latestVersion,
            hasUpdate: updateInfo.hasUpdate,
          };
        } catch {
          return { ...mod, storeId: registryEntry.id };
        }
      }
      return mod;
    }));

    res.json({ mods: enrichedMods, path: config.modsPath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read mods' });
  }
});

// GET /api/management/plugins
router.get('/plugins', authMiddleware, requirePermission('plugins.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock plugins
  if (isDemoMode()) {
    const demoPlugins = getDemoPlugins();
    res.json({
      plugins: demoPlugins.map(p => ({
        name: p.name,
        filename: p.filename,
        size: p.size,
        lastModified: new Date().toISOString(),
        enabled: p.enabled,
        installedVersion: p.version,
      })),
      path: '/opt/hytale/plugins',
    });
    return;
  }

  try {
    const plugins = await scanDirectory(config.pluginsPath, 'plugin');
    res.json({ plugins, path: config.pluginsPath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read plugins' });
  }
});

// PUT /api/management/mods/:filename/toggle
router.put('/mods/:filename/toggle', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;

    // SECURITY: Validate filename to prevent path traversal
    const safeFilename = sanitizeFileName(filename);
    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const username = req.user || 'system';
    const filePath = path.join(config.modsPath, safeFilename);

    // SECURITY: Verify path is within mods directory
    if (!isPathSafe(filePath, [config.modsPath])) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const isCurrentlyDisabled = safeFilename.endsWith('.disabled');
    const disabledPath = isCurrentlyDisabled
      ? filePath.slice(0, -9)
      : filePath + '.disabled';

    const { rename } = await import('fs/promises');

    if (isCurrentlyDisabled) {
      await rename(filePath, disabledPath);
      await logActivity(username, 'enable_mod', 'mod', true, safeFilename.replace('.disabled', ''));
    } else {
      await rename(filePath, disabledPath);
      await logActivity(username, 'disable_mod', 'mod', true, safeFilename);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle mod' });
  }
});

// PUT /api/management/plugins/:filename/toggle
router.put('/plugins/:filename/toggle', authMiddleware, requirePermission('plugins.install'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;

    // SECURITY: Validate filename to prevent path traversal
    const safeFilename = sanitizeFileName(filename);
    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const username = req.user || 'system';
    const filePath = path.join(config.pluginsPath, safeFilename);

    // SECURITY: Verify path is within plugins directory
    if (!isPathSafe(filePath, [config.pluginsPath])) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const isCurrentlyDisabled = safeFilename.endsWith('.disabled');
    const disabledPath = isCurrentlyDisabled
      ? filePath.slice(0, -9)
      : filePath + '.disabled';

    const { rename } = await import('fs/promises');

    if (isCurrentlyDisabled) {
      await rename(filePath, disabledPath);
      await logActivity(username, 'enable_plugin', 'mod', true, safeFilename.replace('.disabled', ''));
    } else {
      await rename(filePath, disabledPath);
      await logActivity(username, 'disable_plugin', 'mod', true, safeFilename);
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
router.get('/stats/history', authMiddleware, requirePermission('performance.view'), async (_req: Request, res: Response) => {
  res.json({ history: statsHistory });
});

// ============== FILE UPLOAD FOR MODS & PLUGINS ==============

// POST /api/management/mods/upload
router.post('/mods/upload', authMiddleware, requirePermission('mods.install'), uploadMod.single('file'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const expectedType: 'zip' | 'lua' | 'js' = (ext === '.jar' || ext === '.zip') ? 'zip' : (ext === '.lua' ? 'lua' : 'js');

    // SECURITY: Verify file magic bytes match expected type
    if (!verifyFileMagic(req.file.path, expectedType)) {
      // Delete the uploaded file
      await unlink(req.file.path).catch(() => {});
      console.warn(`[SECURITY] Blocked upload with invalid magic bytes: ${req.file.originalname}`);
      res.status(400).json({ error: 'Invalid file content. File does not match expected format.' });
      return;
    }

    await logActivity(
      req.user || 'unknown',
      'upload_mod',
      'mod',
      true,
      req.file.originalname,
      `Uploaded mod: ${req.file.filename} (original: ${req.file.originalname}, ${(req.file.size / 1024 / 1024).toFixed(2)} MB)`
    );

    res.json({
      success: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  } catch (error) {
    // Try to clean up uploaded file on error
    if (req.file?.path) {
      await unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: 'Failed to upload mod' });
  }
});

// POST /api/management/plugins/upload
router.post('/plugins/upload', authMiddleware, requirePermission('plugins.install'), uploadPlugin.single('file'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const expectedType: 'zip' | 'lua' | 'js' = (ext === '.jar' || ext === '.zip') ? 'zip' : (ext === '.lua' ? 'lua' : 'js');

    // SECURITY: Verify file magic bytes match expected type
    if (!verifyFileMagic(req.file.path, expectedType)) {
      // Delete the uploaded file
      await unlink(req.file.path).catch(() => {});
      console.warn(`[SECURITY] Blocked upload with invalid magic bytes: ${req.file.originalname}`);
      res.status(400).json({ error: 'Invalid file content. File does not match expected format.' });
      return;
    }

    await logActivity(
      req.user || 'unknown',
      'upload_plugin',
      'mod',
      true,
      req.file.originalname,
      `Uploaded plugin: ${req.file.filename} (original: ${req.file.originalname}, ${(req.file.size / 1024 / 1024).toFixed(2)} MB)`
    );

    res.json({
      success: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  } catch (error) {
    // Try to clean up uploaded file on error
    if (req.file?.path) {
      await unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ error: 'Failed to upload plugin' });
  }
});

// DELETE /api/management/mods/:filename
router.delete('/mods/:filename', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;

    // SECURITY: Validate filename to prevent path traversal
    const safeFilename = sanitizeFileName(filename);
    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const filePath = path.join(config.modsPath, safeFilename);

    // SECURITY: Verify path is within mods directory
    if (!isPathSafe(filePath, [config.modsPath])) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    await unlink(filePath);

    await logActivity(
      req.user || 'unknown',
      'delete_mod',
      'mod',
      true,
      safeFilename,
      `Deleted mod: ${safeFilename}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete mod' });
  }
});

// DELETE /api/management/plugins/:filename
router.delete('/plugins/:filename', authMiddleware, requirePermission('plugins.delete'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { filename } = req.params;

    // SECURITY: Validate filename to prevent path traversal
    const safeFilename = sanitizeFileName(filename);
    if (!safeFilename) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const filePath = path.join(config.pluginsPath, safeFilename);

    // SECURITY: Verify path is within plugins directory
    if (!isPathSafe(filePath, [config.pluginsPath])) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    await unlink(filePath);

    await logActivity(
      req.user || 'unknown',
      'delete_plugin',
      'mod',
      true,
      safeFilename,
      `Deleted plugin: ${safeFilename}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete plugin' });
  }
});

// ============== MOD/PLUGIN CONFIG FILES ==============

// Helper: Extract base mod name without version (e.g., "EasyWebMap-v1.0.9" -> "EasyWebMap")
function extractBaseModName(filename: string): string {
  // Remove extension first
  let name = filename.replace(/\.(jar|zip|disabled)$/i, '');
  // Remove version patterns like -v1.0.0, -1.0.0, _v1.0.0
  name = name.replace(/[-_]v?\d+(\.\d+)*$/i, '');
  return name;
}

// Helper: Find config directories matching mod name (fuzzy search)
async function findConfigDirs(baseDir: string, modName: string): Promise<string[]> {
  const result: string[] = [];
  const modNameLower = modName.toLowerCase();

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const entryLower = entry.name.toLowerCase();
        const entryNormalized = entryLower.replace(/[_-]/g, '');
        const modNameNormalized = modNameLower.replace(/[_-]/g, '');

        // Match patterns:
        // 1. Folder contains mod name: "cryptobench_EasyWebMap" contains "easywebmap"
        // 2. Mod name contains folder name
        // 3. Pattern: author_modname (e.g., cryptobench_EasyWebMap)
        // 4. Normalized comparison (ignoring _ and -)
        if (
          entryLower.includes(modNameLower) ||
          modNameLower.includes(entryLower) ||
          entryNormalized.includes(modNameNormalized) ||
          modNameNormalized.includes(entryNormalized) ||
          entryLower.endsWith('_' + modNameLower) ||
          entryLower.startsWith(modNameLower + '_')
        ) {
          result.push(path.join(baseDir, entry.name));
        }
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
    console.log(`findConfigDirs: Could not read ${baseDir}:`, e);
  }

  return result;
}

// GET /api/management/mods/:filename/configs
router.get('/mods/:filename/configs', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const modName = filename.replace(/\.(jar|zip|disabled)$/i, '');
    const baseModName = extractBaseModName(filename);

    console.log(`Looking for configs for mod: ${filename}, baseName: ${baseModName}`);

    // Priority search locations (mods directory first!)
    const configPaths: string[] = [];

    // 1. First search in mods directory (highest priority)
    const modsMatches = await findConfigDirs(config.modsPath, baseModName);
    configPaths.push(...modsMatches);
    console.log(`Found in modsPath (${config.modsPath}):`, modsMatches);

    // 2. Exact matches in common locations
    configPaths.push(
      path.join(config.modsPath, modName),
      path.join(config.modsPath, baseModName),
      path.join(config.modsPath, 'config', modName),
      path.join(config.modsPath, 'config', baseModName),
      path.join(config.serverPath, 'config', modName),
      path.join(config.serverPath, 'config', baseModName),
      path.join(config.dataPath, 'config', modName),
      path.join(config.dataPath, 'config', baseModName),
    );

    // 3. Also search in server/config and data/config for fuzzy matches
    const serverConfigMatches = await findConfigDirs(path.join(config.serverPath, 'config'), baseModName);
    const dataConfigMatches = await findConfigDirs(path.join(config.dataPath, 'config'), baseModName);
    configPaths.push(...serverConfigMatches, ...dataConfigMatches);

    // Deduplicate paths
    const uniquePaths = [...new Set(configPaths)];

    const configs: { name: string; path: string }[] = [];

    for (const configPath of uniquePaths) {
      try {
        const entries = await readdir(configPath);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (['.json', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.properties'].includes(ext)) {
            const fullPath = path.join(configPath, entry);
            // Avoid duplicates
            if (!configs.some(c => c.path === fullPath)) {
              configs.push({
                name: entry,
                path: fullPath,
              });
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    console.log(`Found ${configs.length} config files for ${filename}:`, configs.map(c => c.path));
    res.json({ configs });
  } catch (error) {
    console.error('Failed to get mod configs:', error);
    res.status(500).json({ error: 'Failed to get mod configs' });
  }
});

// GET /api/management/plugins/:filename/configs
router.get('/plugins/:filename/configs', authMiddleware, requirePermission('plugins.view'), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const pluginName = filename.replace(/\.(jar|zip|disabled)$/i, '');
    const basePluginName = extractBaseModName(filename);

    console.log(`Looking for configs for plugin: ${filename}, baseName: ${basePluginName}`);

    // Priority search locations (plugins directory first!)
    const configPaths: string[] = [];

    // 1. First search in plugins directory (highest priority)
    const pluginsMatches = await findConfigDirs(config.pluginsPath, basePluginName);
    configPaths.push(...pluginsMatches);

    // 2. Exact matches in common locations
    configPaths.push(
      path.join(config.pluginsPath, pluginName),
      path.join(config.pluginsPath, basePluginName),
      path.join(config.pluginsPath, 'config', pluginName),
      path.join(config.pluginsPath, 'config', basePluginName),
      path.join(config.serverPath, 'plugins', pluginName),
      path.join(config.serverPath, 'plugins', basePluginName),
      path.join(config.dataPath, 'plugins', pluginName),
      path.join(config.dataPath, 'plugins', basePluginName),
    );

    // 3. Also search in server/plugins and data/plugins for fuzzy matches
    const serverPluginsMatches = await findConfigDirs(path.join(config.serverPath, 'plugins'), basePluginName);
    const dataPluginsMatches = await findConfigDirs(path.join(config.dataPath, 'plugins'), basePluginName);
    configPaths.push(...serverPluginsMatches, ...dataPluginsMatches);

    // Deduplicate paths
    const uniquePaths = [...new Set(configPaths)];

    const configs: { name: string; path: string }[] = [];

    for (const configPath of uniquePaths) {
      try {
        const entries = await readdir(configPath);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (['.json', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.properties'].includes(ext)) {
            const fullPath = path.join(configPath, entry);
            // Avoid duplicates
            if (!configs.some(c => c.path === fullPath)) {
              configs.push({
                name: entry,
                path: fullPath,
              });
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    console.log(`Found ${configs.length} config files for plugin ${filename}:`, configs.map(c => c.path));
    res.json({ configs });
  } catch (error) {
    console.error('Failed to get plugin configs:', error);
    res.status(500).json({ error: 'Failed to get plugin configs' });
  }
});

// GET /api/management/config/read
router.get('/config/read', authMiddleware, requirePermission('config.view'), async (req: Request, res: Response) => {
  try {
    const configPath = req.query.path as string;
    if (!configPath) {
      res.status(400).json({ error: 'Path required' });
      return;
    }

    // SECURITY: Use proper path validation to prevent traversal attacks
    const allowedDirectories = [config.modsPath, config.pluginsPath, config.serverPath, config.dataPath];
    const safePath = getRealPathIfSafe(configPath, allowedDirectories);

    if (!safePath) {
      console.warn(`[SECURITY] Blocked path traversal attempt: ${configPath}`);
      res.status(403).json({ error: 'Access denied - invalid path' });
      return;
    }

    const content = await readFile(safePath, 'utf-8');
    res.json({ content, path: safePath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read config' });
  }
});

// PUT /api/management/config/write
router.put('/config/write', authMiddleware, requirePermission('config.edit'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { path: configPath, content } = req.body;
    if (!configPath || content === undefined) {
      res.status(400).json({ error: 'Path and content required' });
      return;
    }

    // SECURITY: Use proper path validation to prevent traversal attacks
    const allowedDirectories = [config.modsPath, config.pluginsPath, config.serverPath, config.dataPath];
    const safePath = getRealPathIfSafe(configPath, allowedDirectories);

    if (!safePath) {
      console.warn(`[SECURITY] Blocked path traversal attempt (write): ${configPath}`);
      res.status(403).json({ error: 'Access denied - invalid path' });
      return;
    }

    await writeFile(safePath, content, 'utf-8');

    await logActivity(
      req.user || 'unknown',
      'edit_config',
      'config',
      true,
      path.basename(safePath),
      `Edited config: ${safePath}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to write config' });
  }
});

// ============== ACTIVITY LOG ==============

// GET /api/management/activity
router.get('/activity', authMiddleware, requirePermission('activity.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock activity
  if (isDemoMode()) {
    const demoActivity = getDemoActivityLog();
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const sliced = demoActivity.slice(offset, offset + limit);
    res.json({
      entries: sliced,
      total: demoActivity.length,
      limit,
      offset,
    });
    return;
  }

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
router.delete('/activity', authMiddleware, requirePermission('activity.clear'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate clear
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Activity log cleared (simulated)' });
    return;
  }

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

// ============== MOD STORE ==============

// GET /api/management/modstore
router.get('/modstore', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return demo mod store
  if (isDemoMode()) {
    res.json({ mods: getDemoModStore() });
    return;
  }

  try {
    const mods = await getAvailableMods();
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get mod store' });
  }
});

// GET /api/management/modstore/:modId/release
router.get('/modstore/:modId/release', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { modId } = req.params;
    const mods = await getAvailableMods();
    const mod = mods.find((m) => m.id === modId);

    if (!mod) {
      res.status(404).json({ error: 'Mod not found' });
      return;
    }

    // Check if mod has GitHub source
    if (!mod.github) {
      // For direct download mods, return version from registry
      res.json({
        version: mod.version || 'unknown',
        name: mod.name,
        publishedAt: null,
        assets: [],
        source: 'direct',
      });
      return;
    }

    const release = await getLatestRelease(mod.github);
    if (!release) {
      res.status(500).json({ error: 'Failed to fetch release info' });
      return;
    }

    res.json({
      version: release.tag_name,
      name: release.name,
      publishedAt: release.published_at,
      assets: release.assets.map((a) => ({
        name: a.name,
        size: a.size,
      })),
      source: 'github',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get release info' });
  }
});

// POST /api/management/modstore/:modId/install
router.post('/modstore/:modId/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    const { modId } = req.params;
    res.json({ success: true, filename: `${modId}.jar`, version: '1.0.0', message: '[DEMO] Mod installed (simulated)' });
    return;
  }

  try {
    const { modId } = req.params;
    const result = await installMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'install_mod',
        'mod',
        true,
        result.filename,
        `Installed ${modId} v${result.version} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to install mod' });
  }
});

// DELETE /api/management/modstore/:modId/uninstall
router.delete('/modstore/:modId/uninstall', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    const { modId } = req.params;
    res.json({ success: true, modId, message: '[DEMO] Mod uninstalled (simulated)' });
    return;
  }

  try {
    const { modId } = req.params;
    const result = await uninstallMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'uninstall_mod',
        'mod',
        true,
        modId,
        `Uninstalled ${modId} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

// POST /api/management/modstore/:modId/update
router.post('/modstore/:modId/update', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate update
  if (isDemoMode()) {
    const { modId } = req.params;
    res.json({ success: true, filename: `${modId}.jar`, version: '1.1.0', message: '[DEMO] Mod updated (simulated)' });
    return;
  }

  try {
    const { modId } = req.params;
    const result = await updateMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'update_mod',
        'mod',
        true,
        result.filename,
        `Updated ${modId} to ${result.version} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update mod' });
  }
});

// POST /api/management/modstore/refresh - Refresh the external mod registry
router.post('/modstore/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    refreshRegistry();
    const mods = await getAvailableMods();
    res.json({ success: true, modCount: mods.length, registry: getRegistryInfo() });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to refresh registry' });
  }
});

// GET /api/management/modstore/info - Get registry info
router.get('/modstore/info', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    res.json(getRegistryInfo());
  } catch (error) {
    res.status(500).json({ error: 'Failed to get registry info' });
  }
});

// ==================== WORLD CONFIG ====================

// Interface for world config
interface WorldConfig {
  name: string;
  displayName?: string;
  seed?: number;
  isTicking?: boolean;
  isBlockTicking?: boolean;
  isPvpEnabled?: boolean;
  isFallDamageEnabled?: boolean;
  isGameTimePaused?: boolean;
  gameTime?: string;
  isSpawningNPC?: boolean;
  isAllNPCFrozen?: boolean;
  isSpawnMarkersEnabled?: boolean;
  isObjectiveMarkersEnabled?: boolean;
  isSavingPlayers?: boolean;
  isSavingChunks?: boolean;
  saveNewChunks?: boolean;
  isUnloadingChunks?: boolean;
  isCompassUpdating?: boolean;
  gameplayConfig?: string;
  deleteOnUniverseStart?: boolean;
  deleteOnRemove?: boolean;
  daytimeDurationSecondsOverride?: number;
  nighttimeDurationSecondsOverride?: number;
  clientEffects?: {
    sunHeightPercent?: number;
    sunAngleDegrees?: number;
    bloomIntensity?: number;
    bloomPower?: number;
    sunIntensity?: number;
    sunshaftIntensity?: number;
    sunshaftScaleFactor?: number;
  };
}

// Note: /worlds route is defined earlier in this file with improved world scanning

// GET /api/management/worlds/:worldName/config - Get world config
router.get('/worlds/:worldName/config', authMiddleware, requirePermission('worlds.view'), async (req: Request, res: Response) => {
  try {
    const { worldName } = req.params;

    // Security: validate world name
    if (!worldName || worldName.includes('..') || worldName.includes('/') || worldName.includes('\\')) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }

    // Try multiple possible paths for world config
    const possiblePaths = getWorldsPaths().map(wp => path.join(wp, worldName, 'config.json'));
    let configPath: string | null = null;
    let content: string | null = null;

    for (const tryPath of possiblePaths) {
      try {
        content = await readFile(tryPath, 'utf-8');
        configPath = tryPath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!configPath || !content) {
      res.status(404).json({ error: 'World config not found' });
      return;
    }
    const worldConfig = JSON.parse(content);

    // Return normalized config
    res.json({
      name: worldName,
      raw: worldConfig,
      // Normalized fields for easy editing
      displayName: worldConfig.DisplayName || worldName,
      seed: worldConfig.Seed,
      isTicking: worldConfig.IsTicking ?? true,
      isBlockTicking: worldConfig.IsBlockTicking ?? true,
      isPvpEnabled: worldConfig.IsPvpEnabled ?? false,
      isFallDamageEnabled: worldConfig.IsFallDamageEnabled ?? true,
      isGameTimePaused: worldConfig.IsGameTimePaused ?? false,
      gameTime: worldConfig.GameTime,
      isSpawningNPC: worldConfig.IsSpawningNPC ?? true,
      isAllNPCFrozen: worldConfig.IsAllNPCFrozen ?? false,
      isSpawnMarkersEnabled: worldConfig.IsSpawnMarkersEnabled ?? true,
      isObjectiveMarkersEnabled: worldConfig.IsObjectiveMarkersEnabled ?? true,
      isSavingPlayers: worldConfig.IsSavingPlayers ?? true,
      isSavingChunks: worldConfig.IsSavingChunks ?? true,
      saveNewChunks: worldConfig.SaveNewChunks ?? true,
      isUnloadingChunks: worldConfig.IsUnloadingChunks ?? true,
      isCompassUpdating: worldConfig.IsCompassUpdating ?? true,
      gameplayConfig: worldConfig.GameplayConfig ?? 'Default',
      deleteOnUniverseStart: worldConfig.DeleteOnUniverseStart ?? false,
      deleteOnRemove: worldConfig.DeleteOnRemove ?? false,
      daytimeDurationSecondsOverride: worldConfig.DaytimeDurationSecondsOverride,
      nighttimeDurationSecondsOverride: worldConfig.NighttimeDurationSecondsOverride,
      clientEffects: worldConfig.ClientEffects ? {
        sunHeightPercent: worldConfig.ClientEffects.SunHeightPercent,
        sunAngleDegrees: worldConfig.ClientEffects.SunAngleDegrees,
        bloomIntensity: worldConfig.ClientEffects.BloomIntensity,
        bloomPower: worldConfig.ClientEffects.BloomPower,
        sunIntensity: worldConfig.ClientEffects.SunIntensity,
        sunshaftIntensity: worldConfig.ClientEffects.SunshaftIntensity,
        sunshaftScaleFactor: worldConfig.ClientEffects.SunshaftScaleFactor,
      } : undefined,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'World config not found' });
    } else {
      res.status(500).json({ error: 'Failed to read world config' });
    }
  }
});

// PUT /api/management/worlds/:worldName/config - Update world config
router.put('/worlds/:worldName/config', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { worldName } = req.params;
    const updates = req.body;

    // Security: validate world name
    if (!worldName || worldName.includes('..') || worldName.includes('/') || worldName.includes('\\')) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }

    // Try multiple possible paths for world config
    const possiblePaths = getWorldsPaths().map(wp => path.join(wp, worldName, 'config.json'));
    let configPath: string | null = null;
    let content: string | null = null;

    for (const tryPath of possiblePaths) {
      try {
        content = await readFile(tryPath, 'utf-8');
        configPath = tryPath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!configPath || !content) {
      res.status(404).json({ error: 'World config not found' });
      return;
    }

    // Read existing config
    const worldConfig = JSON.parse(content);

    // Apply updates (map camelCase to PascalCase)
    if (updates.displayName !== undefined) worldConfig.DisplayName = updates.displayName;
    if (updates.isTicking !== undefined) worldConfig.IsTicking = updates.isTicking;
    if (updates.isBlockTicking !== undefined) worldConfig.IsBlockTicking = updates.isBlockTicking;
    if (updates.isPvpEnabled !== undefined) worldConfig.IsPvpEnabled = updates.isPvpEnabled;
    if (updates.isFallDamageEnabled !== undefined) worldConfig.IsFallDamageEnabled = updates.isFallDamageEnabled;
    if (updates.isGameTimePaused !== undefined) worldConfig.IsGameTimePaused = updates.isGameTimePaused;
    if (updates.isSpawningNPC !== undefined) worldConfig.IsSpawningNPC = updates.isSpawningNPC;
    if (updates.isAllNPCFrozen !== undefined) worldConfig.IsAllNPCFrozen = updates.isAllNPCFrozen;
    if (updates.isSpawnMarkersEnabled !== undefined) worldConfig.IsSpawnMarkersEnabled = updates.isSpawnMarkersEnabled;
    if (updates.isObjectiveMarkersEnabled !== undefined) worldConfig.IsObjectiveMarkersEnabled = updates.isObjectiveMarkersEnabled;
    if (updates.isSavingPlayers !== undefined) worldConfig.IsSavingPlayers = updates.isSavingPlayers;
    if (updates.isSavingChunks !== undefined) worldConfig.IsSavingChunks = updates.isSavingChunks;
    if (updates.saveNewChunks !== undefined) worldConfig.SaveNewChunks = updates.saveNewChunks;
    if (updates.isUnloadingChunks !== undefined) worldConfig.IsUnloadingChunks = updates.isUnloadingChunks;
    if (updates.isCompassUpdating !== undefined) worldConfig.IsCompassUpdating = updates.isCompassUpdating;
    if (updates.gameplayConfig !== undefined) worldConfig.GameplayConfig = updates.gameplayConfig;
    if (updates.deleteOnUniverseStart !== undefined) worldConfig.DeleteOnUniverseStart = updates.deleteOnUniverseStart;
    if (updates.deleteOnRemove !== undefined) worldConfig.DeleteOnRemove = updates.deleteOnRemove;

    // Day/Night duration overrides
    if (updates.daytimeDurationSecondsOverride !== undefined) {
      if (updates.daytimeDurationSecondsOverride === null || updates.daytimeDurationSecondsOverride === '') {
        delete worldConfig.DaytimeDurationSecondsOverride;
      } else {
        worldConfig.DaytimeDurationSecondsOverride = Number(updates.daytimeDurationSecondsOverride);
      }
    }
    if (updates.nighttimeDurationSecondsOverride !== undefined) {
      if (updates.nighttimeDurationSecondsOverride === null || updates.nighttimeDurationSecondsOverride === '') {
        delete worldConfig.NighttimeDurationSecondsOverride;
      } else {
        worldConfig.NighttimeDurationSecondsOverride = Number(updates.nighttimeDurationSecondsOverride);
      }
    }

    // Client effects
    if (updates.clientEffects) {
      if (!worldConfig.ClientEffects) worldConfig.ClientEffects = {};
      if (updates.clientEffects.sunHeightPercent !== undefined)
        worldConfig.ClientEffects.SunHeightPercent = Number(updates.clientEffects.sunHeightPercent);
      if (updates.clientEffects.sunAngleDegrees !== undefined)
        worldConfig.ClientEffects.SunAngleDegrees = Number(updates.clientEffects.sunAngleDegrees);
      if (updates.clientEffects.bloomIntensity !== undefined)
        worldConfig.ClientEffects.BloomIntensity = Number(updates.clientEffects.bloomIntensity);
      if (updates.clientEffects.bloomPower !== undefined)
        worldConfig.ClientEffects.BloomPower = Number(updates.clientEffects.bloomPower);
      if (updates.clientEffects.sunIntensity !== undefined)
        worldConfig.ClientEffects.SunIntensity = Number(updates.clientEffects.sunIntensity);
      if (updates.clientEffects.sunshaftIntensity !== undefined)
        worldConfig.ClientEffects.SunshaftIntensity = Number(updates.clientEffects.sunshaftIntensity);
      if (updates.clientEffects.sunshaftScaleFactor !== undefined)
        worldConfig.ClientEffects.SunshaftScaleFactor = Number(updates.clientEffects.sunshaftScaleFactor);
    }

    // Write updated config
    await writeFile(configPath, JSON.stringify(worldConfig, null, 2), 'utf-8');

    // Log activity
    await logActivity(
      req.user || 'unknown',
      'update_world_config',
      'config',
      true,
      worldName,
      `Updated world config for ${worldName}`
    );

    res.json({ success: true, message: 'World config updated' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'World config not found' });
    } else {
      res.status(500).json({ error: 'Failed to update world config' });
    }
  }
});

// GET /api/management/worlds/:worldName/files/:filePath - Read any JSON file in a world
router.get('/worlds/:worldName/files/*', authMiddleware, requirePermission('worlds.view'), async (req: Request, res: Response) => {
  try {
    const { worldName } = req.params;
    const filePath = req.params[0]; // The wildcard part (e.g., "resources/Time.json")

    // Security: validate world name
    if (!worldName || worldName.includes('..') || worldName.includes('\\')) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }

    // Security: validate file path
    if (!filePath || filePath.includes('..') || !filePath.endsWith('.json')) {
      res.status(400).json({ error: 'Invalid file path. Only .json files are allowed.' });
      return;
    }

    // Only allow files in root or resources folder
    const pathParts = filePath.split('/');
    if (pathParts.length > 2 || (pathParts.length === 2 && pathParts[0] !== 'resources')) {
      res.status(400).json({ error: 'Invalid file path. Only root and resources/ folder allowed.' });
      return;
    }

    // Try multiple possible paths for the file
    const possiblePaths = getWorldsPaths().map(wp => path.join(wp, worldName, filePath));
    let content: string | null = null;

    for (const tryPath of possiblePaths) {
      try {
        content = await readFile(tryPath, 'utf-8');
        break;
      } catch {
        // Try next path
      }
    }

    if (!content) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Parse and return as JSON
    const data = JSON.parse(content);
    res.json({
      worldName,
      filePath,
      fileName: pathParts[pathParts.length - 1],
      content: data,
      raw: content,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
    } else if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid JSON file' });
    } else {
      res.status(500).json({ error: 'Failed to read file' });
    }
  }
});

// PUT /api/management/worlds/:worldName/files/:filePath - Update any JSON file in a world
router.put('/worlds/:worldName/files/*', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { worldName } = req.params;
    const filePath = req.params[0];
    const { content } = req.body;

    // Security: validate world name
    if (!worldName || worldName.includes('..') || worldName.includes('\\')) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }

    // Security: validate file path
    if (!filePath || filePath.includes('..') || !filePath.endsWith('.json')) {
      res.status(400).json({ error: 'Invalid file path. Only .json files are allowed.' });
      return;
    }

    // Only allow files in root or resources folder
    const pathParts = filePath.split('/');
    if (pathParts.length > 2 || (pathParts.length === 2 && pathParts[0] !== 'resources')) {
      res.status(400).json({ error: 'Invalid file path. Only root and resources/ folder allowed.' });
      return;
    }

    if (content === undefined) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    // Validate JSON
    let jsonContent: string;
    if (typeof content === 'string') {
      // Validate it's valid JSON
      JSON.parse(content);
      jsonContent = content;
    } else {
      // Convert object to JSON string
      jsonContent = JSON.stringify(content, null, 2);
    }

    // Try multiple possible paths for the file
    const possiblePaths = getWorldsPaths().map(wp => path.join(wp, worldName, filePath));
    let targetPath: string | null = null;

    // Find existing file
    for (const tryPath of possiblePaths) {
      try {
        await stat(tryPath);
        targetPath = tryPath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!targetPath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Write file
    await writeFile(targetPath, jsonContent, 'utf-8');

    // Log activity
    const fileName = pathParts[pathParts.length - 1];
    await logActivity(
      req.user || 'unknown',
      'update_world_file',
      'config',
      true,
      `${worldName}/${filePath}`,
      `Updated ${fileName} in world ${worldName}`
    );

    res.json({ success: true, message: `File ${fileName} updated` });
  } catch (error) {
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid JSON content' });
    } else {
      res.status(500).json({ error: 'Failed to update file' });
    }
  }
});

// ============== MODTALE INTEGRATION ==============

// GET /api/management/modtale/status - Check Modtale API status
router.get('/modtale/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return online status
  if (isDemoMode()) {
    res.json({ available: true, latency: 120, demo: true });
    return;
  }

  try {
    const status = await checkModtaleStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check Modtale status' });
  }
});

// GET /api/management/modtale/search - Search mods on Modtale
router.get('/modtale/search', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return demo results
  if (isDemoMode()) {
    res.json(getDemoModtaleResults());
    return;
  }

  try {
    const {
      search,
      page,
      size,
      sort,
      classification,
      tags,
      gameVersion,
      author,
    } = req.query;

    const result = await modtaleSearch({
      search: search as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      size: size ? parseInt(size as string, 10) : undefined,
      sort: sort as ModtaleSortOption | undefined,
      classification: classification as ModtaleClassification | undefined,
      tags: tags ? (tags as string).split(',') : undefined,
      gameVersion: gameVersion as string | undefined,
      author: author as string | undefined,
    });

    if (!result) {
      res.status(503).json({ error: 'Modtale API unavailable' });
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to search Modtale' });
  }
});

// GET /api/management/modtale/projects/:projectId - Get project details
router.get('/modtale/projects/:projectId', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    // Security: Validate projectId format
    if (!isValidProjectId(projectId)) {
      res.status(400).json({ error: 'Invalid project ID format' });
      return;
    }

    const project = await modtaleGetDetails(projectId);

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json(project);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get project details' });
  }
});

// POST /api/management/modtale/install - Install mod from Modtale
router.post('/modtale/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    const { projectId } = req.body;
    res.json({ success: true, projectId, filename: `${projectId}.jar`, message: '[DEMO] Mod installed from Modtale (simulated)' });
    return;
  }

  try {
    const { projectId, versionId } = req.body;

    if (!projectId) {
      res.status(400).json({ error: 'projectId required' });
      return;
    }

    // Security: Validate projectId format
    if (!isValidProjectId(projectId)) {
      res.status(400).json({ error: 'Invalid project ID format' });
      return;
    }

    // Security: Validate versionId format if provided
    if (versionId && !isValidVersion(versionId)) {
      res.status(400).json({ error: 'Invalid version ID format' });
      return;
    }

    const result = await installModFromModtale(projectId, versionId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'install_mod',
        'mod',
        true,
        result.filename,
        `Installed ${result.projectTitle} v${result.version} from Modtale`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to install mod from Modtale' });
  }
});

// GET /api/management/modtale/featured - Get featured/popular mods
router.get('/modtale/featured', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const mods = await getFeaturedMods(limit);
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get featured mods' });
  }
});

// GET /api/management/modtale/recent - Get recently updated mods
router.get('/modtale/recent', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const mods = await getRecentMods(limit);
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get recent mods' });
  }
});

// GET /api/management/modtale/tags - Get available tags
router.get('/modtale/tags', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const tags = await modtaleGetTags();
    res.json({ tags });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tags' });
  }
});

// GET /api/management/modtale/classifications - Get available classifications
router.get('/modtale/classifications', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const classifications = await modtaleGetClassifications();
    res.json({ classifications });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get classifications' });
  }
});

// GET /api/management/modtale/game-versions - Get supported game versions
router.get('/modtale/game-versions', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const gameVersions = await modtaleGetGameVersions();
    res.json({ gameVersions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get game versions' });
  }
});

// POST /api/management/modtale/refresh - Clear Modtale cache
router.post('/modtale/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    clearModtaleCache();
    res.json({ success: true, message: 'Modtale cache cleared' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to refresh cache' });
  }
});

// GET /api/management/modtale/installed - Get installed Modtale mods
router.get('/modtale/installed', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const installed = await getInstalledModtaleInfo();
    res.json({ installed });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get installed mods' });
  }
});

// DELETE /api/management/modtale/uninstall/:projectId - Uninstall a Modtale mod
router.delete('/modtale/uninstall/:projectId', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    const { projectId } = req.params;
    res.json({ success: true, projectId, message: '[DEMO] Modtale mod uninstalled (simulated)' });
    return;
  }

  try {
    const { projectId } = req.params;

    if (!projectId || !isValidProjectId(projectId)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    const result = await uninstallModtale(projectId);

    if (result.success) {
      // Log the uninstall activity
      await logActivity(
        req.user || 'Admin',
        'uninstall_modtale',
        'mod',
        true,
        projectId,
        `Uninstalled Modtale mod: ${projectId}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('Modtale uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

// ============== STACKMART INTEGRATION ==============

// GET /api/management/stackmart/status - Check StackMart API status
router.get('/stackmart/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return online status
  if (isDemoMode()) {
    res.json({ available: true, latency: 95, demo: true });
    return;
  }

  try {
    const status = await checkStackMartStatus();
    res.json(status);
  } catch {
    res.status(500).json({ error: 'Failed to check StackMart status' });
  }
});

// GET /api/management/stackmart/search - Search resources on StackMart
router.get('/stackmart/search', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return demo results
  if (isDemoMode()) {
    res.json(getDemoStackMartResults());
    return;
  }

  try {
    const {
      search,
      page = '1',
      limit = '20',
      sort = 'popular',
      category,
      subcategory,
    } = req.query;

    const result = await stackmartSearch({
      search: search as string | undefined,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      sort: sort as StackMartSortOption | undefined,
      category: category as StackMartCategory | undefined,
      subcategory: subcategory as string | undefined,
    });

    if (!result) {
      res.status(503).json({ error: 'StackMart API unavailable' });
      return;
    }

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to search StackMart' });
  }
});

// GET /api/management/stackmart/resources/:resourceId - Get resource details
router.get('/stackmart/resources/:resourceId', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { resourceId } = req.params;

    if (!isValidResourceId(resourceId)) {
      res.status(400).json({ error: 'Invalid resource ID format' });
      return;
    }

    const result = await stackmartGetDetails(resourceId);
    if (!result) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to get resource details' });
  }
});

// POST /api/management/stackmart/install - Install resource from StackMart
router.post('/stackmart/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    const { resourceId } = req.body;
    res.json({ success: true, resourceId, resourceName: 'Demo Resource', version: '1.0.0', message: '[DEMO] Resource installed from StackMart (simulated)' });
    return;
  }

  try {
    const { resourceId } = req.body;

    if (!resourceId || !isValidResourceId(resourceId)) {
      res.status(400).json({ success: false, error: 'Invalid resource ID' });
      return;
    }

    const result = await installResourceFromStackMart(resourceId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'install_stackmart',
        'mod',
        true,
        result.resourceName || resourceId,
        `Installed ${result.resourceName} v${result.version} from StackMart`
      );
    }

    res.json(result);
  } catch {
    res.status(500).json({ success: false, error: 'Failed to install resource from StackMart' });
  }
});

// GET /api/management/stackmart/popular - Get popular resources
router.get('/stackmart/popular', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const resources = await getPopularResources(limit);
    res.json({ resources });
  } catch {
    res.status(500).json({ error: 'Failed to get popular resources' });
  }
});

// GET /api/management/stackmart/recent - Get recent resources
router.get('/stackmart/recent', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const resources = await getRecentResources(limit);
    res.json({ resources });
  } catch {
    res.status(500).json({ error: 'Failed to get recent resources' });
  }
});

// GET /api/management/stackmart/categories - Get available categories
router.get('/stackmart/categories', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const categories = await stackmartGetCategories();
    res.json({ categories });
  } catch {
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

// POST /api/management/stackmart/refresh - Clear StackMart cache
router.post('/stackmart/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    clearStackMartCache();
    res.json({ success: true, message: 'StackMart cache cleared' });
  } catch {
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// GET /api/management/stackmart/installed - Get installed StackMart resources
router.get('/stackmart/installed', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const installed = await getInstalledStackMartInfo();
    res.json({ installed });
  } catch {
    res.status(500).json({ error: 'Failed to get installed resources' });
  }
});

// DELETE /api/management/stackmart/uninstall/:resourceId - Uninstall a StackMart resource
router.delete('/stackmart/uninstall/:resourceId', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    const { resourceId } = req.params;
    res.json({ success: true, resourceId, message: '[DEMO] StackMart resource uninstalled (simulated)' });
    return;
  }

  try {
    const { resourceId } = req.params;

    if (!isValidResourceId(resourceId)) {
      res.status(400).json({ success: false, error: 'Invalid resource ID format' });
      return;
    }

    const result = await uninstallStackMart(resourceId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'uninstall_stackmart',
        'mod',
        true,
        resourceId,
        `Uninstalled StackMart resource: ${resourceId}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('StackMart uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall resource' });
  }
});

// ============================================
// CurseForge Integration Endpoints
// ============================================

// GET /api/management/curseforge/status - Check CurseForge API status
router.get('/curseforge/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return simulated status
  if (isDemoMode()) {
    res.json({
      configured: true,
      hasApiKey: true,
      apiAvailable: true,
      gameId: 432,
      demo: true,
    });
    return;
  }

  const status = await checkCurseForgeStatus();
  res.json(status);
});

// GET /api/management/curseforge/search - Search mods on CurseForge
router.get('/curseforge/search', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock search results
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 238222,
          name: 'JEI (Just Enough Items)',
          slug: 'jei',
          summary: 'View items and recipes',
          downloadCount: 150000000,
          authors: [{ id: 1, name: 'mezz', url: '' }],
          logo: { thumbnailUrl: 'https://via.placeholder.com/64' },
          dateModified: new Date().toISOString(),
          latestFiles: [],
        },
      ],
      pagination: { index: 0, pageSize: 20, resultCount: 1, totalCount: 1 },
      demo: true,
    });
    return;
  }

  try {
    const {
      search,
      gameId,
      classId,
      categoryId,
      gameVersion,
      sortField = 'Popularity',
      sortOrder = 'desc',
      pageSize = '20',
      index = '0',
    } = req.query;

    const result = await curseforgeSearch({
      search: search as string | undefined,
      gameId: gameId ? parseInt(gameId as string, 10) : undefined,
      classId: classId ? parseInt(classId as string, 10) : undefined,
      categoryId: categoryId ? parseInt(categoryId as string, 10) : undefined,
      gameVersion: gameVersion as string | undefined,
      sortField: sortField as CurseForgeSortField,
      sortOrder: sortOrder as CurseForgeSortOrder,
      pageSize: parseInt(pageSize as string, 10),
      index: parseInt(index as string, 10),
    });

    if (result) {
      res.json(result);
    } else {
      res.status(503).json({ error: 'CurseForge API unavailable' });
    }
  } catch (error) {
    console.error('CurseForge search error:', error);
    res.status(500).json({ error: 'Failed to search CurseForge' });
  }
});

// GET /api/management/curseforge/mods/:modId - Get mod details
router.get('/curseforge/mods/:modId', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock mod details
  if (isDemoMode()) {
    res.json({
      id: parseInt(req.params.modId, 10),
      name: 'Demo Mod',
      slug: 'demo-mod',
      summary: 'A demo mod for testing',
      downloadCount: 10000,
      authors: [{ id: 1, name: 'DemoAuthor', url: '' }],
      latestFiles: [
        {
          id: 1234567,
          displayName: 'demo-mod-1.0.0.jar',
          fileName: 'demo-mod-1.0.0.jar',
          releaseType: 1,
          gameVersions: ['1.20.1'],
          downloadUrl: null,
        },
      ],
      demo: true,
    });
    return;
  }

  try {
    const modId = parseInt(req.params.modId, 10);

    if (!isValidCurseForgeModId(modId)) {
      res.status(400).json({ error: 'Invalid mod ID format' });
      return;
    }

    const mod = await curseforgeGetDetails(modId);

    if (mod) {
      res.json(mod);
    } else {
      res.status(404).json({ error: 'Mod not found' });
    }
  } catch (error) {
    console.error('CurseForge mod details error:', error);
    res.status(500).json({ error: 'Failed to get mod details' });
  }
});

// GET /api/management/curseforge/mods/:modId/files - Get mod files
router.get('/curseforge/mods/:modId/files', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock files
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 1234567,
          displayName: 'demo-mod-1.0.0.jar',
          fileName: 'demo-mod-1.0.0.jar',
          releaseType: 1,
          gameVersions: ['1.20.1'],
          fileDate: new Date().toISOString(),
          downloadCount: 5000,
          downloadUrl: null,
        },
      ],
      demo: true,
    });
    return;
  }

  try {
    const modId = parseInt(req.params.modId, 10);
    const { gameVersion, pageSize = '50', index = '0' } = req.query;

    if (!isValidCurseForgeModId(modId)) {
      res.status(400).json({ error: 'Invalid mod ID format' });
      return;
    }

    const files = await curseforgeGetFiles(modId, {
      gameVersion: gameVersion as string | undefined,
      pageSize: parseInt(pageSize as string, 10),
      index: parseInt(index as string, 10),
    });

    if (files) {
      res.json({ data: files });
    } else {
      res.status(404).json({ error: 'Files not found' });
    }
  } catch (error) {
    console.error('CurseForge files error:', error);
    res.status(500).json({ error: 'Failed to get mod files' });
  }
});

// POST /api/management/curseforge/install - Install mod from CurseForge
router.post('/curseforge/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    const { modId, fileId } = req.body;
    res.json({
      success: true,
      modId,
      fileId,
      filename: 'demo-mod-1.0.0.jar',
      version: 'demo-mod-1.0.0',
      modName: 'Demo Mod',
      message: '[DEMO] CurseForge mod installed (simulated)',
    });
    return;
  }

  try {
    const { modId, fileId } = req.body;

    if (!modId || !isValidCurseForgeModId(modId)) {
      res.status(400).json({ success: false, error: 'Invalid mod ID' });
      return;
    }

    const result = await installModFromCurseForge(modId, fileId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'install_curseforge',
        'mod',
        true,
        result.modName || modId.toString(),
        `Installed ${result.modName} (${result.version}) from CurseForge`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CurseForge install error:', error);
    res.status(500).json({ success: false, error: 'Failed to install mod' });
  }
});

// POST /api/management/curseforge/update - Update mod to latest version
router.post('/curseforge/update', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate update
  if (isDemoMode()) {
    const { modId, fileId } = req.body;
    res.json({
      success: true,
      modId,
      fileId,
      filename: 'demo-mod-1.1.0.jar',
      version: 'demo-mod-1.1.0',
      modName: 'Demo Mod',
      message: '[DEMO] CurseForge mod updated (simulated)',
    });
    return;
  }

  try {
    const { modId, fileId } = req.body;

    if (!modId || !isValidCurseForgeModId(modId)) {
      res.status(400).json({ success: false, error: 'Invalid mod ID' });
      return;
    }

    const result = await curseforgeUpdateMod(modId, fileId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'update_curseforge',
        'mod',
        true,
        result.modName || modId.toString(),
        `Updated ${result.modName} to ${result.version} from CurseForge`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CurseForge update error:', error);
    res.status(500).json({ success: false, error: 'Failed to update mod' });
  }
});

// GET /api/management/curseforge/updates - Check for updates for installed mods
router.get('/curseforge/updates', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock updates
  if (isDemoMode()) {
    res.json({
      updates: [
        {
          modId: 238222,
          modName: 'JEI (Just Enough Items)',
          currentFileId: 1234566,
          currentVersion: 'jei-1.20.1-15.2.0.26',
          latestFileId: 1234567,
          latestVersion: 'jei-1.20.1-15.2.0.27',
          releaseType: 1,
          hasUpdate: true,
        },
      ],
      demo: true,
    });
    return;
  }

  try {
    const updates = await curseforgeCheckUpdates();
    res.json({ updates });
  } catch (error) {
    console.error('CurseForge updates check error:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// GET /api/management/curseforge/featured - Get featured mods
router.get('/curseforge/featured', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock featured mods
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 238222,
          name: 'JEI (Just Enough Items)',
          summary: 'View items and recipes',
          downloadCount: 150000000,
        },
      ],
      demo: true,
    });
    return;
  }

  const limit = parseInt(req.query.limit as string, 10) || 10;
  const mods = await curseforgeFeatured(limit);
  res.json({ data: mods });
});

// GET /api/management/curseforge/recent - Get recently updated mods
router.get('/curseforge/recent', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock recent mods
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 238223,
          name: 'Recent Mod',
          summary: 'A recently updated mod',
          downloadCount: 5000000,
        },
      ],
      demo: true,
    });
    return;
  }

  const limit = parseInt(req.query.limit as string, 10) || 10;
  const mods = await curseforgeRecent(limit);
  res.json({ data: mods });
});

// GET /api/management/curseforge/popular - Get popular mods
router.get('/curseforge/popular', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock popular mods
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 238224,
          name: 'Popular Mod',
          summary: 'A very popular mod',
          downloadCount: 200000000,
        },
      ],
      demo: true,
    });
    return;
  }

  const limit = parseInt(req.query.limit as string, 10) || 10;
  const mods = await curseforgePopular(limit);
  res.json({ data: mods });
});

// GET /api/management/curseforge/categories - Get available categories
router.get('/curseforge/categories', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock categories
  if (isDemoMode()) {
    res.json({
      data: [
        { id: 6, name: 'Mods', slug: 'mc-mods' },
        { id: 12, name: 'Resource Packs', slug: 'texture-packs' },
        { id: 17, name: 'Modpacks', slug: 'modpacks' },
      ],
      demo: true,
    });
    return;
  }

  const gameId = req.query.gameId ? parseInt(req.query.gameId as string, 10) : undefined;
  const categories = await curseforgeGetCategories(gameId);
  res.json({ data: categories || [] });
});

// POST /api/management/curseforge/refresh - Clear CurseForge cache
router.post('/curseforge/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  clearCurseForgeCache();
  res.json({ success: true, message: 'CurseForge cache cleared' });
});

// GET /api/management/curseforge/installed - Get installed CurseForge mods
router.get('/curseforge/installed', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock installed mods
  if (isDemoMode()) {
    res.json({
      mods: {
        '238222': {
          modId: 238222,
          modName: 'JEI (Just Enough Items)',
          fileId: 1234566,
          version: 'jei-1.20.1-15.2.0.26',
          filename: 'jei-1.20.1-15.2.0.26.jar',
          installedAt: new Date().toISOString(),
          releaseType: 1,
          gameVersions: ['1.20.1'],
        },
      },
      demo: true,
    });
    return;
  }

  const mods = await getInstalledCurseForgeInfo();
  res.json({ mods });
});

// DELETE /api/management/curseforge/uninstall/:modId - Uninstall a CurseForge mod
router.delete('/curseforge/uninstall/:modId', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    const { modId } = req.params;
    res.json({ success: true, modId, message: '[DEMO] CurseForge mod uninstalled (simulated)' });
    return;
  }

  try {
    const modId = parseInt(req.params.modId, 10);

    if (!isValidCurseForgeModId(modId)) {
      res.status(400).json({ success: false, error: 'Invalid mod ID format' });
      return;
    }

    const result = await uninstallCurseForge(modId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'uninstall_curseforge',
        'mod',
        true,
        modId.toString(),
        `Uninstalled CurseForge mod: ${modId}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CurseForge uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

// ============================================
// CFWidget Integration Endpoints (Free API - No Key Required)
// Used for mod update checking via CurseForge slugs
// ============================================

// GET /api/management/modupdates/status - Get current update status (cached)
router.get('/modupdates/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock status
  if (isDemoMode()) {
    res.json({
      totalTracked: 3,
      updatesAvailable: 1,
      lastChecked: new Date().toISOString(),
      mods: [
        {
          filename: 'KyuubiSoftAchievements-1.0.0.jar',
          curseforgeSlug: 'kyuubisoft-achievements-titles-rewards',
          installedVersion: '1.0.0',
          latestVersion: 'KyuubiSoft Achievements 1.0.1',
          hasUpdate: true,
          lastChecked: new Date().toISOString(),
          projectTitle: 'KyuubiSoft Achievements',
        },
      ],
      demo: true,
    });
    return;
  }

  try {
    // Use unified status that includes ALL sources (CFWidget, Modtale, StackMart, ModStore)
    const status = await getUnifiedUpdateStatus();
    res.json(status);
  } catch (error) {
    console.error('Mod updates status error:', error);
    res.status(500).json({ error: 'Failed to get update status' });
  }
});

// POST /api/management/modupdates/check - Check all mods for updates (runs full check)
router.post('/modupdates/check', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock check result
  if (isDemoMode()) {
    res.json({
      totalTracked: 3,
      updatesAvailable: 1,
      lastChecked: new Date().toISOString(),
      mods: [],
      demo: true,
    });
    return;
  }

  try {
    const status = await cfwidgetCheckAll();
    res.json(status);
  } catch (error) {
    console.error('Mod updates check error:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// POST /api/management/modupdates/track - Track a mod for updates
router.post('/modupdates/track', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate tracking
  if (isDemoMode()) {
    const { filename, curseforgeUrl } = req.body;
    res.json({
      success: true,
      mod: {
        filename,
        curseforgeSlug: 'demo-mod',
        hasUpdate: false,
        lastChecked: new Date().toISOString(),
      },
      message: '[DEMO] Mod tracking added (simulated)',
    });
    return;
  }

  try {
    const { filename, curseforgeInput, currentVersion } = req.body;

    // Only curseforgeInput is required - filename can be empty for wishlist items
    if (!curseforgeInput) {
      res.status(400).json({ success: false, error: 'Missing curseforgeInput' });
      return;
    }

    const result = await cfwidgetTrackMod(filename || '', curseforgeInput, currentVersion);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'track_mod_updates',
        'mod',
        true,
        filename,
        `Started tracking updates for ${filename}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('Track mod error:', error);
    res.status(500).json({ success: false, error: 'Failed to track mod' });
  }
});

// DELETE /api/management/modupdates/track/:filename - Stop tracking a mod
router.delete('/modupdates/track/:filename', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate untracking
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Mod tracking removed (simulated)' });
    return;
  }

  try {
    const { filename } = req.params;
    const success = await cfwidgetUntrackMod(decodeURIComponent(filename));

    if (success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'untrack_mod_updates',
        'mod',
        true,
        filename,
        `Stopped tracking updates for ${filename}`
      );
    }

    res.json({ success });
  } catch (error) {
    console.error('Untrack mod error:', error);
    res.status(500).json({ success: false, error: 'Failed to untrack mod' });
  }
});

// GET /api/management/modupdates/check/:filename - Check single mod for update
router.get('/modupdates/check/:filename', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock result
  if (isDemoMode()) {
    res.json({
      filename: req.params.filename,
      hasUpdate: false,
      lastChecked: new Date().toISOString(),
      demo: true,
    });
    return;
  }

  try {
    const { filename } = req.params;
    const mod = await cfwidgetCheckMod(decodeURIComponent(filename));

    if (mod) {
      res.json(mod);
    } else {
      res.status(404).json({ error: 'Mod not tracked' });
    }
  } catch (error) {
    console.error('Check mod update error:', error);
    res.status(500).json({ error: 'Failed to check mod update' });
  }
});

// GET /api/management/modupdates/lookup - Lookup mod info by CurseForge URL/slug
router.get('/modupdates/lookup', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock lookup
  if (isDemoMode()) {
    res.json({
      id: 1445274,
      title: 'Demo Mod',
      summary: 'A demo mod for testing',
      thumbnail: 'https://via.placeholder.com/64',
      download: {
        name: 'demo-mod-1.0.0.jar',
        display: 'Demo Mod 1.0.0',
      },
      demo: true,
    });
    return;
  }

  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    const slug = extractSlugFromUrl(url);

    if (!slug) {
      res.status(400).json({ error: 'Invalid CurseForge URL or slug' });
      return;
    }

    const modInfo = await cfwidgetGetMod(slug);

    if (modInfo) {
      res.json(modInfo);
    } else {
      res.status(404).json({ error: 'Mod not found' });
    }
  } catch (error) {
    console.error('Lookup mod error:', error);
    res.status(500).json({ error: 'Failed to lookup mod' });
  }
});

// POST /api/management/modupdates/refresh - Clear CFWidget cache
router.post('/modupdates/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  clearCFWidgetCache();
  res.json({ success: true, message: 'CFWidget cache cleared' });
});

// PUT /api/management/modupdates/version/:filename - Update installed version for a tracked mod
router.put('/modupdates/version/:filename', authMiddleware, requirePermission('mods.install'), async (req: Request, res: Response) => {
  // Demo mode: simulate version update
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Version updated (simulated)' });
    return;
  }

  try {
    const { filename } = req.params;
    const { version, fileId } = req.body;

    if (!version) {
      res.status(400).json({ success: false, error: 'Missing version' });
      return;
    }

    const success = await cfwidgetUpdateVersion(decodeURIComponent(filename), version, fileId);
    res.json({ success });
  } catch (error) {
    console.error('Update version error:', error);
    res.status(500).json({ success: false, error: 'Failed to update version' });
  }
});

// POST /api/management/modupdates/install/:filename - Install or update a tracked mod
router.post('/modupdates/install/:filename', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Mod installed (simulated)', filename: 'demo-mod.jar' });
    return;
  }

  try {
    const { filename } = req.params;
    const decodedFilename = decodeURIComponent(filename);

    const result = await cfwidgetInstallMod(decodedFilename);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'install_mod_cfwidget',
        'mod',
        true,
        result.filename || decodedFilename,
        `Installed ${result.modName} v${result.version}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CFWidget install error:', error);
    res.status(500).json({ success: false, error: 'Failed to install mod' });
  }
});

// DELETE /api/management/modupdates/uninstall/:filename - Uninstall a tracked mod (delete file and untrack)
router.delete('/modupdates/uninstall/:filename', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Mod uninstalled (simulated)' });
    return;
  }

  try {
    const { filename } = req.params;
    const decodedFilename = decodeURIComponent(filename);

    const result = await cfwidgetUninstallMod(decodedFilename);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'uninstall_mod_cfwidget',
        'mod',
        true,
        decodedFilename,
        `Uninstalled mod`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CFWidget uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

// Helper function to log activity from other routes
export { logActivity };

export default router;
