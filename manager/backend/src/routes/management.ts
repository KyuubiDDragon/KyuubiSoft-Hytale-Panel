import { Router, Request, Response } from 'express';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';

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

interface BanEntry {
  player: string;
  reason?: string;
  bannedAt: string;
  bannedBy?: string;
}

async function getBansPath(): Promise<string> {
  return path.join(config.serverPath, 'bans.json');
}

async function readBans(): Promise<BanEntry[]> {
  try {
    const content = await readFile(await getBansPath(), 'utf-8');
    const data = JSON.parse(content);
    // Handle both array format and object format
    if (Array.isArray(data)) {
      return data;
    }
    return [];
  } catch {
    return [];
  }
}

async function writeBans(data: BanEntry[]): Promise<void> {
  await writeFile(await getBansPath(), JSON.stringify(data, null, 2), 'utf-8');
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

// POST /api/management/bans/add
router.post('/bans/add', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { player, reason } = req.body;
    if (!player || typeof player !== 'string') {
      res.status(400).json({ error: 'player name required' });
      return;
    }
    const bans = await readBans();
    const existing = bans.find(b => b.player === player);
    if (!existing) {
      bans.push({
        player,
        reason: reason || undefined,
        bannedAt: new Date().toISOString(),
        bannedBy: 'Admin',
      });
      await writeBans(bans);
    }
    res.json({ success: true, bans });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add ban' });
  }
});

// DELETE /api/management/bans/:player
router.delete('/bans/:player', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { player } = req.params;
    let bans = await readBans();
    bans = bans.filter(b => b.player !== player);
    await writeBans(bans);
    res.json({ success: true, bans });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove ban' });
  }
});

// ============== PERMISSIONS ==============

interface Permission {
  name: string;
  description?: string;
}

interface PermissionGroup {
  name: string;
  permissions: string[];
  inherits?: string[];
}

interface PermissionUser {
  name: string;
  groups: string[];
}

interface PermissionsData {
  users: PermissionUser[];
  groups: PermissionGroup[];
  availablePermissions?: Permission[];
}

async function getPermissionsPath(): Promise<string> {
  return path.join(config.serverPath, 'permissions.json');
}

async function readPermissions(): Promise<PermissionsData> {
  try {
    const content = await readFile(await getPermissionsPath(), 'utf-8');
    const data = JSON.parse(content);
    return {
      users: data.users || [],
      groups: data.groups || [],
      availablePermissions: data.availablePermissions || [],
    };
  } catch {
    return { users: [], groups: [], availablePermissions: [] };
  }
}

async function writePermissions(data: PermissionsData): Promise<void> {
  await writeFile(await getPermissionsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// GET /api/management/permissions
router.get('/permissions', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const data = await readPermissions();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read permissions' });
  }
});

// POST /api/management/permissions/users
router.post('/permissions/users', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, groups } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const data = await readPermissions();
    const existingIndex = data.users.findIndex(u => u.name === name);
    if (existingIndex >= 0) {
      data.users[existingIndex].groups = groups || [];
    } else {
      data.users.push({ name, groups: groups || [] });
    }
    await writePermissions(data);
    res.json({ success: true, users: data.users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user permissions' });
  }
});

// DELETE /api/management/permissions/users/:name
router.delete('/permissions/users/:name', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const data = await readPermissions();
    data.users = data.users.filter(u => u.name !== name);
    await writePermissions(data);
    res.json({ success: true, users: data.users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove user' });
  }
});

// POST /api/management/permissions/groups
router.post('/permissions/groups', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, permissions, inherits } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const data = await readPermissions();
    const existingIndex = data.groups.findIndex(g => g.name === name);
    if (existingIndex >= 0) {
      data.groups[existingIndex].permissions = permissions || [];
      data.groups[existingIndex].inherits = inherits;
    } else {
      data.groups.push({ name, permissions: permissions || [], inherits });
    }
    await writePermissions(data);
    res.json({ success: true, groups: data.groups });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// DELETE /api/management/permissions/groups/:name
router.delete('/permissions/groups/:name', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const data = await readPermissions();
    data.groups = data.groups.filter(g => g.name !== name);
    await writePermissions(data);
    res.json({ success: true, groups: data.groups });
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

async function getWorldsPath(): Promise<string> {
  return path.join(config.serverPath, 'worlds');
}

// GET /api/management/worlds
router.get('/worlds', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const worldsPath = await getWorldsPath();
    let worlds: WorldInfo[] = [];

    try {
      const entries = await readdir(worldsPath);

      for (const entry of entries) {
        const entryPath = path.join(worldsPath, entry);
        try {
          const stats = await stat(entryPath);
          if (stats.isDirectory()) {
            // Calculate directory size (simplified - just count files)
            let size = 0;
            try {
              const files = await readdir(entryPath);
              for (const file of files) {
                const fileStat = await stat(path.join(entryPath, file));
                size += fileStat.size;
              }
            } catch {
              // Ignore
            }

            worlds.push({
              name: entry,
              path: entryPath,
              size,
              lastModified: stats.mtime.toISOString(),
            });
          }
        } catch {
          // Skip entries that can't be read
        }
      }
    } catch {
      // worlds directory doesn't exist
    }

    res.json({ worlds });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read worlds' });
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

export default router;
