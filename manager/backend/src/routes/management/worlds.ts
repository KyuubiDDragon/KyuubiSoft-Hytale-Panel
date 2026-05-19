// World-listing endpoints: scans server universe + data dirs and returns
// available worlds (and their editable JSON files).
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { isDemoMode, getDemoWorlds } from '../../services/demoData.js';
import {
  WorldInfo,
  getWorldsPaths,
  scanWorldsInPath,
} from '../../services/managementHelpers.js';

const router = Router();

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

export default router;
