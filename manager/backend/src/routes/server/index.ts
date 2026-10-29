// Aggregate router for /api/server. Mounts the demo endpoint (open, no auth)
// and the lifecycle / config / updates / auth / panel submodules.
//
// All endpoint URLs are preserved exactly as they were on the previous monolithic
// routes/server.ts — submodules are mounted on '/' so paths stay identical.
import { Router, Request, Response } from 'express';
import { isDemoMode } from '../../services/demoData.js';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { getPerfHistory } from '../../services/perfHistory.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { asyncRoute } from '../../utils/asyncRoute.js';

import lifecycleRoutes from './lifecycle.js';
import configRoutes from './config.js';
import serverConfigRoutes from './serverConfig.js';
import updatesRoutes from './updates.js';
import authRoutes from './auth.js';
import panelRoutes from './panel.js';
import crashesRoutes from './crashes.js';
import pluginLiveRoutes from './pluginLive.js';
import hytaleAuthRoutes from '../hytaleAuth.js';

const router = Router();

// GET /api/server/demo - Check if demo mode is enabled (no auth required for login page)
router.get('/demo', (_req: Request, res: Response) => {
  res.json({
    demoMode: isDemoMode(),
    message: isDemoMode() ? 'Panel is running in demo mode. All data is simulated.' : undefined,
  });
});

// GET /api/server/perf-history - TPS/MSPT/CPU/memory time-series of the
// request's server (scoped mount) or the default server, for charts
router.get(
  '/perf-history',
  authMiddleware,
  requirePermission('performance.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await getPerfHistory(req.serverId));
  }),
);

// Mount submodules at root so all original /api/server/* paths still resolve
router.use('/', lifecycleRoutes);
router.use('/', configRoutes);
router.use('/', serverConfigRoutes);
router.use('/', updatesRoutes);
router.use('/', authRoutes);
router.use('/', panelRoutes);
router.use('/', crashesRoutes);
router.use('/', pluginLiveRoutes);
// Hytale sign-in of this server (also at /api/auth/hytale for older clients)
router.use('/hytale-auth', hytaleAuthRoutes);

export default router;
