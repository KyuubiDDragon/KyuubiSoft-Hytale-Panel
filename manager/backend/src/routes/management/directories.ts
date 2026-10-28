// Server "directory" listings and lifecycle: the on-disk mods & plugins
// directories (listing, upload, delete, toggle, stats history) and the
// activity log. Whitelist, bans and permissions are in ./access.ts.
import { Router, Request, Response } from 'express';
import { unlink } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import {
  logActivity,
  getActivityLog,
  clearActivityLog,
  type ActivityLogEntry,
} from '../../services/activityLog.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { isPathSafe, sanitizeFileName } from '../../utils/pathSecurity.js';
import {
  isDemoMode,
  getDemoMods,
  getDemoPlugins,
  getDemoActivityLog,
} from '../../services/demoData.js';
import {
  verifyFileMagic,
  uploadMod,
  uploadPlugin,
  scanDirectory,
  statsHistory,
  onServer,
} from '../../services/managementHelpers.js';
import { getServerContext, type ServerContext } from '../../services/serverContext.js';
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
async function cleanupModTracking(server: ServerContext, filename: string): Promise<void> {
  try {
    // 1. Check and remove from CFWidget
    const cfwidgetData = await cfwidgetStatus(server);
    const cfwidgetMod = cfwidgetData.mods.find(
      (m: { filename: string }) => m.filename === filename,
    );
    if (cfwidgetMod) {
      await cfwidgetUntrackMod(server, filename);
      console.log(`[Cleanup] Removed ${filename} from CFWidget tracking`);
    }

    // 2. Check and remove from Modtale
    const modtaleInstalled = await getInstalledModtaleInfo(server);
    for (const [projectId, info] of Object.entries(modtaleInstalled)) {
      if (info.filename === filename) {
        await modtaleUntrack(server, projectId);
        console.log(`[Cleanup] Removed ${filename} from Modtale tracking (project: ${projectId})`);
        break;
      }
    }

    // 3. Check and remove from StackMart
    const stackmartInstalled = await getInstalledStackMartInfo(server);
    for (const [resourceId, info] of Object.entries(stackmartInstalled)) {
      if (info.filename === filename) {
        await stackmartUntrack(server, resourceId);
        console.log(
          `[Cleanup] Removed ${filename} from StackMart tracking (resource: ${resourceId})`,
        );
        break;
      }
    }

    // 4. Check and remove from CurseForge API
    const curseforgeInstalled = await getInstalledCurseForgeInfo(server);
    for (const [modIdStr, info] of Object.entries(curseforgeInstalled)) {
      if (info.filename === filename) {
        await curseforgeUntrack(server, parseInt(modIdStr));
        console.log(`[Cleanup] Removed ${filename} from CurseForge tracking (mod: ${modIdStr})`);
        break;
      }
    }
  } catch (error) {
    console.error(`[Cleanup] Error cleaning up tracking for ${filename}:`, error);
    // Don't throw - deletion should still succeed even if cleanup fails
  }
}

// Whitelist, bans and permissions live in ./access.ts.

// ============== MODS & PLUGINS ==============

// GET /api/management/mods
router.get(
  '/mods',
  authMiddleware,
  requirePermission('mods.view'),
  async (req: Request, res: Response) => {
    // Demo mode: return mock mods
    if (isDemoMode()) {
      const demoMods = getDemoMods();
      res.json({
        mods: demoMods.map((m) => ({
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
      const server = await getServerContext(req.serverId);
      const mods = await scanDirectory(server.paths.mods, 'mod');

      // Get mod registry to check for updates
      const registry = await getModRegistry();

      // Enrich mods with update info from registry
      const enrichedMods = await Promise.all(
        mods.map(async (mod) => {
          // Try to match mod to registry entry by filename
          const modNameLower = mod.name.toLowerCase();
          const registryEntry = registry.find(
            (entry) =>
              modNameLower.includes(entry.id.toLowerCase()) ||
              modNameLower.includes(entry.name.toLowerCase()),
          );

          if (registryEntry) {
            try {
              const updateInfo = await checkModUpdate(server, registryEntry.id);
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
        }),
      );

      res.json({ mods: enrichedMods, path: server.paths.mods });
    } catch (error) {
      res.status(500).json({ error: 'Failed to read mods' });
    }
  },
);

// GET /api/management/mods/all-updates - Get update status from ALL sources (Modtale, StackMart, CurseForge, ModStore)
router.get(
  '/mods/all-updates',
  authMiddleware,
  requirePermission('mods.view'),
  async (req: Request, res: Response) => {
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
      const status = await getUnifiedUpdateStatus(await getServerContext(req.serverId));
      res.json(status);
    } catch (error) {
      console.error('All mods update status error:', error);
      res.status(500).json({ error: 'Failed to get update status' });
    }
  },
);

// GET /api/management/plugins
router.get(
  '/plugins',
  authMiddleware,
  requirePermission('plugins.view'),
  async (req: Request, res: Response) => {
    // Demo mode: return mock plugins
    if (isDemoMode()) {
      const demoPlugins = getDemoPlugins();
      res.json({
        plugins: demoPlugins.map((p) => ({
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
      const { paths } = await getServerContext(req.serverId);
      const plugins = await scanDirectory(paths.plugins, 'plugin');
      res.json({ plugins, path: paths.plugins });
    } catch (error) {
      res.status(500).json({ error: 'Failed to read plugins' });
    }
  },
);

// PUT /api/management/mods/:filename/toggle
router.put(
  '/mods/:filename/toggle',
  authMiddleware,
  requirePermission('mods.install'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { filename } = req.params;

      // SECURITY: Validate filename to prevent path traversal
      const safeFilename = sanitizeFileName(filename);
      if (!safeFilename) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      const username = req.user || 'system';
      const { paths } = await getServerContext(req.serverId);
      const filePath = path.join(paths.mods, safeFilename);

      // SECURITY: Verify path is within mods directory
      if (!isPathSafe(filePath, [paths.mods])) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      const isCurrentlyDisabled = safeFilename.endsWith('.disabled');
      const disabledPath = isCurrentlyDisabled ? filePath.slice(0, -9) : filePath + '.disabled';

      const { rename } = await import('fs/promises');

      if (isCurrentlyDisabled) {
        await rename(filePath, disabledPath);
        await logActivity(
          username,
          'enable_mod',
          'mod',
          true,
          safeFilename.replace('.disabled', ''),
          onServer(req.serverId).trim() || undefined,
        );
      } else {
        await rename(filePath, disabledPath);
        await logActivity(
          username,
          'disable_mod',
          'mod',
          true,
          safeFilename,
          onServer(req.serverId).trim() || undefined,
        );
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to toggle mod' });
    }
  },
);

// PUT /api/management/plugins/:filename/toggle
router.put(
  '/plugins/:filename/toggle',
  authMiddleware,
  requirePermission('plugins.install'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { filename } = req.params;

      // SECURITY: Validate filename to prevent path traversal
      const safeFilename = sanitizeFileName(filename);
      if (!safeFilename) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      const username = req.user || 'system';
      const { paths } = await getServerContext(req.serverId);
      const filePath = path.join(paths.plugins, safeFilename);

      // SECURITY: Verify path is within plugins directory
      if (!isPathSafe(filePath, [paths.plugins])) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      const isCurrentlyDisabled = safeFilename.endsWith('.disabled');
      const disabledPath = isCurrentlyDisabled ? filePath.slice(0, -9) : filePath + '.disabled';

      const { rename } = await import('fs/promises');

      if (isCurrentlyDisabled) {
        await rename(filePath, disabledPath);
        await logActivity(
          username,
          'enable_plugin',
          'mod',
          true,
          safeFilename.replace('.disabled', ''),
          onServer(req.serverId).trim() || undefined,
        );
      } else {
        await rename(filePath, disabledPath);
        await logActivity(
          username,
          'disable_plugin',
          'mod',
          true,
          safeFilename,
          onServer(req.serverId).trim() || undefined,
        );
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to toggle plugin' });
    }
  },
);

// ============== PERFORMANCE STATS HISTORY ==============

// GET /api/management/stats/history
router.get(
  '/stats/history',
  authMiddleware,
  requirePermission('performance.view'),
  async (_req: Request, res: Response) => {
    res.json({ history: statsHistory });
  },
);

// ============== FILE UPLOAD FOR MODS & PLUGINS ==============

// POST /api/management/mods/upload
router.post(
  '/mods/upload',
  authMiddleware,
  requirePermission('mods.install'),
  uploadMod.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const expectedType: 'zip' | 'lua' | 'js' =
        ext === '.jar' || ext === '.zip' ? 'zip' : ext === '.lua' ? 'lua' : 'js';

      // SECURITY: Verify file magic bytes match expected type
      if (!verifyFileMagic(req.file.path, expectedType)) {
        // Delete the uploaded file
        await unlink(req.file.path).catch(() => {});
        console.warn(
          `[SECURITY] Blocked upload with invalid magic bytes: ${req.file.originalname}`,
        );
        res
          .status(400)
          .json({ error: 'Invalid file content. File does not match expected format.' });
        return;
      }

      await logActivity(
        req.user || 'unknown',
        'upload_mod',
        'mod',
        true,
        req.file.originalname,
        `Uploaded mod: ${req.file.filename} (original: ${req.file.originalname}, ${(req.file.size / 1024 / 1024).toFixed(2)} MB)${onServer(req.serverId)}`,
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
  },
);

// POST /api/management/plugins/upload
router.post(
  '/plugins/upload',
  authMiddleware,
  requirePermission('plugins.install'),
  uploadPlugin.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const expectedType: 'zip' | 'lua' | 'js' =
        ext === '.jar' || ext === '.zip' ? 'zip' : ext === '.lua' ? 'lua' : 'js';

      // SECURITY: Verify file magic bytes match expected type
      if (!verifyFileMagic(req.file.path, expectedType)) {
        // Delete the uploaded file
        await unlink(req.file.path).catch(() => {});
        console.warn(
          `[SECURITY] Blocked upload with invalid magic bytes: ${req.file.originalname}`,
        );
        res
          .status(400)
          .json({ error: 'Invalid file content. File does not match expected format.' });
        return;
      }

      await logActivity(
        req.user || 'unknown',
        'upload_plugin',
        'mod',
        true,
        req.file.originalname,
        `Uploaded plugin: ${req.file.filename} (original: ${req.file.originalname}, ${(req.file.size / 1024 / 1024).toFixed(2)} MB)${onServer(req.serverId)}`,
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
  },
);

// DELETE /api/management/mods/:filename
router.delete(
  '/mods/:filename',
  authMiddleware,
  requirePermission('mods.delete'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { filename } = req.params;

      // SECURITY: Validate filename to prevent path traversal
      const safeFilename = sanitizeFileName(filename);
      if (!safeFilename) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      const server = await getServerContext(req.serverId);
      const filePath = path.join(server.paths.mods, safeFilename);

      // SECURITY: Verify path is within mods directory
      if (!isPathSafe(filePath, [server.paths.mods])) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      await unlink(filePath);

      // Clean up tracking from all sources (Modtale, StackMart, CurseForge, CFWidget)
      await cleanupModTracking(server, safeFilename);

      await logActivity(
        req.user || 'unknown',
        'delete_mod',
        'mod',
        true,
        safeFilename,
        `Deleted mod: ${safeFilename}${onServer(server.id)}`,
      );

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete mod' });
    }
  },
);

// DELETE /api/management/plugins/:filename
router.delete(
  '/plugins/:filename',
  authMiddleware,
  requirePermission('plugins.delete'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { filename } = req.params;

      // SECURITY: Validate filename to prevent path traversal
      const safeFilename = sanitizeFileName(filename);
      if (!safeFilename) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }

      const server = await getServerContext(req.serverId);
      const filePath = path.join(server.paths.plugins, safeFilename);

      // SECURITY: Verify path is within plugins directory
      if (!isPathSafe(filePath, [server.paths.plugins])) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      await unlink(filePath);

      // Clean up tracking from all sources (Modtale, StackMart, CurseForge, CFWidget)
      await cleanupModTracking(server, safeFilename);

      await logActivity(
        req.user || 'unknown',
        'delete_plugin',
        'mod',
        true,
        safeFilename,
        `Deleted plugin: ${safeFilename}${onServer(server.id)}`,
      );

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete plugin' });
    }
  },
);

// ============== ACTIVITY LOG ==============

// GET /api/management/activity
router.get(
  '/activity',
  authMiddleware,
  requirePermission('activity.view'),
  async (req: Request, res: Response) => {
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
  },
);

// DELETE /api/management/activity
router.delete(
  '/activity',
  authMiddleware,
  requirePermission('activity.clear'),
  async (req: AuthenticatedRequest, res: Response) => {
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
        'Cleared activity log',
      );

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clear activity log' });
    }
  },
);

export default router;
