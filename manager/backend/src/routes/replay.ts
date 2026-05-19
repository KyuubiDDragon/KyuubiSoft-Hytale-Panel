/**
 * Routes for the replay recorder (V3.1.2).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as replay from '../services/replay.js';
import { logActivity } from '../services/activityLog.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { createReadStream } from 'fs';

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

const router = Router();

router.get('/', authMiddleware, requirePermission('replay.view'), async (_req: Request, res: Response) => {
  res.json({ segments: await replay.listSegments() });
});

router.get('/config', authMiddleware, requirePermission('replay.view'), async (_req: Request, res: Response) => {
  res.json(await replay.getReplayConfig());
});

router.put('/config', authMiddleware, requirePermission('replay.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const { recordingEnabled, retentionDays } = req.body ?? {};
  const next = await replay.setReplayConfig({
    recordingEnabled: typeof recordingEnabled === 'boolean' ? recordingEnabled : undefined,
    retentionDays: typeof retentionDays === 'number' ? retentionDays : undefined,
  });
  await logActivity(req.user || 'system', 'replay.config_changed', 'replay', true, undefined, JSON.stringify(next));
  res.json(next);
});

router.get('/:id/manifest', authMiddleware, requirePermission('replay.view'), async (req: Request, res: Response) => {
  const m = await replay.getManifest(req.params.id);
  if (!m) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  res.json(m);
});

// Server-Sent Events stream of the decompressed NDJSON ticks. Each NDJSON
// line is forwarded as a separate `data:` event so the client can replay
// in real time.
router.get('/:id/stream', authForSse, requirePermission('replay.view'), (req: Request, res: Response) => {
  const stream = replay.openTicksStream(req.params.id);
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
});

router.post('/:id/export', authMiddleware, requirePermission('replay.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const token = await replay.createExportToken(req.params.id);
  if (!token) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  await logActivity(req.user || 'system', 'replay.exported', 'replay', true, req.params.id);
  res.json({ downloadUrl: `/api/replay/download/${token.token}`, expiresAt: token.expiresAt });
});

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

router.delete('/:id', authMiddleware, requirePermission('replay.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const ok = await replay.deleteSegment(req.params.id);
  await logActivity(req.user || 'system', 'replay.deleted', 'replay', ok, req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Segment not found' });
    return;
  }
  res.json({ success: true });
});

export default router;
