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
import crypto from 'crypto';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { exposition, contentType } from '../services/metrics.js';

const router = Router();

// Constant-time comparison so the static METRICS_TOKEN can't be recovered
// byte-by-byte via response timing. Lengths are compared first (timingSafeEqual
// throws on length mismatch); the length check is not itself secret.
function tokenMatches(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(authHeader);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    const token = process.env.METRICS_TOKEN;
    if (token && tokenMatches(req.headers.authorization, token)) {
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
