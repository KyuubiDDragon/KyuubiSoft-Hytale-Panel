// Whitelist, bans and permissions of the game server (Hytale 0.7). Live from
// the server while it runs (commands for changes), from its files while it is
// stopped; see services/accessContext.ts. Mounted under /api/management and
// /api/servers/:serverId/management with the same URLs as before 0.7 support.
import { Router, Response, type NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncRoute } from '../../utils/asyncRoute.js';
import { logActivity } from '../../services/activityLog.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import {
  isDemoMode,
  getDemoWhitelist,
  getDemoBans,
  getDemoPermissions,
} from '../../services/demoData.js';
import {
  describeAccessError,
  writeFilesOrCommand,
  type WriteOutcome,
} from '../../services/accessContext.js';
import {
  addToWhitelist,
  getWhitelist,
  removeFromWhitelist,
  setWhitelistEnabled,
} from '../../services/accessWhitelist.js';
import { banPlayer, getBans, unbanPlayer, type BanOutcome } from '../../services/accessBans.js';
import * as punishments from '../../services/punishments.js';
import type { PunishmentType } from '../../services/punishments.js';
import {
  deleteGroup,
  getPermissions,
  operatorRightNeeded,
  removeUserPermissions,
  saveGroup,
  setUserPermissions,
} from '../../services/accessPermissions.js';
import type { AccessChange } from '../../services/accessOperator.js';
import { isGroupNameInput, resolveGroupName } from '../../services/accessFormats.js';
import {
  getLastMigrationReport,
  installAccessMigrationHook,
  migrateAccessFiles,
  previewAccessMigration,
} from '../../services/accessMigration.js';

const router = Router();

// Old files are brought to the 0.7 form before every start through the panel.
installAccessMigrationHook();

const actor = (req: AuthenticatedRequest) => req.user || 'system';

// Giving out or taking away the server's own rights (its permissions or a
// wildcard over them, a group that carries them, the default group) is what
// /op does, so it also needs players.op, the right the op routes check.
// Decided against the server's current groups, see needsOperatorRight. A
// change to a player then goes to the UUID it was decided for (accessTarget).
function requireOpFor(changeOf: (req: AuthenticatedRequest) => AccessChange) {
  const op = requirePermission('players.op');
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (isDemoMode()) return next();
    let decision: Awaited<ReturnType<typeof operatorRightNeeded>>;
    try {
      decision = await operatorRightNeeded(req.serverId, changeOf(req));
    } catch (error) {
      sendError(res, error);
      return;
    }
    if (decision.uuid) res.locals.accessTarget = decision.uuid;
    if (decision.needed) await op(req, res, next);
    else next();
  };
}

/** The player a change goes to: the UUID requireOpFor decided for, else what was typed. */
const targetOf = (res: Response, typed: string): string =>
  typeof res.locals.accessTarget === 'string' ? res.locals.accessTarget : typed;

const userChange = (req: AuthenticatedRequest): AccessChange => {
  const body = req.body ?? {};
  return {
    kind: 'user',
    player: text(body.player) || text(body.uuid) || text(body.name),
    groups: body.groups,
    permissions: body.permissions,
  };
};

function sendError(res: Response, error: unknown) {
  const { status, error: message, code } = describeAccessError(error);
  if (status === 500) console.error('[Access] Request failed:', error);
  res.status(status).json({ success: false, error: message, code });
}

/** A change: 200 when the result was read back, 202 when it was only sent. */
function sendWrite<V extends object>(
  res: Response,
  outcome: WriteOutcome<V>,
  extra: { warning?: string } = {},
) {
  const { view, ...meta } = outcome;
  res.status(outcome.verified ? 200 : 202).json({ success: true, ...meta, ...view, ...extra });
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * Closes the panel's ban entries of the player after a ban change (see
 * punishments.closeBanRecords). The change itself happened, so a failure here
 * does not fail the answer; it carries a warning instead.
 */
async function closeBanRecords(
  req: AuthenticatedRequest,
  typed: string,
  outcome: BanOutcome,
  types: PunishmentType[],
): Promise<{ warning?: string }> {
  try {
    await punishments.closeBanRecords(
      { serverId: req.serverId, names: [typed, outcome.name], uuid: outcome.uuid },
      types,
      actor(req),
    );
    return {};
  } catch (error) {
    console.error(`[Access] Ban entries of ${typed} could not be closed:`, error);
    return {
      warning:
        'Done on the server, but the panel could not close its temporary bans of this player: one may still lift the ban when it ends. Check the punishments list.',
    };
  }
}

// ============== DEMO ==============

function demoWhitelist() {
  const { enabled, list } = getDemoWhitelist();
  return {
    enabled,
    list,
    entries: list.map((name) => ({ uuid: `demo-uuid-${name.toLowerCase()}`, name })),
    openGroups: ['hytale:Admin'],
    source: 'file',
    serverRunning: true,
    problems: [],
  };
}

function demoBans() {
  return {
    bans: getDemoBans().bans.map((b) => ({
      ...b,
      permanent: true,
      inEffect: true,
      readable: true,
    })),
    source: 'file',
    serverRunning: true,
    problems: [],
  };
}

function demoPermissions() {
  const demo = getDemoPermissions();
  return {
    users: demo.users.map((u) => ({
      uuid: `demo-uuid-${u.identifier.toLowerCase()}`,
      name: u.identifier,
      groups: [u.type],
      permissions: [],
      defaultGroup: false,
      joinGrant: false,
    })),
    groups: demo.groups.map((g) => ({
      name: g.name,
      permissions: g.permissions,
      builtinPermissions: [],
      effectivePermissions: g.permissions,
      builtin: false,
    })),
    defaultGroup: 'hytale:Adventurer',
    operatorGroup: 'hytale:Admin',
    source: 'file',
    serverRunning: true,
    problems: [],
  };
}

const demoWrite = (view: object) => ({
  success: true,
  via: 'demo',
  verified: true,
  changed: true,
  message: '[DEMO] Simulated',
  ...view,
});

// ============== WHITELIST ==============

// GET /api/management/whitelist
router.get(
  '/whitelist',
  authMiddleware,
  requirePermission('players.whitelist'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) return void res.json(demoWhitelist());
    try {
      res.json(await getWhitelist(req.serverId));
    } catch (error) {
      sendError(res, error);
    }
  }),
);

// PUT /api/management/whitelist/enabled  { enabled: boolean }
router.put(
  '/whitelist/enabled',
  authMiddleware,
  requirePermission('players.whitelist'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled must be a boolean' });
      return;
    }
    if (isDemoMode()) return void res.json(demoWrite({ ...demoWhitelist(), enabled }));
    try {
      const outcome = await setWhitelistEnabled(req.serverId, enabled);
      await logActivity(
        actor(req),
        'whitelist_toggle',
        'config',
        true,
        undefined,
        `${enabled ? 'Enabled' : 'Disabled'} whitelist (${outcome.via})`,
      );
      sendWrite(res, outcome);
    } catch (error) {
      await logActivity(
        actor(req),
        'whitelist_toggle',
        'config',
        false,
        undefined,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

// POST /api/management/whitelist/add  { player: name or UUID }
router.post(
  '/whitelist/add',
  authMiddleware,
  requirePermission('players.whitelist'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const player = text(req.body?.player);
    if (!player) {
      res.status(400).json({ success: false, error: 'player name or UUID required' });
      return;
    }
    if (isDemoMode()) {
      const view = demoWhitelist();
      return void res.json(demoWrite({ ...view, list: [...view.list, player] }));
    }
    try {
      const outcome = await addToWhitelist(req.serverId, player);
      await logActivity(actor(req), 'whitelist_add', 'player', true, player, outcome.via);
      sendWrite(res, outcome);
    } catch (error) {
      await logActivity(
        actor(req),
        'whitelist_add',
        'player',
        false,
        player,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

// DELETE /api/management/whitelist/:player  (name or UUID)
router.delete(
  '/whitelist/:player',
  authMiddleware,
  requirePermission('players.whitelist'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const player = text(req.params.player);
    if (isDemoMode()) {
      const view = demoWhitelist();
      return void res.json(demoWrite({ ...view, list: view.list.filter((p) => p !== player) }));
    }
    try {
      const outcome = await removeFromWhitelist(req.serverId, player);
      await logActivity(actor(req), 'whitelist_remove', 'player', true, player, outcome.via);
      sendWrite(res, outcome);
    } catch (error) {
      await logActivity(
        actor(req),
        'whitelist_remove',
        'player',
        false,
        player,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

// ============== BANS ==============

// GET /api/management/bans
router.get(
  '/bans',
  authMiddleware,
  requirePermission('players.ban'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) return void res.json(demoBans());
    try {
      res.json(await getBans(req.serverId));
    } catch (error) {
      sendError(res, error);
    }
  }),
);

// POST /api/management/bans/add  { player: name or UUID, reason? }
router.post(
  '/bans/add',
  authMiddleware,
  requirePermission('players.ban'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const player = text(req.body?.player);
    if (!player) {
      res.status(400).json({ success: false, error: 'player name or UUID required' });
      return;
    }
    if (isDemoMode()) return void res.json(demoWrite(demoBans()));
    try {
      const outcome = await banPlayer(req.serverId, player, req.body?.reason);
      // A permanent ban: a temp-ban the panel runs on the player must not lift it later.
      const closed = await closeBanRecords(req, player, outcome, ['tempban']);
      await logActivity(
        actor(req),
        'ban',
        'player',
        true,
        player,
        typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : undefined,
      );
      sendWrite(res, outcome, closed);
    } catch (error) {
      await logActivity(
        actor(req),
        'ban',
        'player',
        false,
        player,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

// DELETE /api/management/bans/:player  (name or UUID)
router.delete(
  '/bans/:player',
  authMiddleware,
  requirePermission('players.unban'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const player = text(req.params.player);
    if (isDemoMode()) return void res.json(demoWrite(demoBans()));
    try {
      const outcome = await unbanPlayer(req.serverId, player);
      // An entry left open does no harm here: its end finds no ban of its own to lift.
      await closeBanRecords(req, player, outcome, ['ban', 'tempban']);
      await logActivity(actor(req), 'unban', 'player', true, player, outcome.via);
      sendWrite(res, outcome);
    } catch (error) {
      await logActivity(
        actor(req),
        'unban',
        'player',
        false,
        player,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

// ============== PERMISSIONS ==============

// GET /api/management/permissions
router.get(
  '/permissions',
  authMiddleware,
  requirePermission('players.permissions'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) return void res.json(demoPermissions());
    try {
      res.json(await getPermissions(req.serverId));
    } catch (error) {
      sendError(res, error);
    }
  }),
);

// POST /api/management/permissions/users
//   { player | uuid | name, groups?: string[], permissions?: string[] }
router.post(
  '/permissions/users',
  authMiddleware,
  requirePermission('players.permissions'),
  requireOpFor(userChange),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body ?? {};
    const player = text(body.player) || text(body.uuid) || text(body.name);
    if (!player) {
      res.status(400).json({ success: false, error: 'player name or UUID required' });
      return;
    }
    if (isDemoMode()) return void res.json(demoWrite(demoPermissions()));
    try {
      const outcome = await setUserPermissions(req.serverId, {
        player: targetOf(res, player),
        groups: body.groups,
        permissions: body.permissions,
      });
      await logActivity(
        actor(req),
        'permissions_user_update',
        'user',
        true,
        player,
        Array.isArray(body.groups) ? `Groups: ${body.groups.join(', ') || 'default'}` : undefined,
      );
      sendWrite(res, outcome);
    } catch (error) {
      await logActivity(
        actor(req),
        'permissions_user_update',
        'user',
        false,
        player,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

// DELETE /api/management/permissions/users/:identifier  (name or UUID; the join permission stays)
router.delete(
  '/permissions/users/:identifier',
  authMiddleware,
  requirePermission('players.permissions'),
  requireOpFor((req) => ({ kind: 'removeUser', player: text(req.params.identifier) })),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const player = text(req.params.identifier);
    if (isDemoMode()) return void res.json(demoWrite(demoPermissions()));
    try {
      const outcome = await removeUserPermissions(req.serverId, targetOf(res, player));
      await logActivity(actor(req), 'permissions_user_remove', 'user', true, player, outcome.via);
      sendWrite(res, outcome);
    } catch (error) {
      await logActivity(
        actor(req),
        'permissions_user_remove',
        'user',
        false,
        player,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

/**
 * The parent a group change asks for, read once for the check and the change:
 * undefined keeps it, null (or '') removes it. `inherits: [name]` from older
 * clients counts only when `parent` is not sent at all.
 */
function bodyParent(body: { parent?: unknown; inherits?: unknown }): unknown {
  if (body.parent !== undefined) return body.parent;
  return Array.isArray(body.inherits) ? (body.inherits[0] ?? null) : undefined;
}

const groupNameOf = (value: unknown) =>
  typeof value === 'string' ? resolveGroupName(value.trim()) : '';

/**
 * Refuses a group name (and parent) the change would refuse, before the
 * operator check: both then look at the same valid name.
 */
function requireGroupInput(nameOf: (req: AuthenticatedRequest) => unknown, withParent = false) {
  const refuse = (res: Response, error: string) =>
    res.status(400).json({ success: false, error, code: 'invalid_input' });
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!isGroupNameInput(groupNameOf(nameOf(req)))) {
      return void refuse(
        res,
        'A group name needs letters or digits first, then letters, digits, _, - or :, at most 64 characters',
      );
    }
    if (withParent) {
      const body = req.body ?? {};
      if (body.parent === undefined && Array.isArray(body.inherits) && body.inherits.length > 1) {
        return void refuse(res, 'A group inherits from one group only');
      }
      const parent = bodyParent(body);
      const valid =
        parent === undefined ||
        parent === null ||
        parent === '' ||
        (typeof parent === 'string' && isGroupNameInput(groupNameOf(parent)));
      if (!valid) return void refuse(res, 'parent must be a group name');
    }
    next();
  };
}

// POST /api/management/permissions/groups  { name, permissions: string[], parent?: string | null }
// (`inherits: [name]` from older clients is read as the parent)
router.post(
  '/permissions/groups',
  authMiddleware,
  requirePermission('players.permissions'),
  requireGroupInput((req) => req.body?.name, true),
  requireOpFor((req) => ({
    kind: 'group',
    name: req.body?.name,
    permissions: req.body?.permissions,
    parent: bodyParent(req.body ?? {}),
  })),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body ?? {};
    const name = text(body.name);
    if (isDemoMode()) return void res.json(demoWrite(demoPermissions()));
    try {
      const outcome = await saveGroup(req.serverId, {
        name,
        permissions: body.permissions ?? [],
        parent: bodyParent(body),
      });
      await logActivity(
        actor(req),
        'permissions_group_update',
        'user',
        true,
        name,
        `Permissions: ${Array.isArray(body.permissions) ? body.permissions.length : 0} entries`,
      );
      sendWrite(res, outcome);
    } catch (error) {
      await logActivity(
        actor(req),
        'permissions_group_update',
        'user',
        false,
        name,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

// DELETE /api/management/permissions/groups/:name
router.delete(
  '/permissions/groups/:name',
  authMiddleware,
  requirePermission('players.permissions'),
  requireGroupInput((req) => req.params.name),
  requireOpFor((req) => ({ kind: 'deleteGroup', name: req.params.name })),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const name = text(req.params.name);
    if (isDemoMode()) return void res.json(demoWrite(demoPermissions()));
    try {
      const outcome = await deleteGroup(req.serverId, name);
      await logActivity(actor(req), 'permissions_group_remove', 'user', true, name, outcome.via);
      sendWrite(res, outcome);
    } catch (error) {
      await logActivity(
        actor(req),
        'permissions_group_remove',
        'user',
        false,
        name,
        describeAccessError(error).error,
      );
      sendError(res, error);
    }
  }),
);

// ============== MIGRATION OF OLD FILES ==============

// GET /api/management/access/migration - what would change, and the last run
router.get(
  '/access/migration',
  authMiddleware,
  requirePermission('players.permissions'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) return void res.json({ needed: false, items: [], lastReport: null });
    try {
      const preview = await previewAccessMigration(req.serverId);
      res.json({ ...preview, lastReport: await getLastMigrationReport(req.serverId) });
    } catch (error) {
      sendError(res, error);
    }
  }),
);

// POST /api/management/access/migrate - run it now (files that need a stopped
// server wait for the next start while the server runs)
router.post(
  '/access/migrate',
  authMiddleware,
  requirePermission('players.permissions', 'players.whitelist'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) return void res.json({ success: true, report: null });
    try {
      const report = await writeFilesOrCommand(
        req.serverId,
        async () => migrateAccessFiles(req.serverId, { serverStopped: true }),
        async () => migrateAccessFiles(req.serverId, { serverStopped: false }),
      );
      res.json({ success: report.errors.length === 0, report });
    } catch (error) {
      sendError(res, error);
    }
  }),
);

export default router;
