import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as dockerService from '../services/docker.js';
import { parseLogs } from '../services/logs.js';
import { isDemoMode, getDemoLogs } from '../services/demoData.js';
import { actorFromRequest, authorizeCommand, holdsCommandTier } from '../services/commandPolicy.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import { containsControlChars, getCommandRequiredPermission } from '../utils/sanitize.js';
import { getCommandRegistry, withPanelPolicy } from '../services/commandRegistry.js';
import { fetchCommandCompletions } from '../services/pluginCommands.js';
import { resolveServerId } from '../services/servers.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Same cap as the plugin's completion endpoint.
const MAX_COMPLETION_LINE = 512;
// A forced full registry export (?refresh=1) runs at most this often per server.
const FORCED_REFRESH_INTERVAL_MS = 10_000;
const lastForcedRefresh = new Map<string, number>();

function claimForcedRefresh(serverId: string): boolean {
  const now = Date.now();
  if (now - (lastForcedRefresh.get(serverId) ?? 0) < FORCED_REFRESH_INTERVAL_MS) return false;
  lastForcedRefresh.set(serverId, now);
  return true;
}

/**
 * The server completes arguments with live data (player names, groups, …), so
 * suggestions are only given for a command the caller may run: one on the
 * panel's whitelist and within the caller's console tier on that server.
 */
async function mayComplete(req: AuthenticatedRequest, line: string): Promise<boolean> {
  const root = line.trim().split(/\s+/)[0] ?? '';
  if (!root) return false;
  const tier = getCommandRequiredPermission(root.startsWith('/') ? root : `/${root}`);
  if (!tier) return false;
  return holdsCommandTier(actorFromRequest(req), tier, req.serverId);
}

// GET /api/console/logs
router.get(
  '/logs',
  authMiddleware,
  requirePermission('console.view'),
  async (req: Request, res: Response) => {
    // Demo mode: return simulated logs
    if (isDemoMode()) {
      const tailParam = parseInt(req.query.tail as string);
      const tail = tailParam === 0 ? 100 : Math.min(Math.max(tailParam || 100, 1), 100);
      const demoLogs = getDemoLogs(tail);
      const logs = parseLogs(demoLogs);

      res.json({
        logs,
        count: logs.length,
      });
      return;
    }

    // Allow 0 for all logs, otherwise limit between 1 and 10000
    const tailParam = parseInt(req.query.tail as string);
    const tail = tailParam === 0 ? 0 : Math.min(Math.max(tailParam || 100, 1), 10000);

    const rawLogs = await dockerService.getLogs(tail);
    const logs = parseLogs(rawLogs);

    res.json({
      logs,
      count: logs.length,
    });
  },
);

// POST /api/console/command
router.post(
  '/command',
  authMiddleware,
  requirePermission('console.execute'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { command } = req.body;

    if (!command) {
      res.status(400).json({ detail: 'Command required' });
      return;
    }

    // SECURITY: whitelist + injection guard, then the command's tier
    // (console.execute or console.execute.admin for /op, /stop, /ban, …) on
    // the target server. An API key additionally needs that tier in its own
    // scopes, so a key scoped to console.execute can't run admin commands
    // even when its owner could.
    const auth = await authorizeCommand(actorFromRequest(req), command, req.serverId);
    if (!auth.allowed) {
      res.status(auth.status).json({ success: false, command, error: auth.error });
      return;
    }

    // Demo mode: simulate command execution
    if (isDemoMode()) {
      res.json({
        success: true,
        command,
        output: `[Demo] Command executed: ${command}`,
        error: null,
      });
      return;
    }

    const result = await dockerService.execCommand(command, req.serverId, { actor: req.user });

    // `lines`/`status` only exist when the plugin ran the command; over stdin
    // there is no answer to show, `output` then carries the "sent" note.
    res.json({
      success: result.success,
      command,
      output: result.output || result.message,
      lines: result.lines,
      status: result.status,
      via: result.via,
      error: result.error,
    });
  }),
);

// GET /api/console/commands - the server's real command list for autocomplete,
// each root command annotated with what the panel's whitelist does with it.
router.get(
  '/commands',
  authMiddleware,
  requirePermission('console.execute'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ available: false, commands: [] });
      return;
    }
    const serverId = await resolveServerId(req.serverId);
    const force = req.query.refresh === '1' && claimForcedRefresh(serverId);
    const registry = await getCommandRegistry(serverId, { force });
    if (!registry) {
      res.json({ available: false, commands: [] });
      return;
    }
    res.json({ available: true, ...registry, commands: withPanelPolicy(registry.commands) });
  }),
);

// GET /api/console/commands/complete?line=… - the server's own completion
// (subcommands, player names, --options) for the last token of a line.
router.get(
  '/commands/complete',
  authMiddleware,
  requirePermission('console.execute'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const line = typeof req.query.line === 'string' ? req.query.line : '';
    if (line.length > MAX_COMPLETION_LINE || containsControlChars(line)) {
      res.status(400).json({ error: 'line must be a single line' });
      return;
    }
    if (isDemoMode()) {
      res.json({ available: false, suggestions: [] });
      return;
    }
    if (!(await mayComplete(req, line))) {
      res.json({ available: true, suggestions: [] });
      return;
    }
    const completion = await fetchCommandCompletions(await resolveServerId(req.serverId), line);
    res.json(
      completion ? { available: true, ...completion } : { available: false, suggestions: [] },
    );
  }),
);

export default router;
