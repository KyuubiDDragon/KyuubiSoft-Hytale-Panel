/**
 * Public, UNAUTHENTICATED status endpoint.
 *
 * Off by default; an operator enables it via config.publicStatus.enabled. Only
 * non-sensitive, server-owner-publishable data is returned (name, MOTD, online
 * state, player counts, version). Cached briefly to shrug off scraping.
 */
import { Router, Request, Response } from 'express';
import * as dockerService from '../services/docker.js';
import * as kyuubiApi from '../services/kyuubiApi.js';
import { getConfig } from '../services/configService.js';
import { isDemoMode } from '../services/demoData.js';

const router = Router();

router.get('/status', async (_req: Request, res: Response) => {
  let cfg: Awaited<ReturnType<typeof getConfig>> | null = null;
  try { cfg = await getConfig(); } catch { /* config not ready */ }

  const enabled = isDemoMode() || cfg?.publicStatus?.enabled === true;
  if (!enabled) {
    res.status(404).json({ error: 'Public status page is disabled' });
    return;
  }

  const status = await dockerService.getStatus();
  const result: Record<string, unknown> = {
    serverName: cfg?.server?.name ?? 'Hytale Server',
    motd: cfg?.server?.motd ?? '',
    online: status.running,
    playerCount: 0,
    maxPlayers: cfg?.server?.maxPlayers ?? null,
    version: null,
    tps: null,
  };

  if (status.running) {
    try {
      const info = await kyuubiApi.getServerInfoFromPlugin();
      if (info.success && info.data) {
        const d = info.data as { playerCount?: number; onlinePlayers?: number; maxPlayers?: number; version?: string; tps?: number };
        result.playerCount = d.playerCount ?? d.onlinePlayers ?? 0;
        if (typeof d.maxPlayers === 'number') result.maxPlayers = d.maxPlayers;
        if (typeof d.version === 'string') result.version = d.version;
        if (typeof d.tps === 'number') result.tps = Math.round(d.tps * 10) / 10;
      }
    } catch { /* plugin not running — return the basic status */ }
  }

  res.set('Cache-Control', 'public, max-age=10');
  res.json(result);
});

export default router;
