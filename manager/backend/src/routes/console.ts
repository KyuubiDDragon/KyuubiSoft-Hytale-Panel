import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as dockerService from '../services/docker.js';
import { assembleLogLines, parseLogs } from '../services/logs.js';
import { readServerLogTail } from '../services/serverLogStream.js';
import { readServerLogFiles } from '../services/serverLogFiles.js';
import { isDemoMode, getDemoLogs } from '../services/demoData.js';
import {
  actorFromRequest,
  authorizeCommand,
  commandsOf,
  holdsCommandTier,
} from '../services/commandPolicy.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import { containsControlChars } from '../utils/sanitize.js';
import { VANILLA_COMMANDS, lowestTierWithin } from '../utils/commandWhitelist.js';
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

// Limits of the console's log reads: a tail, and "load all".
const MAX_TAIL_LINES = 10_000;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const LOAD_ALL = { maxFiles: 5, maxBytes: 8 * 1024 * 1024, maxEntries: 10_000 };
const loadingAll = new Set<string>();

function claimForcedRefresh(serverId: string): boolean {
  const now = Date.now();
  if (now - (lastForcedRefresh.get(serverId) ?? 0) < FORCED_REFRESH_INTERVAL_MS) return false;
  lastForcedRefresh.set(serverId, now);
  return true;
}

/**
 * The server completes arguments with live data (player names, groups, …), so
 * suggestions are only given for a command the caller may run on that server,
 * or that has a subcommand the caller may run (to complete its name).
 */
async function mayComplete(req: AuthenticatedRequest, line: string): Promise<boolean> {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  const tier = lowestTierWithin(
    trimmed.startsWith('/') ? trimmed : `/${trimmed}`,
    await commandsOf(req.serverId),
  );
  if (!tier) return false;
  return holdsCommandTier(actorFromRequest(req), tier, req.serverId);
}

// GET /api/console/logs?tail=N - the last N lines of the console (1..10000).
// GET /api/console/logs?tail=0 - "load all": the server's own log files,
// newest first within the limits below; the container log when the panel
// cannot see the server's logs folder.
router.get(
  '/logs',
  authMiddleware,
  requirePermission('console.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const tailParam = parseInt(req.query.tail as string);

    // Demo mode: return simulated logs
    if (isDemoMode()) {
      const tail = tailParam === 0 ? 100 : Math.min(Math.max(tailParam || 100, 1), 100);
      const logs = parseLogs(getDemoLogs(tail));
      res.json({ logs, count: logs.length, truncated: false, source: 'container' });
      return;
    }

    const serverId = await resolveServerId(req.serverId);
    if (tailParam === 0) {
      // One full read per server at a time; each one parses megabytes.
      if (loadingAll.has(serverId)) {
        res.status(429).json({ error: 'The full log is already being loaded; try again shortly' });
        return;
      }
      loadingAll.add(serverId);
      try {
        const files = await readServerLogFiles(serverId, LOAD_ALL);
        if (files) {
          res.json({
            logs: files.entries,
            count: files.entries.length,
            truncated: files.truncated,
            source: 'files',
            files: files.files,
          });
          return;
        }
        res.json(await containerLog(serverId, LOAD_ALL.maxEntries, LOAD_ALL.maxBytes));
      } finally {
        loadingAll.delete(serverId);
      }
      return;
    }

    const tail = Math.min(Math.max(tailParam || 100, 1), MAX_TAIL_LINES);
    res.json(await containerLog(serverId, tail, MAX_TAIL_BYTES));
  }),
);

/** The newest entries of the container log, from at most `tail` lines. */
async function containerLog(serverId: string, tail: number, maxBytes: number) {
  const read = await readServerLogTail(serverId, { tail, maxBytes });
  const logs = assembleLogLines(read.lines).map((e) => e.entry);
  // As many lines as asked for: the log most likely goes back further.
  const truncated = read.truncated || read.lines.length >= tail;
  return { logs, count: logs.length, truncated, source: 'container' as const };
}

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
// each command annotated with the console tier the panel requires for it.
// Without a registry (no plugin, never ran with it) the vanilla 0.7.3 list
// the panel checks against is returned, marked `source: 'fallback'`.
router.get(
  '/commands',
  authMiddleware,
  requirePermission('console.execute'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const fallback = {
      available: true,
      source: 'fallback',
      stale: true,
      commands: withPanelPolicy(VANILLA_COMMANDS),
    };
    if (isDemoMode()) {
      res.json(fallback);
      return;
    }
    const serverId = await resolveServerId(req.serverId);
    const force = req.query.refresh === '1' && claimForcedRefresh(serverId);
    const registry = await getCommandRegistry(serverId, { force });
    if (!registry) {
      res.json({ ...fallback, serverId });
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
