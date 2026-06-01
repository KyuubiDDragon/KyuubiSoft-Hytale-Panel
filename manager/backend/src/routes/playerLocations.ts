/**
 * Routes for the live player map (V3.1.1).
 *
 *   GET  /api/players/locations            – current snapshot
 *   GET  /api/players/locations/history    – NDJSON stream of buffered samples
 *
 * The WebSocket endpoint is wired in `index.ts` (alongside the other WS
 * handlers) and forwards each new sample as JSON.
 */
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as locations from '../services/playerLocations.js';

const router = Router();

router.get('/', authMiddleware, requirePermission('players.view'), (_req: Request, res: Response) => {
  res.json({ samples: locations.getLatestSnapshot() });
});

router.get('/history', authMiddleware, requirePermission('players.view'), (req: Request, res: Response) => {
  const fromQ = typeof req.query.from === 'string' ? Number(req.query.from) : undefined;
  const toQ = typeof req.query.to === 'string' ? Number(req.query.to) : undefined;
  const playerUuid = typeof req.query.playerUuid === 'string' ? req.query.playerUuid : undefined;

  const samples = locations.getHistory({
    from: Number.isFinite(fromQ) ? fromQ : undefined,
    to: Number.isFinite(toQ) ? toQ : undefined,
    playerUuid,
  });

  res.setHeader('Content-Type', 'application/x-ndjson');
  for (const s of samples) res.write(JSON.stringify(s) + '\n');
  res.end();
});

export default router;
