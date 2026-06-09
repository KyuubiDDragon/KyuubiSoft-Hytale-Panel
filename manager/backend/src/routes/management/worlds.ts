// World endpoints: listing (scans universe + data dirs), plus per-world
// management — backup / restore / upload / delete, seed + size details, and
// chunk pre-generation.
import { Router, Request, Response } from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs';
import multer from 'multer';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { isDemoMode, getDemoWorlds } from '../../services/demoData.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import {
  WorldInfo,
  getWorldsPaths,
  scanWorldsInPath,
} from '../../services/managementHelpers.js';
import {
  getWorldDetails,
  backupWorld,
  listWorldBackups,
  restoreWorld,
  deleteWorldBackup,
  importWorldArchive,
  startPregen,
  getPregenStatus,
  cancelPregen,
} from '../../services/worldManager.js';

const router = Router();

// World archive uploads can be large (multi-GB). Write to a temp file on disk
// (not memory) with a generous cap; importWorldArchive extracts + deletes it.
const WORLD_UPLOAD_MAX = 4 * 1024 * 1024 * 1024; // 4 GB
const worldUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(os.tmpdir(), 'kp-world-uploads');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^A-Za-z0-9_.-]/g, '_')}`),
  }),
  limits: { fileSize: WORLD_UPLOAD_MAX },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(zip|tar\.gz|tgz)$/i.test(file.originalname);
    cb(null, ok);
  },
});

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
    const worlds: WorldInfo[] = [];
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

// GET /api/management/worlds/backups - list per-world backups
router.get('/worlds/backups', authMiddleware, requirePermission('worlds.view'), async (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) {
    res.json({ backups: [{ id: 'world_Spawn_20260601-120000.tar.gz', world: 'Spawn', createdAt: new Date(Date.now() - 3600_000).toISOString(), sizeBytes: 52428800 }] });
    return;
  }
  res.json({ backups: await listWorldBackups(req.serverId) });
});

// GET /api/management/worlds/pregen/status - chunk pre-generation status
router.get('/worlds/pregen/status', authMiddleware, requirePermission('worlds.view'), (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) {
    res.json({ state: 'idle', world: null, radius: null, percent: 0, chunksDone: null, chunksTotal: null, startedAt: null });
    return;
  }
  res.json(getPregenStatus(req.serverId));
});

// GET /api/management/worlds/:name/details - seed + size for one world
router.get('/worlds/:name/details', authMiddleware, requirePermission('worlds.view'), async (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) {
    res.json({ name: req.params.name, path: `/opt/hytale/worlds/${req.params.name}`, seed: '1234567890', sizeBytes: 104857600, fileCount: 128 });
    return;
  }
  const details = await getWorldDetails(req.params.name, req.serverId);
  if (!details) { res.status(404).json({ error: 'World not found' }); return; }
  res.json(details);
});

// POST /api/management/worlds/:name/backup - back up a single world
router.post('/worlds/:name/backup', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) { res.json({ success: true, message: '[DEMO] World backed up (simulated)' }); return; }
  const result = await backupWorld(req.params.name, req.serverId);
  res.status(result.success ? 200 : 400).json(result);
});

// POST /api/management/worlds/restore - restore a per-world backup
router.post('/worlds/restore', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) { res.json({ success: true, message: '[DEMO] World restored (simulated)' }); return; }
  const { backupId } = req.body as { backupId?: string };
  if (!backupId) { res.status(400).json({ success: false, error: 'backupId required' }); return; }
  const result = await restoreWorld(backupId, req.serverId);
  res.status(result.success ? 200 : 400).json(result);
});

// DELETE /api/management/worlds/backups/:id - delete a per-world backup
router.delete('/worlds/backups/:id', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) { res.json({ success: true }); return; }
  const result = await deleteWorldBackup(req.params.id, req.serverId);
  res.status(result.success ? 200 : 400).json(result);
});

// POST /api/management/worlds/upload - import a world archive (.zip/.tar.gz/.tgz)
router.post('/worlds/upload', authMiddleware, requirePermission('worlds.manage'), worldUpload.single('archive'), async (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) { res.json({ success: true, message: '[DEMO] World imported (simulated)' }); return; }
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) { res.status(400).json({ success: false, error: 'No archive uploaded (.zip, .tar.gz or .tgz)' }); return; }
  const result = await importWorldArchive(file.path, file.originalname, req.serverId);
  res.status(result.success ? 200 : 400).json(result);
});

// POST /api/management/worlds/:name/pregen - start chunk pre-generation
router.post('/worlds/:name/pregen', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) { res.json({ success: true, message: '[DEMO] Pre-generation started (simulated)' }); return; }
  const radius = Number((req.body as { radius?: number }).radius);
  const result = await startPregen(req.params.name, radius, req.serverId);
  res.status(result.success ? 200 : 400).json(result);
});

// POST /api/management/worlds/pregen/cancel - cancel pre-generation
router.post('/worlds/pregen/cancel', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  if (isDemoMode()) { res.json({ success: true }); return; }
  const result = await cancelPregen(req.serverId);
  res.status(result.success ? 200 : 400).json(result);
});

export default router;
