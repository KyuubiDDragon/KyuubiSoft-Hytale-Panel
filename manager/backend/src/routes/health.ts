/**
 *   GET /api/health              — public liveness probe
 *   GET /api/health/permissions  — settings.view and access to every server:
 *                                  can the panel read and write the compose
 *                                  server's folders?
 *
 * The permission check names host and container folders of the compose
 * server, so it is not public, and an account limited to some servers does
 * not get it either (it is not bound to one of them). It only asks the file
 * system (access(2)) instead of writing test files into the folders on every
 * call.
 */
import { Router, Response } from 'express';
import { access, constants } from 'fs/promises';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAllServerAccess, requirePermission } from '../middleware/permissions.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'hytale-manager' });
});

// Used to warn users about permission issues after upgrading to non-root container
interface PermissionCheckResult {
  path: string;
  name: string;
  readable: boolean;
  writable: boolean;
  error?: string;
}

interface PermissionHealthResponse {
  ok: boolean;
  issues: PermissionCheckResult[];
  message?: string;
}

async function checkFolder(dirPath: string, name: string): Promise<PermissionCheckResult> {
  const result: PermissionCheckResult = { path: dirPath, name, readable: false, writable: false };
  try {
    await access(dirPath, constants.R_OK);
    result.readable = true;
  } catch (err) {
    result.error = `Cannot access: ${err instanceof Error ? err.message : 'Unknown error'}`;
    return result;
  }
  try {
    // W_OK also reports a read-only mount (EROFS).
    await access(dirPath, constants.W_OK);
    result.writable = true;
  } catch (err) {
    result.error = `Cannot write: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
  return result;
}

router.get(
  '/permissions',
  authMiddleware,
  requirePermission('settings.view'),
  requireAllServerAccess(),
  asyncRoute(async (_req: AuthenticatedRequest, res: Response) => {
    const pathsToCheck = [
      { path: config.serverPath, name: 'Server' },
      { path: config.backupsPath, name: 'Backups' },
      { path: config.dataPath, name: 'Data' },
      { path: config.modsPath, name: 'Mods' },
      { path: config.pluginsPath, name: 'Plugins' },
    ];

    const results: PermissionCheckResult[] = [];
    for (const { path: dirPath, name } of pathsToCheck) {
      results.push(await checkFolder(dirPath, name));
    }
    const issues = results.filter((r) => !r.readable || !r.writable);

    const response: PermissionHealthResponse = { ok: issues.length === 0, issues };
    if (issues.length > 0) {
      response.message = `Some directories have permission issues. This may happen after upgrading to v2.0.0 which runs as non-root. Run: sudo chown -R 9999:9999 ${config.hostDataPath}`;
    }

    res.json(response);
  }),
);

export default router;
