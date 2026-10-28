/**
 * Routes for the replay recorder (V3.1.2).
 *
 * Segments belong to one server: the scoped mount /api/servers/:id/replay, or
 * the default server on the legacy path. The recording switch and retention
 * (`/config`) apply to every server, so changing them needs replay.manage
 * outside any server role.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission, requireAllServerAccess } from '../middleware/permissions.js';
import * as replay from '../services/replay.js';
import { logActivity } from '../services/activityLog.js';
import { resolveServerId } from '../services/servers.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import { createReadStream } from 'fs';

const serverOf = (req: AuthenticatedRequest) => resolveServerId(req.serverId);

/**
 * Browser EventSource cannot set custom headers, so the SSE stream route
 * accepts the access token via `?token=`. We splice it into the standard
 * Authorization header before delegating to the regular auth middleware.
 */
function authForSse(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization && typeof req.query.token === 'string') {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  authMiddleware(req as AuthenticatedRequest, res, next);
}

const MAX_RETENTION_DAYS = 365;

function isValidRetentionDays(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_RETENTION_DAYS;
}

const router = Router();

router.get(
  '/',
  authMiddleware,
  requirePermission('replay.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    res.json({ segments: await replay.listSegments(await serverOf(req)) });
  }),
);

router.get(
  '/config',
  authMiddleware,
  requirePermission('replay.view'),
  async (_req: Request, res: Response) => {
    res.json(await replay.getReplayConfig());
  },
);

router.put(
  '/config',
  authMiddleware,
  requirePermission('replay.manage'),
  // The switch covers every server: an account limited to some servers may not change it.
  requireAllServerAccess(),
  async (req: AuthenticatedRequest, res: Response) => {
    const { recordingEnabled, retentionDays } = req.body ?? {};
    if (retentionDays !== undefined && !isValidRetentionDays(retentionDays)) {
      res.status(400).json({
        error: `retentionDays must be a whole number between 1 and ${MAX_RETENTION_DAYS}`,
      });
      return;
    }
    const next = await replay.setReplayConfig({
      recordingEnabled: typeof recordingEnabled === 'boolean' ? recordingEnabled : undefined,
      retentionDays: typeof retentionDays === 'number' ? retentionDays : undefined,
    });
    await logActivity(
      req.user || 'system',
      'replay.config_changed',
      'replay',
      true,
      undefined,
      JSON.stringify(next),
    );
    res.json(next);
  },
);

router.get(
  '/:id/manifest',
  authMiddleware,
  requirePermission('replay.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const m = await replay.getManifest(req.params.id, await serverOf(req));
    if (!m) {
      res.status(404).json({ error: 'Segment not found' });
      return;
    }
    res.json(m);
  },
);

// Server-Sent Events stream of the decompressed NDJSON ticks. Each NDJSON
// line is forwarded as a separate `data:` event so the client can replay
// in real time.
router.get(
  '/:id/stream',
  authForSse,
  requirePermission('replay.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const stream = replay.openTicksStream(req.params.id, await serverOf(req));
    if (!stream) {
      res.status(404).json({ error: 'Segment not found' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let buf = '';
    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.length > 0) res.write(`data: ${line}\n\n`);
      }
    });
    stream.on('end', () => {
      if (buf.trim().length > 0) res.write(`data: ${buf.trim()}\n\n`);
      res.write('event: end\ndata: {}\n\n');
      res.end();
    });
    stream.on('error', () => res.end());
    req.on('close', () => {
      // Best-effort cleanup; readable streams from fs are unref'd by destroy.
      (stream as { destroy?: () => void }).destroy?.();
    });
  }),
);

router.post(
  '/:id/export',
  authMiddleware,
  requirePermission('replay.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    const token = await replay.createExportToken(req.params.id, await serverOf(req));
    if (!token) {
      res.status(404).json({ error: 'Segment not found' });
      return;
    }
    await logActivity(req.user || 'system', 'replay.exported', 'replay', true, req.params.id);
    res.json({ downloadUrl: `/api/replay/download/${token.token}`, expiresAt: token.expiresAt });
  },
);

// One-shot download endpoint, token bound and unauth (token is the auth).
router.get('/download/:token', (req: Request, res: Response) => {
  const meta = replay.consumeExportToken(req.params.token);
  if (!meta) {
    res.status(404).json({ error: 'Invalid or expired token' });
    return;
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${meta.downloadName}"`);
  createReadStream(meta.filePath).pipe(res);
});

router.delete(
  '/:id',
  authMiddleware,
  requirePermission('replay.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    const ok = await replay.deleteSegment(req.params.id, await serverOf(req));
    await logActivity(req.user || 'system', 'replay.deleted', 'replay', ok, req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Segment not found' });
      return;
    }
    res.json({ success: true });
  },
);

export default router;
