import { logger } from '../utils/logger.js';
import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  ALL_SERVERS_REQUIRED,
  accessibleServerIds,
  requirePermission,
} from '../middleware/permissions.js';
import * as playersService from '../services/players.js';
import * as dockerService from '../services/docker.js';
import * as kyuubiApi from '../services/kyuubiApi.js';
import * as chatLog from '../services/chatLog.js';
import * as punishments from '../services/punishments.js';
import { getLeaderboard, getPlayerSessions } from '../services/playtime.js';
import * as playerNotes from '../services/playerNotes.js';
import {
  exportPlayerData,
  deletePlayerData,
  type PlayerDataScope,
} from '../services/playerDataExport.js';
import { resolveServerId } from '../services/servers.js';
import { banPlayer, unbanPlayer, type BanOutcome } from '../services/accessBans.js';
import { addToWhitelist, removeFromWhitelist } from '../services/accessWhitelist.js';
import { describeAccessError, type WriteOutcome } from '../services/accessContext.js';
import { logActivity } from '../services/activityLog.js';
import { isDemoMode, getDemoWhitelist } from '../services/demoData.js';
import type { AuthenticatedRequest } from '../types/index.js';
import type { Permission } from '../types/permissions.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import {
  isValidPlayerName,
  isValidGamemode,
  isValidItemId,
  isValidNumber,
  isValidCoordinate,
  isValidEffectName,
  sanitizeMessage,
} from '../utils/sanitize.js';

const router = Router();

// POST /api/players/bulk — apply a single action to many players at once.
// The frontend assembles the selection (Checkbox-Spalte → idle "N selected"
// bar) and we run the same per-player handlers serially with audit + error
// capture per item. Permissions are checked per action via requirePermission.
const BULK_PERMISSIONS = new Map<string, Permission>([
  ['kick', 'players.kick'],
  ['ban', 'players.ban'],
  ['unban', 'players.unban'],
]);

// SECURITY: same gate as the per-player routes, through requirePermission so
// an API key's scopes and the per-server role count (previously only the
// owner's global role was checked).
function requireBulkPermission(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const action = (req.body as { action?: unknown } | undefined)?.action;
  const required = typeof action === 'string' ? BULK_PERMISSIONS.get(action) : undefined;
  if (!required) {
    res.status(400).json({
      detail: action ? `unsupported action ${String(action)}` : 'names[] and action required',
    });
    return;
  }
  void requirePermission(required)(req, res, next);
}

router.post(
  '/bulk',
  authMiddleware,
  requireBulkPermission,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { names, action, reason } = req.body as {
      names?: string[];
      action: string;
      reason?: string;
    };
    if (!Array.isArray(names) || names.length === 0) {
      res.status(400).json({ detail: 'names[] and action required' });
      return;
    }

    const results: Array<{ name: string; success: boolean; error?: string; warning?: string }> = [];
    for (const rawName of names) {
      if (!isValidPlayerName(rawName)) {
        results.push({ name: rawName, success: false, error: 'invalid name' });
        continue;
      }
      if (isDemoMode()) {
        results.push({ name: rawName, success: true });
        continue;
      }
      if (action === 'kick') {
        // /kick takes only the player in Hytale 0.7; a reason would fail the command.
        const r = await dockerService.execCommand(`/kick ${rawName}`, req.serverId);
        results.push({ name: rawName, success: r.success, error: r.success ? undefined : r.error });
        if (r.success) await markOffline(req, rawName);
        continue;
      }
      // Bans go by UUID (the server matches a bare name by prefix) and are read back.
      let outcome: BanOutcome;
      try {
        outcome =
          action === 'ban'
            ? await banPlayer(req.serverId, rawName, reason)
            : await unbanPlayer(req.serverId, rawName);
        results.push({ name: rawName, success: true });
      } catch (error) {
        results.push({ name: rawName, success: false, error: describeAccessError(error).error });
        continue;
      }
      // Like the single routes: a permanent ban or an unban ends the panel's temp-bans.
      await punishments
        .closeBanRecords(
          banTarget(req, rawName, outcome),
          action === 'ban' ? ['tempban'] : ['ban', 'tempban'],
          req.user || 'system',
        )
        .catch((error) => {
          logger.error(`[Players] bulk ${action} ${rawName}: not recorded:`, error);
          if (action === 'ban') results[results.length - 1].warning = TEMPBANS_NOT_CLOSED;
        });
    }
    const summary = {
      total: results.length,
      success: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
    // Reuse the player-scoped activity log target; the action name carries
    // the "bulk_" prefix to make filtering trivial.
    await logActivity(
      req.user || 'system',
      `bulk_${action}`,
      'player',
      summary.failed === 0,
      `${summary.total} players`,
    );
    res.json({ results, summary });
  }),
);

// SECURITY: Validate player name from URL params
function validatePlayerName(res: Response, name: string): boolean {
  if (!isValidPlayerName(name)) {
    res.status(400).json({
      success: false,
      error:
        'Invalid player name. Only letters, digits, underscores and hyphens (not first), at most 32 characters.',
    });
    return false;
  }
  return true;
}

/**
 * The plugin took a player action but did not answer in time, so it may still
 * have run. Sending it again on the console could apply it twice (an item
 * given twice), so the console fallback is skipped.
 */
function answerMaybeRan(res: Response, playerName: string): void {
  res.status(504).json({
    success: false,
    error: `The plugin did not answer in time; the action on ${playerName} may still have happened, so it was not sent again`,
  });
}

/**
 * The answer for a console command that was accepted. Without the KyuubiSoft
 * API plugin the line only reached the console's stdin and its result is
 * unknown, so the answer says that instead of claiming the action worked.
 */
function commandDone(
  res: Response,
  result: dockerService.CommandExecResult,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const confirmed = result.via !== 'stdin';
  res.json({
    success: true,
    confirmed,
    message: confirmed
      ? message
      : `${message} (sent to the server console; without the KyuubiSoft API plugin the result is not confirmed)`,
    ...extra,
  });
}

/**
 * Hytale 0.7 has no chat mute and no private message command; the routes stay
 * so older clients get a clear answer instead of a fake success.
 */
function answerUnsupported(res: Response, what: string): void {
  res.status(501).json({ success: false, unsupported: true, error: `${what} in Hytale 0.7` });
}

interface AccessActivity {
  user: string;
  action: string;
  player: string;
  details?: string;
  /** What the answer says when the change happened but `record` failed. */
  notRecorded?: string;
  /** Refuse with 409 and this code when nothing changed (then nothing is recorded either). */
  unchanged?: { code: string; error: string };
}

const TEMPBANS_NOT_CLOSED =
  'Banned, but the panel could not close its temporary bans of this player: one may still lift the ban when it ends. Check the punishments list.';

/**
 * Marks a kicked or banned player offline in the server's player list. Only
 * bookkeeping: a failure is logged and never fails the action.
 */
async function markOffline(req: AuthenticatedRequest, playerName: string): Promise<void> {
  await playersService
    .removePlayer(playerName, req.serverId)
    .catch((error) => logger.warn(`[Players] could not mark ${playerName} offline:`, error));
}

/** The player of a ban change, for the panel's ban entries: typed name, known name and UUID. */
const banTarget = (req: AuthenticatedRequest, typed: string, outcome: BanOutcome) => ({
  serverId: req.serverId,
  names: [typed, outcome.name],
  uuid: outcome.uuid,
});

async function logAccessActivity(activity: AccessActivity, ok: boolean, details?: string) {
  try {
    await logActivity(activity.user, activity.action, 'player', ok, activity.player, details);
  } catch (error) {
    logger.error(`[Players] activity log for ${activity.action} ${activity.player} failed:`, error);
  }
}

/**
 * Runs a whitelist or ban change through the access services and answers it:
 * 200 when the new state was read back, 202 when the server only took the
 * command, the access error otherwise. Only the change decides the answer:
 * the panel's own bookkeeping afterwards (`record`, e.g. a punishment entry)
 * cannot turn a change that happened into a failure; if it fails the answer
 * carries a warning instead.
 */
async function answerAccessChange<O extends WriteOutcome<unknown>>(
  res: Response,
  activity: AccessActivity,
  change: () => Promise<O>,
  message: string,
  record?: (outcome: O) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
): Promise<void> {
  let outcome: O;
  try {
    outcome = await change();
  } catch (error) {
    const { status, error: failure, code } = describeAccessError(error);
    res.status(status).json({ success: false, error: failure, code });
    await logAccessActivity(activity, false, failure);
    return;
  }
  if (!outcome.changed && activity.unchanged) {
    res.status(409).json({ success: false, ...activity.unchanged });
    await logAccessActivity(activity, false, activity.unchanged.error);
    return;
  }
  let extra: Record<string, unknown> = {};
  try {
    extra = (await record?.(outcome)) ?? {};
  } catch (error) {
    logger.error(`[Players] ${activity.action} ${activity.player}: done, not recorded:`, error);
    extra = {
      warning: activity.notRecorded ?? 'Done on the server, but the panel could not record it',
    };
  }
  res.status(outcome.verified ? 200 : 202).json({
    success: true,
    confirmed: outcome.verified,
    changed: outcome.changed,
    via: outcome.via,
    message: outcome.message || message,
    ...extra,
  });
  await logAccessActivity(activity, true, activity.details);
}

// GET /api/players
router.get(
  '/',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Check if server is running - if not, clear stale players and return empty list
    const status = await dockerService.getStatus(req.serverId);
    if (!status.running) {
      await playersService.clearOnlinePlayers(req.serverId);
      res.json({
        players: [],
        count: 0,
      });
      return;
    }

    const players = await playersService.getOnlinePlayers(req.serverId);

    res.json({
      players,
      count: players.length,
    });
  },
);

// GET /api/players/count
router.get(
  '/count',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Check if server is running - if not, return 0
    const status = await dockerService.getStatus(req.serverId);
    if (!status.running) {
      await playersService.clearOnlinePlayers(req.serverId);
      res.json({ count: 0 });
      return;
    }
    const count = await playersService.getPlayerCount(req.serverId);
    res.json({ count });
  },
);

// GET /api/players/history - All players who have ever joined
router.get(
  '/history',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const history = await playersService.getPlayerHistory(req.serverId);
    res.json({ players: history, count: history.length });
  },
);

// GET /api/players/offline - Players in history who are currently offline
router.get(
  '/offline',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const offline = await playersService.getOfflinePlayers(req.serverId);
    res.json({ players: offline, count: offline.length });
  },
);

// GET /api/players/all - All players from JSON files with online status
router.get(
  '/all',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Update online status based on server status
    const status = await dockerService.getStatus(req.serverId);
    if (!status.running) {
      await playersService.clearOnlinePlayers(req.serverId);
    }

    const players = await playersService.getAllPlayersUnified(req.serverId);
    const onlineCount = players.filter((p) => p.online).length;
    res.json({ players, count: players.length, onlineCount });
  },
);

// GET /api/players/playtime - playtime leaderboard (most-played first)
router.get(
  '/playtime',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
      res.json({ leaderboard: getLeaderboard(await resolveServerId(req.serverId), limit) });
    } catch (error) {
      logger.error('[Players] playtime leaderboard failed:', error);
      res.status(500).json({ error: 'Failed to load playtime leaderboard' });
    }
  },
);

// GET /api/players/:uuid/playtime - per-player sessions + total
router.get(
  '/:uuid/playtime',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
      res.json(getPlayerSessions(req.params.uuid, limit, await resolveServerId(req.serverId)));
    } catch (error) {
      logger.error('[Players] playtime sessions failed:', error);
      res.status(500).json({ error: 'Failed to load playtime sessions' });
    }
  },
);

// POST /api/players/:name/kick
router.post(
  '/:name/kick',
  authMiddleware,
  requirePermission('players.kick'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const { reason } = req.body;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate kick
    if (isDemoMode()) {
      await logActivity(username, 'kick', 'player', true, playerName, reason);
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} kicked`,
      });
      return;
    }

    // SECURITY: Sanitize reason if provided
    const safeReason = reason ? sanitizeMessage(reason, 100) : '';

    // Hytale 0.7's /kick takes only the player (any further word fails the
    // command); the reason is kept in the panel's punishment record.
    const result = await dockerService.execCommand(`/kick ${playerName}`, req.serverId);

    if (result.success) {
      await markOffline(req, playerName);

      try {
        await punishments.recordPunishment({
          serverId: req.serverId,
          playerName,
          type: 'kick',
          reason: safeReason || undefined,
          byUser: username,
        });
      } catch (error) {
        logger.error(`[Players] kick ${playerName}: not recorded:`, error);
      }
      // Log activity
      await logActivity(username, 'kick', 'player', true, playerName, reason);

      commandDone(res, result, `Player ${playerName} kicked`, {
        reasonStoredOnly: Boolean(safeReason),
      });
    } else {
      await logActivity(username, 'kick', 'player', false, playerName, result.error);

      res.status(500).json({
        success: false,
        error: result.error || 'Failed to kick player',
      });
    }
  },
);

// POST /api/players/:name/ban
router.post(
  '/:name/ban',
  authMiddleware,
  requirePermission('players.ban'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const { reason } = req.body;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate ban
    if (isDemoMode()) {
      await logActivity(username, 'ban', 'player', true, playerName, reason);
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} banned`,
      });
      return;
    }

    // By UUID (the server matches a bare name by prefix), read back afterwards;
    // with the server stopped it goes into bans.json. The server disconnects a
    // banned player itself. A ban in Hytale 0.7 has no end date.
    const safeReason = typeof reason === 'string' ? sanitizeMessage(reason, 100) : '';
    await answerAccessChange(
      res,
      { user: username, action: 'ban', player: playerName, details: safeReason },
      () => banPlayer(req.serverId, playerName, safeReason),
      `Player ${playerName} banned`,
      async (outcome) => {
        await markOffline(req, playerName);
        // A permanent ban: a temp-ban running on the player must not lift it later.
        const closed = await punishments
          .closeBanRecords(banTarget(req, playerName, outcome), ['tempban'], username)
          .then(
            () => ({}),
            (error: unknown) => {
              logger.error(`[Players] ban ${playerName}: temp-bans not closed:`, error);
              return { warning: TEMPBANS_NOT_CLOSED };
            },
          );
        await punishments.recordPunishment({
          serverId: req.serverId,
          playerName,
          uuid: outcome.uuid,
          type: 'ban',
          reason: safeReason || undefined,
          byUser: username,
        });
        return closed;
      },
    );
  }),
);

// DELETE /api/players/:name/ban
router.delete(
  '/:name/ban',
  authMiddleware,
  requirePermission('players.unban'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate unban
    if (isDemoMode()) {
      await logActivity(username, 'unban', 'player', true, playerName);
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} unbanned`,
      });
      return;
    }

    await answerAccessChange(
      res,
      { user: username, action: 'unban', player: playerName },
      () => unbanPlayer(req.serverId, playerName),
      `Player ${playerName} unbanned`,
      async (outcome) => {
        await punishments.closeBanRecords(
          banTarget(req, playerName, outcome),
          ['ban', 'tempban'],
          username,
        );
      },
    );
  }),
);

// POST /api/players/:name/whitelist
router.post(
  '/:name/whitelist',
  authMiddleware,
  requirePermission('players.whitelist'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate whitelist add
    if (isDemoMode()) {
      await logActivity(username, 'whitelist_add', 'player', true, playerName);
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} added to whitelist`,
      });
      return;
    }

    // The join permission by UUID when known (read back afterwards); with the
    // server stopped it goes into the server's files.
    await answerAccessChange(
      res,
      { user: username, action: 'whitelist_add', player: playerName },
      () => addToWhitelist(req.serverId, playerName),
      `Player ${playerName} added to whitelist`,
    );
  }),
);

// DELETE /api/players/:name/whitelist
router.delete(
  '/:name/whitelist',
  authMiddleware,
  requirePermission('players.whitelist'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate whitelist remove
    if (isDemoMode()) {
      await logActivity(username, 'whitelist_remove', 'player', true, playerName);
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} removed from whitelist`,
      });
      return;
    }

    await answerAccessChange(
      res,
      { user: username, action: 'whitelist_remove', player: playerName },
      () => removeFromWhitelist(req.serverId, playerName),
      `Player ${playerName} removed from whitelist`,
    );
  }),
);

// POST /api/players/:name/op
router.post(
  '/:name/op',
  authMiddleware,
  requirePermission('players.op'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate op
    if (isDemoMode()) {
      await logActivity(username, 'op_add', 'player', true, playerName);
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} is now an operator`,
      });
      return;
    }

    const result = await dockerService.execCommand(`/op add ${playerName}`, req.serverId);

    if (result.success) {
      await logActivity(username, 'op_add', 'player', true, playerName);
      res.json({
        success: true,
        message: `Player ${playerName} is now an operator`,
      });
    } else {
      await logActivity(username, 'op_add', 'player', false, playerName, result.error);
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to op player',
      });
    }
  },
);

// DELETE /api/players/:name/op
router.delete(
  '/:name/op',
  authMiddleware,
  requirePermission('players.op'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate deop
    if (isDemoMode()) {
      await logActivity(username, 'op_remove', 'player', true, playerName);
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} is no longer an operator`,
      });
      return;
    }

    const result = await dockerService.execCommand(`/op remove ${playerName}`, req.serverId);

    if (result.success) {
      await logActivity(username, 'op_remove', 'player', true, playerName);
      res.json({
        success: true,
        message: `Player ${playerName} is no longer an operator`,
      });
    } else {
      await logActivity(username, 'op_remove', 'player', false, playerName, result.error);
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to deop player',
      });
    }
  },
);

// POST /api/players/:name/message
router.post(
  '/:name/message',
  authMiddleware,
  requirePermission('players.message'),
  async (req: Request, res: Response) => {
    const playerName = req.params.name;
    const { message } = req.body;

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    if (!message || typeof message !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Message is required',
      });
      return;
    }

    // /msg, /tell and /whisper do not exist in Hytale 0.7; /say reaches everyone.
    answerUnsupported(res, 'There is no private message command');
  },
);

// POST /api/players/:name/teleport
router.post(
  '/:name/teleport',
  authMiddleware,
  requirePermission('players.teleport'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const { target, x, y, z } = req.body;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    let teleportDetails: string;
    let teleportOptions: { target?: string; x?: number; y?: number; z?: number };

    if (target) {
      // SECURITY: Validate target player name
      if (!isValidPlayerName(target)) {
        res.status(400).json({ success: false, error: 'Invalid target player name' });
        return;
      }
      teleportDetails = `to player ${target}`;
      teleportOptions = { target };
    } else if (x !== undefined && y !== undefined && z !== undefined) {
      // SECURITY: Validate coordinates
      if (!isValidCoordinate(x) || !isValidCoordinate(y) || !isValidCoordinate(z)) {
        res.status(400).json({ success: false, error: 'Invalid coordinates' });
        return;
      }
      teleportDetails = `to coordinates ${x}, ${y}, ${z}`;
      teleportOptions = { x, y, z };
    } else {
      res.status(400).json({
        success: false,
        error: 'Either target player or coordinates (x, y, z) required',
      });
      return;
    }

    // Demo mode: simulate teleport
    if (isDemoMode()) {
      await logActivity(username, 'teleport', 'player', true, playerName, teleportDetails);
      res.json({
        success: true,
        message: target
          ? `[Demo] Teleported ${playerName} to ${target}`
          : `[Demo] Teleported ${playerName} to ${x}, ${y}, ${z}`,
      });
      return;
    }

    // Try plugin API first (more reliable)
    try {
      const pluginResult = await kyuubiApi.teleportPlayerViaPlugin(
        playerName,
        teleportOptions,
        req.serverId,
      );
      if (pluginResult.success) {
        await logActivity(username, 'teleport', 'player', true, playerName, teleportDetails);
        res.json({
          success: true,
          message: target
            ? `Teleported ${playerName} to ${target}`
            : `Teleported ${playerName} to ${x}, ${y}, ${z}`,
        });
        return;
      }
      if (pluginResult.maybeRan) return answerMaybeRan(res, playerName);
    } catch {
      // Plugin not available, fall back to console command
    }

    // Fallback: Use console command
    const command = target ? `/tp ${playerName} ${target}` : `/tp ${playerName} ${x} ${y} ${z}`;

    const result = await dockerService.execCommand(command, req.serverId);

    if (result.success) {
      await logActivity(username, 'teleport', 'player', true, playerName, teleportDetails);
      commandDone(
        res,
        result,
        target
          ? `Teleported ${playerName} to ${target}`
          : `Teleported ${playerName} to ${x}, ${y}, ${z}`,
      );
    } else {
      await logActivity(username, 'teleport', 'player', false, playerName, result.error);
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to teleport player',
      });
    }
  },
);

// POST /api/players/:name/kill
router.post(
  '/:name/kill',
  authMiddleware,
  requirePermission('players.kill'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate kill
    if (isDemoMode()) {
      await logActivity(username, 'kill', 'player', true, playerName);
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} killed`,
      });
      return;
    }

    // Try plugin API first (more reliable)
    try {
      const pluginResult = await kyuubiApi.killPlayerViaPlugin(playerName, req.serverId);
      if (pluginResult.success) {
        await logActivity(username, 'kill', 'player', true, playerName);
        res.json({
          success: true,
          message: `Player ${playerName} killed`,
        });
        return;
      }
      if (pluginResult.maybeRan) return answerMaybeRan(res, playerName);
    } catch {
      // Plugin not available, fall back to console command
    }

    // Fallback: Use console command
    const result = await dockerService.execCommand(`/kill ${playerName}`, req.serverId);

    if (result.success) {
      await logActivity(username, 'kill', 'player', true, playerName);
      commandDone(res, result, `Player ${playerName} killed`);
    } else {
      await logActivity(username, 'kill', 'player', false, playerName, result.error);
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to kill player',
      });
    }
  },
);

// POST /api/players/:name/respawn
router.post(
  '/:name/respawn',
  authMiddleware,
  requirePermission('players.respawn'),
  async (req: Request, res: Response) => {
    const playerName = req.params.name;

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate respawn
    if (isDemoMode()) {
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} respawned`,
      });
      return;
    }

    // Try plugin API first (more reliable)
    try {
      const pluginResult = await kyuubiApi.respawnPlayerViaPlugin(playerName, req.serverId);
      if (pluginResult.success) {
        res.json({
          success: true,
          message: `Player ${playerName} respawned`,
        });
        return;
      }
      if (pluginResult.maybeRan) return answerMaybeRan(res, playerName);
    } catch {
      // Plugin not available, fall back to console command
    }

    // Fallback: Use console command (the variant with the player as argument)
    const result = await dockerService.execCommand(`/player respawn ${playerName}`, req.serverId);

    if (result.success) {
      commandDone(res, result, `Player ${playerName} respawned`);
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to respawn player',
      });
    }
  },
);

// POST /api/players/:name/gamemode
router.post(
  '/:name/gamemode',
  authMiddleware,
  requirePermission('players.gamemode'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const { gamemode } = req.body;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    if (!gamemode) {
      res.status(400).json({
        success: false,
        error: 'Gamemode is required',
      });
      return;
    }

    // SECURITY: Validate gamemode
    if (!isValidGamemode(gamemode)) {
      res.status(400).json({
        success: false,
        error: 'Invalid gamemode. Use: creative, adventure (or c, a)',
      });
      return;
    }

    // Demo mode: simulate gamemode change
    if (isDemoMode()) {
      await logActivity(username, 'gamemode', 'player', true, playerName, `Changed to ${gamemode}`);
      res.json({
        success: true,
        message: `[Demo] Set ${playerName}'s gamemode to ${gamemode}`,
      });
      return;
    }

    // Try plugin API first (more reliable)
    try {
      const pluginResult = await kyuubiApi.setGamemodeViaPlugin(playerName, gamemode, req.serverId);
      if (pluginResult.success) {
        await logActivity(
          username,
          'gamemode',
          'player',
          true,
          playerName,
          `Changed to ${gamemode}`,
        );
        res.json({
          success: true,
          message: `Set ${playerName}'s gamemode to ${gamemode}`,
        });
        return;
      }
      if (pluginResult.maybeRan) return answerMaybeRan(res, playerName);
    } catch {
      // Plugin not available, fall back to console command
    }

    // Fallback: Use console command
    const result = await dockerService.execCommand(
      `/gamemode ${gamemode} ${playerName}`,
      req.serverId,
    );

    if (result.success) {
      await logActivity(username, 'gamemode', 'player', true, playerName, `Changed to ${gamemode}`);
      commandDone(res, result, `Set ${playerName}'s gamemode to ${gamemode}`);
    } else {
      await logActivity(username, 'gamemode', 'player', false, playerName, result.error);
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to change gamemode',
      });
    }
  },
);

// POST /api/players/:name/give
router.post(
  '/:name/give',
  authMiddleware,
  requirePermission('players.give'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const { item, amount } = req.body;
    const username = req.user || 'system';

    // DEBUG: Log received values
    logger.info('[Give Debug] Received:', { playerName, item, amount, body: req.body });

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    if (!item) {
      res.status(400).json({
        success: false,
        error: 'Item is required',
      });
      return;
    }

    // SECURITY: Validate item ID format (item_name with underscores, lowercase)
    if (!isValidItemId(String(item).toLowerCase())) {
      res.status(400).json({
        success: false,
        error: 'Invalid item ID format. Use: item_name (e.g., furniture_crude_sign)',
      });
      return;
    }

    // SECURITY: Validate amount if provided
    if (amount !== undefined && !isValidNumber(amount)) {
      res.status(400).json({
        success: false,
        error: 'Invalid amount. Must be a number.',
      });
      return;
    }

    // Demo mode: simulate give
    if (isDemoMode()) {
      await logActivity(
        username,
        'give',
        'player',
        true,
        playerName,
        `Gave ${amount || 1}x ${item}`,
      );
      res.json({
        success: true,
        message: `[Demo] Gave ${amount || 1} ${item} to ${playerName}`,
      });
      return;
    }

    // Try the plugin API first (in-process, atomic), fall back to console.
    try {
      const pluginResult = await kyuubiApi.givePlayerViaPlugin(
        playerName,
        String(item),
        amount as number | undefined,
        req.serverId,
      );
      if (pluginResult.success) {
        await logActivity(
          username,
          'give',
          'player',
          true,
          playerName,
          `Gave ${amount || 1}x ${item}`,
        );
        res.json({ success: true, message: `Gave ${amount || 1} ${item} to ${playerName}` });
        return;
      }
      // Giving the item again on the console could hand it out twice.
      if (pluginResult.maybeRan) return answerMaybeRan(res, playerName);
    } catch {
      // Plugin not available — fall back to console command.
    }

    // Command format: /give <player> <item> --quantity=<amount>
    const command =
      amount && amount > 1
        ? `/give ${playerName} ${item} --quantity=${amount}`
        : `/give ${playerName} ${item}`;

    const result = await dockerService.execCommand(command, req.serverId);
    logger.info('[Give Debug] Command result:', result);

    if (result.success) {
      await logActivity(
        username,
        'give',
        'player',
        true,
        playerName,
        `Gave ${amount || 1}x ${item}`,
      );
      commandDone(res, result, `Gave ${amount || 1} ${item} to ${playerName}`);
    } else {
      await logActivity(username, 'give', 'player', false, playerName, result.error);
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to give item',
      });
    }
  },
);

// POST /api/players/:name/heal
router.post(
  '/:name/heal',
  authMiddleware,
  requirePermission('players.heal'),
  async (req: Request, res: Response) => {
    const playerName = req.params.name;

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate heal
    if (isDemoMode()) {
      res.json({
        success: true,
        message: `[Demo] Player ${playerName} healed`,
      });
      return;
    }

    // Try plugin API first
    try {
      const pluginResult = await kyuubiApi.healPlayerViaPlugin(playerName, req.serverId);
      if (pluginResult.success) {
        res.json({
          success: true,
          message: `Player ${playerName} healed`,
        });
        return;
      }
      if (pluginResult.maybeRan) return answerMaybeRan(res, playerName);
    } catch {
      // Plugin not available, fall back to console command
    }

    // Fallback: the console commands of Hytale's own /heal (health and
    // stamina to their maximum), aimed at the player.
    const result = await dockerService.execCommand(
      `/player stats settomax Health --player ${playerName}`,
      req.serverId,
    );
    if (result.success) {
      const stamina = await dockerService.execCommand(
        `/player stats settomax Stamina --player ${playerName}`,
        req.serverId,
      );
      if (!stamina.success) {
        logger.warn(`[Players] heal ${playerName}: stamina not restored: ${stamina.error}`);
      }
    }

    if (result.success) {
      commandDone(res, result, `Player ${playerName} healed`);
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to heal player',
      });
    }
  },
);

// POST /api/players/:name/effect
router.post(
  '/:name/effect',
  authMiddleware,
  requirePermission('players.effects'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const { effect, action } = req.body;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    if (!effect && action !== 'clear') {
      res.status(400).json({
        success: false,
        error: 'Effect is required',
      });
      return;
    }

    // SECURITY: Validate effect name if provided
    if (effect && !isValidEffectName(effect)) {
      res.status(400).json({
        success: false,
        error: 'Invalid effect name',
      });
      return;
    }

    // Demo mode: simulate effect
    if (isDemoMode()) {
      const effectDetails = action === 'clear' ? 'Cleared all effects' : `Applied ${effect}`;
      await logActivity(username, 'effect', 'player', true, playerName, effectDetails);
      res.json({
        success: true,
        message:
          action === 'clear'
            ? `[Demo] Cleared effects from ${playerName}`
            : `[Demo] Applied ${effect} to ${playerName}`,
      });
      return;
    }

    // The variants that take the player as their first argument
    const command =
      action === 'clear'
        ? `/player effect clear ${playerName}`
        : `/player effect apply ${playerName} ${effect}`;
    const result = await dockerService.execCommand(command, req.serverId);

    if (result.success) {
      const effectDetails = action === 'clear' ? 'Cleared all effects' : `Applied ${effect}`;
      await logActivity(username, 'effect', 'player', true, playerName, effectDetails);
      commandDone(
        res,
        result,
        action === 'clear'
          ? `Cleared effects from ${playerName}`
          : `Applied ${effect} to ${playerName}`,
      );
    } else {
      await logActivity(username, 'effect', 'player', false, playerName, result.error);
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to apply effect',
      });
    }
  },
);

// POST /api/players/:name/inventory/clear
router.post(
  '/:name/inventory/clear',
  authMiddleware,
  requirePermission('players.clear_inventory'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Demo mode: simulate inventory clear
    if (isDemoMode()) {
      await logActivity(username, 'inventory_clear', 'player', true, playerName);
      res.json({
        success: true,
        message: `[Demo] Cleared ${playerName}'s inventory`,
      });
      return;
    }

    // Only the plugin can do this: the server's /inventory clear clears the
    // inventory of whoever runs it and takes no player, so there is no
    // console fallback.
    let error = 'Failed to clear inventory';
    try {
      const pluginResult = await kyuubiApi.clearInventoryViaPlugin(playerName, req.serverId);
      if (pluginResult.success) {
        await logActivity(username, 'inventory_clear', 'player', true, playerName);
        res.json({
          success: true,
          confirmed: true,
          message: `Cleared ${playerName}'s inventory`,
        });
        return;
      }
      if (pluginResult.maybeRan) return answerMaybeRan(res, playerName);
      if (pluginResult.error) error = pluginResult.error;
    } catch (err) {
      if (err instanceof Error) error = err.message;
    }

    await logActivity(username, 'inventory_clear', 'player', false, playerName, error);
    res.status(502).json({
      success: false,
      error: `${error}. Clearing another player's inventory needs the KyuubiSoft API plugin; Hytale has no console command for it.`,
    });
  },
);

// GET /api/players/statistics - Get player statistics
router.get(
  '/statistics',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const stats = await playersService.getPlayerStatistics(req.serverId);
    res.json(stats);
  },
);

// GET /api/players/activity - Get daily activity for charts
router.get(
  '/activity',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const days = parseInt(req.query.days as string) || 7;
    const activity = await playersService.getDailyActivity(days, req.serverId);
    res.json(activity);
  },
);

// ============== CHAT LOG ENDPOINTS ==============

// GET /api/players/chat - Get global chat log
router.get(
  '/chat',
  authMiddleware,
  requirePermission('chat.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const days = parseInt(req.query.days as string) || 7; // Default 7 days, 0 = all

    const result = await chatLog.getGlobalChatLog({ limit, offset, days }, req.serverId);
    res.json(result);
  },
);

// GET /api/players/:name/chat - Get chat log for specific player
router.get(
  '/:name/chat',
  authMiddleware,
  requirePermission('chat.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const days = parseInt(req.query.days as string) || 7; // Default 7 days, 0 = all

    const result = await chatLog.getPlayerChatLog(
      playerName,
      { limit, offset, days },
      req.serverId,
    );
    res.json(result);
  },
);

// ============== DEATH POSITION ENDPOINTS ==============

// GET /api/players/:name/deaths - Get death positions from player file
router.get(
  '/:name/deaths',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Get death positions directly from player JSON file
    const positions = await playersService.getPlayerDeathPositionsFromFile(
      playerName,
      req.serverId,
    );

    res.json({
      success: positions.length > 0,
      player: playerName,
      positions,
      count: positions.length,
    });
  },
);

// GET /api/players/:name/deaths/last - Get last death position for a player
router.get(
  '/:name/deaths/last',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Get death positions from file and return the last one (most recent)
    const positions = await playersService.getPlayerDeathPositionsFromFile(
      playerName,
      req.serverId,
    );

    if (positions.length > 0) {
      const lastPosition = positions[positions.length - 1];
      res.json({
        success: true,
        player: playerName,
        position: lastPosition,
      });
    } else {
      res.json({
        success: false,
        player: playerName,
        error: 'No death position recorded for this player',
      });
    }
  },
);

// POST /api/players/:name/teleport/death - Teleport player to a death position
// Body: { index?: number } - index of death position (default: last/most recent)
router.post(
  '/:name/teleport/death',
  authMiddleware,
  requirePermission('players.teleport'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const { index } = req.body;

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    // Get death positions from player file
    const positions = await playersService.getPlayerDeathPositionsFromFile(
      playerName,
      req.serverId,
    );

    if (positions.length === 0) {
      res.status(404).json({
        success: false,
        error: 'No death position recorded for this player',
      });
      return;
    }

    // Get the requested position (default: last/most recent)
    const posIndex =
      index !== undefined
        ? Math.min(Math.max(0, index), positions.length - 1)
        : positions.length - 1;
    const position = positions[posIndex];

    // Demo mode: simulate teleport to death
    if (isDemoMode()) {
      res.json({
        success: true,
        message: `[Demo] Teleported ${playerName} to death location (Day ${position.day}: ${position.position.x}, ${position.position.y}, ${position.position.z})`,
        position,
      });
      return;
    }

    // Teleport to death position
    const command = `/tp ${playerName} ${position.position.x} ${position.position.y} ${position.position.z}`;
    const result = await dockerService.execCommand(command, req.serverId);

    if (result.success) {
      res.json({
        success: true,
        message: `Teleported ${playerName} to death location (Day ${position.day}: ${position.position.x}, ${position.position.y}, ${position.position.z})`,
        position,
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to teleport player',
      });
    }
  },
);

// POST /api/players/:name/deaths - Manually record a death position (for testing/admin)
router.post(
  '/:name/deaths',
  authMiddleware,
  requirePermission('players.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;

    // SECURITY: Validate player name
    if (!validatePlayerName(res, playerName)) return;

    const { world, x, y, z } = req.body;

    if (!world || x === undefined || y === undefined || z === undefined) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: world, x, y, z',
      });
      return;
    }

    try {
      const position = await chatLog.recordDeathPosition(
        await resolveServerId(req.serverId),
        playerName,
        world,
        parseFloat(x),
        parseFloat(y),
        parseFloat(z),
      );

      res.json({
        success: true,
        message: `Death position recorded for ${playerName}`,
        position,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: 'Failed to record death position',
      });
    }
  },
);

// ============== PUNISHMENT HISTORY ==============

// GET /api/players/punishments - full, filterable history
router.get(
  '/punishments',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const player = typeof req.query.player === 'string' ? req.query.player : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const activeOnly = req.query.active === 'true';
    const limit = parseInt(req.query.limit as string) || 200;
    const serverId = await resolveServerId(req.serverId);
    res.json({
      punishments: punishments.listPunishments({ serverId, player, type, activeOnly, limit }),
    });
  },
);

// GET /api/players/:name/punishments - history for one player
router.get(
  '/:name/punishments',
  authMiddleware,
  requirePermission('players.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    if (!validatePlayerName(res, playerName)) return;
    const serverId = await resolveServerId(req.serverId);
    res.json({
      punishments: punishments.listPunishments({ serverId, player: playerName, limit: 200 }),
    });
  },
);

// GET /api/players/:name/notes - staff notes for one player
router.get(
  '/:name/notes',
  authMiddleware,
  requirePermission('players.view'),
  async (req: Request, res: Response) => {
    const playerName = req.params.name;
    if (!validatePlayerName(res, playerName)) return;
    const serverId = await resolveServerId(req.serverId);
    res.json({ notes: playerNotes.listServerNotes(serverId, playerName) });
  },
);

// POST /api/players/:name/notes  { note }
router.post(
  '/:name/notes',
  authMiddleware,
  requirePermission('players.kick'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';
    if (!validatePlayerName(res, playerName)) return;
    const note = sanitizeMessage(String((req.body as { note?: string }).note ?? ''), 500);
    if (!note) {
      res.status(400).json({ error: 'Note text required' });
      return;
    }
    const created = playerNotes.addNote({
      playerName,
      note,
      byUser: username,
      serverId: await resolveServerId(req.serverId),
    });
    await logActivity(username, 'note_add', 'player', true, playerName, note.slice(0, 80));
    res.json({ success: true, note: created });
  },
);

// DELETE /api/players/:name/notes/:id
router.delete(
  '/:name/notes/:id',
  authMiddleware,
  requirePermission('players.kick'),
  async (req: AuthenticatedRequest, res: Response) => {
    const username = req.user || 'system';
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const serverId = await resolveServerId(req.serverId);
    const ok = playerNotes.deleteNote(serverId, req.params.name, id);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Note not found' });
      return;
    }
    await logActivity(username, 'note_delete', 'player', true, req.params.name, `note #${id}`);
    res.json({ success: true });
  },
);

// POST /api/players/:name/tempban  { duration: "2h"|7200, reason? }
router.post(
  '/:name/tempban',
  authMiddleware,
  requirePermission('players.ban'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';
    if (!validatePlayerName(res, playerName)) return;

    const { duration, reason } = req.body as { duration?: string | number; reason?: string };
    const durationMs = punishments.parseDuration(duration);
    if (!durationMs) {
      res.status(400).json({ success: false, error: 'Valid duration required (e.g. 30m, 2h, 7d)' });
      return;
    }
    const safeReason = reason ? sanitizeMessage(reason, 100) : 'Temporarily banned';

    if (isDemoMode()) {
      const p = await punishments.recordPunishment({
        serverId: req.serverId,
        playerName,
        type: 'tempban',
        reason: safeReason,
        byUser: username,
        durationMs,
      });
      await logActivity(username, 'tempban', 'player', true, playerName, safeReason);
      res.json({
        success: true,
        message: `[Demo] Temp-banned ${playerName}`,
        expiresAt: p.expiresAt,
      });
      return;
    }

    // Hytale 0.7 has no temporary ban: the panel bans without end date and
    // lifts the ban itself when the time is up (punishments expiry loop). A
    // player who is banned already keeps that ban: an end date for it would
    // lift a permanent ban, so the panel refuses and records nothing.
    const until = new Date(Date.now() + durationMs).toISOString();
    await answerAccessChange(
      res,
      {
        user: username,
        action: 'tempban',
        player: playerName,
        details: `${safeReason} (until ${until})`,
        notRecorded:
          'Banned, but the panel could not record the end date: the ban stays until it is lifted by hand',
        unchanged: {
          code: 'already_banned',
          error: `${playerName} is banned already; a temporary ban would not end that ban. Unban first to set a new end date.`,
        },
      },
      () => banPlayer(req.serverId, playerName, safeReason),
      `Temp-banned ${playerName}`,
      async (outcome) => {
        await markOffline(req, playerName);
        const p = await punishments.recordPunishment({
          serverId: req.serverId,
          playerName,
          uuid: outcome.uuid,
          type: 'tempban',
          reason: safeReason,
          byUser: username,
          durationMs,
        });
        // The server's ban has no end date; the panel lifts it at expiresAt.
        return { expiresAt: p.expiresAt, liftedByPanel: true };
      },
    );
  }),
);

// POST /api/players/:name/mute  { duration?, reason? }  (duration omitted = permanent)
router.post(
  '/:name/mute',
  authMiddleware,
  requirePermission('players.ban'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    if (!validatePlayerName(res, playerName)) return;
    // No mute is recorded either: it would show a punishment that never applied.
    answerUnsupported(res, 'There is no chat mute');
  },
);

// DELETE /api/players/:name/mute  (unmute) - Hytale 0.7 has no mute; this only
// closes mute records an older panel version stored.
router.delete(
  '/:name/mute',
  authMiddleware,
  requirePermission('players.ban'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    const username = req.user || 'system';
    if (!validatePlayerName(res, playerName)) return;

    await punishments.deactivateActiveForPlayer(
      playerName,
      ['mute', 'tempmute'],
      username,
      req.serverId,
    );
    await logActivity(username, 'unmute', 'player', true, playerName);
    res.json({
      success: true,
      message: `Closed the panel's mute records for ${playerName} (Hytale 0.7 has no chat mute)`,
    });
  },
);

// ============== GDPR / DSGVO: data export & erasure ==============

/**
 * The records an export or erasure covers: those of the request's server, or
 * with `?allServers=true` those of every server, which only an account with
 * access to every server may ask for. Undefined when the request was refused.
 */
async function playerDataScope(
  req: AuthenticatedRequest,
  res: Response,
): Promise<PlayerDataScope | undefined> {
  if (req.query.allServers !== 'true') return resolveServerId(req.serverId);
  if ((await accessibleServerIds(req)) !== null) {
    res.status(403).json({
      error: 'Only accounts with access to every server may export or erase every server',
      code: ALL_SERVERS_REQUIRED,
    });
    return undefined;
  }
  return null;
}

const scopeLabel = (scope: PlayerDataScope) =>
  scope === null ? 'every server' : `server ${scope}`;

// GET /api/players/:name/export-data - download everything the panel stores
// about a player (notes, punishments, sessions, chat) on this server as a
// JSON file; ?allServers=true for every server. A right of its own: the
// export holds staff notes and punishments, players.view does not show those.
router.get(
  '/:name/export-data',
  authMiddleware,
  requirePermission('players.export_data'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    if (!validatePlayerName(res, playerName)) return;
    try {
      const scope = await playerDataScope(req, res);
      if (scope === undefined) return;
      const data = await exportPlayerData(playerName, scope);
      await logActivity(
        req.user || 'system',
        'export_player_data',
        'player',
        true,
        playerName,
        `Exported the player's data of ${scopeLabel(scope)}`,
      );
      res.setHeader('Content-Disposition', `attachment; filename="player-data-${playerName}.json"`);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error('[GDPR] export failed:', err);
      res.status(500).json({ error: 'Failed to export player data' });
    }
  },
);

// DELETE /api/players/:name/data - erase the panel's personal data for a player
// on this server (right to be forgotten); ?allServers=true for every server.
// A right of its own, so a moderator cannot erase the records of their own
// punishments. Punishments still in effect and the on-disk game save are kept.
router.delete(
  '/:name/data',
  authMiddleware,
  requirePermission('players.erase_data'),
  async (req: AuthenticatedRequest, res: Response) => {
    const playerName = req.params.name;
    if (!validatePlayerName(res, playerName)) return;
    try {
      const scope = await playerDataScope(req, res);
      if (scope === undefined) return;
      const result = await deletePlayerData(playerName, scope);
      await logActivity(
        req.user || 'system',
        'erase_player_data',
        'player',
        true,
        playerName,
        `${scopeLabel(scope)}: ${JSON.stringify({ ...result.deleted, kept: result.kept })}`,
      );
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error('[GDPR] erasure failed:', err);
      res.status(500).json({ success: false, error: 'Failed to erase player data' });
    }
  },
);

export default router;
