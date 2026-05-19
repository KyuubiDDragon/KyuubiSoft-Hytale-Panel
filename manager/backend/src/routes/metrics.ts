/**
 * /api/metrics — Prometheus exposition.
 *
 * Auth options:
 *   - Bearer JWT carrying the `audit.view` permission (or `*` admin)
 *   - REST API key with `audit.view` scope
 *   - Static METRICS_TOKEN env var matched against the Authorization
 *     header — convenient for Prometheus scrapers that can't manage
 *     panel users.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { exposition, contentType } from '../services/metrics.js';

const router = Router();

router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    const token = process.env.METRICS_TOKEN;
    if (token && req.headers.authorization === `Bearer ${token}`) {
      res.setHeader('Content-Type', contentType());
      res.send(await exposition());
      return;
    }
    next();
  },
  authMiddleware,
  requirePermission('audit.view'),
  async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', contentType());
    res.send(await exposition());
  },
);

export default router;
