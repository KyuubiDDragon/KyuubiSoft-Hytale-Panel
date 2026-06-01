// Aggregate router for /api/server. Mounts the demo endpoint (open, no auth)
// and the lifecycle / config / updates / auth / panel submodules.
//
// All endpoint URLs are preserved exactly as they were on the previous monolithic
// routes/server.ts — submodules are mounted on '/' so paths stay identical.
import { Router, Request, Response } from 'express';
import { isDemoMode } from '../../services/demoData.js';

import lifecycleRoutes from './lifecycle.js';
import configRoutes from './config.js';
import updatesRoutes from './updates.js';
import authRoutes from './auth.js';
import panelRoutes from './panel.js';
import crashesRoutes from './crashes.js';

const router = Router();

// GET /api/server/demo - Check if demo mode is enabled (no auth required for login page)
router.get('/demo', (_req: Request, res: Response) => {
  res.json({
    demoMode: isDemoMode(),
    message: isDemoMode() ? 'Panel is running in demo mode. All data is simulated.' : undefined,
  });
});

// Mount submodules at root so all original /api/server/* paths still resolve
router.use('/', lifecycleRoutes);
router.use('/', configRoutes);
router.use('/', updatesRoutes);
router.use('/', authRoutes);
router.use('/', panelRoutes);
router.use('/', crashesRoutes);

export default router;
