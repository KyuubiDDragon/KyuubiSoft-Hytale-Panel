/**
 * Routes for the live player map (V3.1.1).
 *
 *   GET  /api/players/locations            – current snapshot
 *   GET  /api/players/locations/history    – NDJSON stream of buffered samples
 *
 * Both answer for one server: the scoped mount /api/servers/:id/players/
 * locations, or the default server on the legacy path.
 *
 * The WebSocket endpoint is wired in `index.ts` (alongside the other WS
 * handlers) and forwards each new sample of its server as JSON.
 */
import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as locations from '../services/playerLocations.js';
import { resolveServerId } from '../services/servers.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { asyncRoute } from '../utils/asyncRoute.js';

const router = Router();

router.get(
  '/',
  authMiddleware,
  requirePermission('players.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    res.json({ samples: locations.getLatestSnapshot(await resolveServerId(req.serverId)) });
  }),
);

router.get(
  '/history',
  authMiddleware,
  requirePermission('players.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const fromQ = typeof req.query.from === 'string' ? Number(req.query.from) : undefined;
    const toQ = typeof req.query.to === 'string' ? Number(req.query.to) : undefined;
    const playerUuid = typeof req.query.playerUuid === 'string' ? req.query.playerUuid : undefined;

    const samples = locations.getHistory({
      serverId: await resolveServerId(req.serverId),
      from: Number.isFinite(fromQ) ? fromQ : undefined,
      to: Number.isFinite(toQ) ? toQ : undefined,
      playerUuid,
    });

    res.setHeader('Content-Type', 'application/x-ndjson');
    for (const s of samples) res.write(JSON.stringify(s) + '\n');
    res.end();
  }),
);

export default router;
