// Server "directory" listings and lifecycle: whitelist / bans / permissions for
// player management directories, plus the on-disk mods & plugins directories
// (listing, upload, delete, toggle, stats history). These endpoints all operate
// on directories or list-backed JSON files on the Hytale server.
import { Router, Request, Response } from 'express';
import { readFile, writeFile, unlink } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import { logActivity, getActivityLog, clearActivityLog, type ActivityLogEntry } from '../../services/activityLog.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { isPathSafe, sanitizeFileName } from '../../utils/pathSecurity.js';
import {
  isDemoMode,
  getDemoMods,
  getDemoPlugins,
  getDemoActivityLog,
  getDemoWhitelist,
  getDemoBans,
  getDemoPermissions,
} from '../../services/demoData.js';
import {
  verifyFileMagic,
  uploadMod,
  uploadPlugin,
  scanDirectory,
  statsHistory,
} from '../../services/managementHelpers.js';
import { getModRegistry, checkModUpdate } from '../../services/modStore.js';
import {
  getInstalledModtaleInfo,
  untrackInstalledMod as modtaleUntrack,
} from '../../services/modtale.js';
import {
  getInstalledStackMartInfo,
  untrackInstalledResource as stackmartUntrack,
} from '../../services/stackmart.js';
import {
  getInstalledCurseForgeInfo,
  untrackInstalledMod as curseforgeUntrack,
} from '../../services/curseforge.js';
import {
  untrackMod as cfwidgetUntrackMod,
  getUpdateStatus as cfwidgetStatus,
} from '../../services/cfwidget.js';
import { getUnifiedUpdateStatus } from '../../services/unifiedUpdates.js';

const router = Router();

// Helper function to clean up all source tracking when a mod is deleted.
// Lives here because it composes services with no other consumers.
async function cleanupModTracking(filename: string): Promise<void> {
  try {
    // 1. Check and remove from CFWidget
    const cfwidgetData = await cfwidgetStatus();
    const cfwidgetMod = cfwidgetData.mods.find((m: { filename: string }) => m.filename === filename);
    if (cfwidgetMod) {
      await cfwidgetUntrackMod(filename);
      console.log(`[Cleanup] Removed ${filename} from CFWidget tracking`);
    }

    // 2. Check and remove from Modtale
    const modtaleInstalled = await getInstalledModtaleInfo();
    for (const [projectId, info] of Object.entries(modtaleInstalled)) {
      if (info.filename === filename) {
        await modtaleUntrack(projectId);
        console.log(`[Cleanup] Removed ${filename} from Modtale tracking (project: ${projectId})`);
        break;
      }
    }

    // 3. Check and remove from StackMart
    const stackmartInstalled = await getInstalledStackMartInfo();
    for (const [resourceId, info] of Object.entries(stackmartInstalled)) {
      if (info.filename === filename) {
        await stackmartUntrack(resourceId);
        console.log(`[Cleanup] Removed ${filename} from StackMart tracking (resource: ${resourceId})`);
        break;
      }
    }

    // 4. Check and remove from CurseForge API
    const curseforgeInstalled = await getInstalledCurseForgeInfo();
    for (const [modIdStr, info] of Object.entries(curseforgeInstalled)) {
      if (info.filename === filename) {
        await curseforgeUntrack(parseInt(modIdStr));
        console.log(`[Cleanup] Removed ${filename} from CurseForge tracking (mod: ${modIdStr})`);
        break;
      }
    }
  } catch (error) {
    console.error(`[Cleanup] Error cleaning up tracking for ${filename}:`, error);
    // Don't throw - deletion should still succeed even if cleanup fails
  }
}

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
    const { execCommand } = await import('../../services/docker.js');

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
    const { execCommand, getStatus } = await import('../../services/docker.js');

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

// ============== MODS & PLUGINS ==============

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

// GET /api/management/mods/all-updates - Get update status from ALL sources (Modtale, StackMart, CurseForge, ModStore)
router.get('/mods/all-updates', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock status
  if (isDemoMode()) {
    res.json({
      totalTracked: 0,
      updatesAvailable: 0,
      lastChecked: new Date().toISOString(),
      mods: [],
      demo: true,
    });
    return;
  }

  try {
    const status = await getUnifiedUpdateStatus();
    res.json(status);
  } catch (error) {
    console.error('All mods update status error:', error);
    res.status(500).json({ error: 'Failed to get update status' });
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

    // Clean up tracking from all sources (Modtale, StackMart, CurseForge, CFWidget)
    await cleanupModTracking(safeFilename);

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

    // Clean up tracking from all sources (Modtale, StackMart, CurseForge, CFWidget)
    await cleanupModTracking(safeFilename);

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

export default router;
