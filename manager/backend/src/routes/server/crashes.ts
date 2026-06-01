// Crash report endpoints under /api/server. Backed by services/crashReports.ts,
// which snapshots container logs when the watchdog emits `server.crashed`.
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { getCrashReports, getCrashReport } from '../../services/crashReports.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

// GET /api/server/crashes - recent crash reports (newest first)
router.get('/crashes', authMiddleware, requirePermission('server.view_status'), (req: AuthenticatedRequest, res: Response) => {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
  res.json({ crashes: getCrashReports(req.serverId, limit) });
});

// GET /api/server/crashes/:id - a single crash report incl. captured log tail
router.get('/crashes/:id', authMiddleware, requirePermission('server.view_status'), (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const report = getCrashReport(id);
  if (!report) {
    res.status(404).json({ error: 'Crash report not found' });
    return;
  }
  res.json(report);
});

export default router;
