// Hytale server sign-in (`/auth login device`) of the request's server.
//
// Mounted as /api/server/hytale-auth/* (legacy, default server) and
// /api/servers/:serverId/server/hytale-auth/* through the server router, and
// kept as /api/auth/hytale/* for older clients (default server).
import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { requireServerFiles } from '../middleware/serverScope.js';
import {
  initiateDeviceLogin,
  checkAuthCompletion,
  getAuthStatus,
  resetAuth,
  setPersistence,
  listAuthFiles,
  inspectDownloaderCredentials,
} from '../services/hytaleAuth.js';
import { isDemoMode } from '../services/demoData.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Every route reads or writes the server's folders.
const hytaleAuthManage = [
  authMiddleware,
  requirePermission('hytale_auth.manage'),
  requireServerFiles,
];

// GET /hytale-auth/status - Get Hytale authentication status
router.get('/status', ...hytaleAuthManage, async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: return authenticated status
  if (isDemoMode()) {
    res.json({
      authenticated: true,
      username: 'demo@kyuubisoft.com',
      persistence: 'Memory',
      lastAuth: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      demo: true,
    });
    return;
  }

  try {
    // Always verify auth status by checking for token files
    const result = await checkAuthCompletion(req.serverId);
    const status = await getAuthStatus(req.serverId);
    res.json({
      ...status,
      authenticated: result.success || status.authenticated,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get auth status' });
  }
});

// POST /hytale-auth/initiate - Initiate Hytale device login
router.post('/initiate', ...hytaleAuthManage, async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate device login initiation
  if (isDemoMode()) {
    res.json({
      success: true,
      message: '[DEMO] Device login initiated (simulated)',
      deviceCode: 'DEMO-1234-5678',
      // Field name aligned with the real hytaleAuth service (verificationUrl)
      // and the frontend api/auth.ts expectation. Demo response uses the
      // same field so /ServerAuth.vue and Dashboard.vue see consistent
      // shape between demo + real auth.
      verificationUrl: 'https://hypixel.net/activate',
      expiresIn: 300,
      demo: true,
    });
    return;
  }

  try {
    const result = await initiateDeviceLogin(req.serverId);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to initiate login',
    });
  }
});

// POST /hytale-auth/check - Check if authentication is complete
router.post('/check', ...hytaleAuthManage, async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: return authenticated
  if (isDemoMode()) {
    res.json({ success: true, authenticated: true, demo: true });
    return;
  }

  try {
    const result = await checkAuthCompletion(req.serverId);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to check auth status',
    });
  }
});

// POST /hytale-auth/reset - Reset Hytale authentication
router.post('/reset', ...hytaleAuthManage, async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate reset
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Auth reset (simulated)', demo: true });
    return;
  }

  try {
    const result = await resetAuth(req.serverId);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset auth',
    });
  }
});

// POST /hytale-auth/persistence - Set authentication persistence type
router.post(
  '/persistence',
  ...hytaleAuthManage,
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: simulate persistence change
    if (isDemoMode()) {
      const { type } = req.body;
      res.json({
        success: true,
        message: `[DEMO] Persistence set to ${type} (simulated)`,
        demo: true,
      });
      return;
    }

    try {
      const { type } = req.body;
      if (!type || !['Memory', 'Encrypted'].includes(type)) {
        res.status(400).json({
          success: false,
          error: 'Invalid persistence type. Must be "Memory" or "Encrypted"',
        });
        return;
      }

      const result = await setPersistence(type, req.serverId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set persistence',
      });
    }
  },
);

// GET /hytale-auth/files - List files in auth directory (debug)
router.get('/files', ...hytaleAuthManage, async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: return simulated file list
  if (isDemoMode()) {
    res.json({ files: ['credentials.json', 'token.json'], demo: true });
    return;
  }

  try {
    const files = await listAuthFiles(req.serverId);
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list auth files' });
  }
});

// GET /hytale-auth/inspect-credentials - Inspect downloader credentials structure (debug)
router.get(
  '/inspect-credentials',
  ...hytaleAuthManage,
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: return simulated credentials info
    if (isDemoMode()) {
      res.json({
        success: true,
        hasCredentials: true,
        structure: { username: 'demo@kyuubisoft.com' },
        demo: true,
      });
      return;
    }

    try {
      const result = await inspectDownloaderCredentials(req.serverId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Failed to inspect credentials' });
    }
  },
);

export default router;
