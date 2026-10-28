/**
 * Punishment history.
 *
 * A durable record of moderation actions (ban / tempban / kick / mute /
 * tempmute / warn) in SQLite, replacing the ad-hoc bans-names.json mapping.
 * Temp punishments carry an expiry; a background loop lifts them automatically
 * (issuing /unban or /unmute) when they lapse and marks them inactive.
 *
 * Every entry belongs to one server: new entries store the resolved id (the
 * default server for callers without one), and lists, unbans and unmutes only
 * touch entries of the server they are for. Entries from before per-server
 * punishments were assigned to the compose server by a database migration.
 */
import { getDb } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { publish } from './eventBus.js';
import { resolveServerId } from './servers.js';

export type PunishmentType = 'ban' | 'tempban' | 'kick' | 'mute' | 'tempmute' | 'warn';

export interface Punishment {
  id: number;
  serverId: string | null;
  playerName: string;
  uuid: string | null;
  type: PunishmentType;
  reason: string | null;
  byUser: string;
  createdAt: string;
  expiresAt: string | null;
  active: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
}

interface PunishmentRow {
  id: number;
  server_id: string | null;
  player_name: string;
  uuid: string | null;
  type: string;
  reason: string | null;
  by_user: string;
  created_at: string;
  expires_at: string | null;
  active: number;
  revoked_at: string | null;
  revoked_by: string | null;
}

function rowToPunishment(r: PunishmentRow): Punishment {
  return {
    id: r.id,
    serverId: r.server_id,
    playerName: r.player_name,
    uuid: r.uuid,
    type: r.type as PunishmentType,
    reason: r.reason,
    byUser: r.by_user,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    active: r.active === 1,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
  };
}

// Types that remain "in effect" until lifted (vs. point-in-time kick/warn).
const STATEFUL = new Set<PunishmentType>(['ban', 'tempban', 'mute', 'tempmute']);

/**
 * Parse a human duration ("30m", "2h", "7d", "90s", or a bare number = seconds)
 * to milliseconds. Returns null for permanent / unparseable.
 */
export function parseDuration(input: string | number | undefined | null): number | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input === 'number') return input > 0 ? input * 1000 : null;
  const m = String(input)
    .trim()
    .match(/^(\d+)\s*([smhdw]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 's').toLowerCase();
  const mult: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * (mult[unit] ?? 1000);
}

/** Records a punishment on a server; `serverId` undefined is the default server. */
export async function recordPunishment(opts: {
  serverId?: string;
  playerName: string;
  uuid?: string | null;
  type: PunishmentType;
  reason?: string | null;
  byUser: string;
  durationMs?: number | null;
}): Promise<Punishment> {
  const serverId = await resolveServerId(opts.serverId);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt =
    opts.durationMs && opts.durationMs > 0 ? new Date(now + opts.durationMs).toISOString() : null;
  const active = STATEFUL.has(opts.type) ? 1 : 0;
  const info = getDb()
    .prepare(
      `
    INSERT INTO punishments (server_id, player_name, uuid, type, reason, by_user, created_at, expires_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      serverId,
      opts.playerName,
      opts.uuid ?? null,
      opts.type,
      opts.reason ?? null,
      opts.byUser,
      createdAt,
      expiresAt,
      active,
    );
  return getPunishment(Number(info.lastInsertRowid))!;
}

export function getPunishment(id: number): Punishment | null {
  const row = getDb().prepare('SELECT * FROM punishments WHERE id = ?').get(id) as
    PunishmentRow | undefined;
  return row ? rowToPunishment(row) : null;
}

/**
 * Punishments, newest first. With `serverId` only that server's entries;
 * without it every server's (data export).
 */
export function listPunishments(
  opts: {
    serverId?: string;
    player?: string;
    type?: string;
    activeOnly?: boolean;
    limit?: number;
  } = {},
): Punishment[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.serverId) {
    where.push('server_id = ?');
    params.push(opts.serverId);
  }
  if (opts.player) {
    where.push('player_name = ? COLLATE NOCASE');
    params.push(opts.player);
  }
  if (opts.type) {
    where.push('type = ?');
    params.push(opts.type);
  }
  if (opts.activeOnly) {
    where.push('active = 1');
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const sql = `SELECT * FROM punishments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  const rows = getDb()
    .prepare(sql)
    .all(...params, limit) as PunishmentRow[];
  return rows.map(rowToPunishment);
}

export function getActivePunishments(playerName: string, serverId: string): Punishment[] {
  return listPunishments({ serverId, player: playerName, activeOnly: true });
}

/** Manually lift a punishment (e.g. on unban). Returns true if a row changed. */
export function revokePunishment(id: number, byUser: string): boolean {
  const info = getDb()
    .prepare(
      'UPDATE punishments SET active = 0, revoked_at = ?, revoked_by = ? WHERE id = ? AND active = 1',
    )
    .run(new Date().toISOString(), byUser, id);
  return info.changes > 0;
}

/**
 * Closes a player's open entries of `types` on one server, matched by UUID or
 * by any of the names: after an unban, or after a permanent ban (then only
 * the temp-bans), so the expiry loop does not lift that ban later.
 */
export async function closeBanRecords(
  target: { serverId?: string; names: readonly (string | undefined)[]; uuid?: string | null },
  types: PunishmentType[],
  byUser: string,
): Promise<number> {
  const names = [...new Set(target.names.filter((n): n is string => !!n))];
  const uuid = target.uuid?.toLowerCase() ?? null;
  if (names.length === 0 && !uuid) return 0;
  const who = [
    ...names.map(() => 'player_name = ? COLLATE NOCASE'),
    ...(uuid ? ['lower(uuid) = ?'] : []),
  ].join(' OR ');
  const server = await resolveServerId(target.serverId);
  const rows = getDb()
    .prepare(
      `SELECT id FROM punishments
     WHERE active = 1 AND server_id = ? AND type IN (${types.map(() => '?').join(',')}) AND (${who})`,
    )
    .all(server, ...types, ...names, ...(uuid ? [uuid] : [])) as { id: number }[];
  let closed = 0;
  for (const row of rows) {
    if (revokePunishment(row.id, byUser)) closed++;
  }
  return closed;
}

/**
 * Lift a player's active stateful punishments of `type` on one server (used
 * to close old mute records); `serverId` undefined is the default server.
 */
export async function deactivateActiveForPlayer(
  playerName: string,
  type: PunishmentType | PunishmentType[],
  byUser: string,
  serverId?: string,
): Promise<number> {
  const server = await resolveServerId(serverId);
  const types = Array.isArray(type) ? type : [type];
  const placeholders = types.map(() => '?').join(',');
  const info = getDb()
    .prepare(
      `UPDATE punishments SET active = 0, revoked_at = ?, revoked_by = ?
     WHERE active = 1 AND server_id = ? AND player_name = ? COLLATE NOCASE AND type IN (${placeholders})`,
    )
    .run(new Date().toISOString(), byUser, server, playerName, ...types);
  return info.changes;
}

/**
 * Mark all due temp punishments inactive and return them so the caller can
 * issue the matching un-command. Atomic per row via the active=1 guard.
 */
function consumeDuePunishments(): Punishment[] {
  const now = new Date().toISOString();
  const due = getDb()
    .prepare(
      'SELECT * FROM punishments WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?',
    )
    .all(now) as PunishmentRow[];
  const lifted: Punishment[] = [];
  const upd = getDb().prepare(
    "UPDATE punishments SET active = 0, revoked_at = ?, revoked_by = 'system:expiry' WHERE id = ? AND active = 1",
  );
  for (const row of due) {
    // A lift that failed waits for its next try.
    if ((liftRetries.get(row.id)?.nextAt ?? 0) > Date.now()) continue;
    if (upd.run(now, row.id).changes > 0) lifted.push(rowToPunishment(row));
  }
  return lifted;
}

// Lifts that did not go through yet, by entry: tried again after a growing
// pause. Kept in memory; after a panel restart the next run tries at once.
const liftRetries = new Map<number, { attempts: number; nextAt: number }>();
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

/** Puts the next try off (1, 2, 4, ... minutes, at most an hour); returns the failures so far. */
function deferLift(id: number): { attempts: number; minutes: number } {
  const attempts = (liftRetries.get(id)?.attempts ?? 0) + 1;
  const delay = Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
  liftRetries.set(id, { attempts, nextAt: Date.now() + delay });
  return { attempts, minutes: Math.round(delay / 60_000) };
}

/** Logs the 1st, 2nd, 4th, 8th, ... failure only. */
const worthLogging = (attempts: number) => (attempts & (attempts - 1)) === 0;

/**
 * Undo consumeDuePunishments for one row: `retry` keeps the end date, so the
 * next run tries again; otherwise the ban stays without one (as it does on
 * the server) until someone lifts it.
 */
function reactivatePunishment(id: number, retry: boolean): void {
  getDb()
    .prepare(
      `UPDATE punishments SET active = 1, revoked_at = NULL, revoked_by = NULL${retry ? '' : ', expires_at = NULL'}
     WHERE id = ? AND revoked_by = 'system:expiry'`,
    )
    .run(id);
}

/** Keeps an entry whose lift did not go through open, with its end date, for a later try. */
function retryLift(p: Punishment, why: string): void {
  reactivatePunishment(p.id, true);
  const { attempts, minutes } = deferLift(p.id);
  if (!worthLogging(attempts)) return;
  logger.warn(
    `[Punishments] could not lift the tempban of ${p.playerName} yet (${why}); trying again in ${minutes} min (attempt ${attempts})`,
  );
}

let expiryTimer: NodeJS.Timeout | null = null;
let expiryRunning = false;

// Lift failures that can pass: the server or Docker cannot be reached, a
// start/stop is under way, or the running server refused the unban (one that
// is not signed in finds no offline player; stopped, the panel lifts it in the
// file). Anything else (an unknown player, a broken bans.json) would only fail again.
const RETRY_LIFT_CODES = new Set(['unreachable', 'docker_unavailable', 'busy', 'rejected']);

// How far the server's ban may lie from a temp-ban entry and still be the ban
// the panel issued for it: the entry is written right after that ban went
// through, so the server's time is a little earlier, never later.
const OWN_BAN_BEFORE_MS = 5 * 60_000;
const OWN_BAN_AFTER_MS = 5_000;

/** Whether a ban the server has (banned at `bannedAt`) is the one temp-ban `p` was recorded for. */
export function isOwnBan(p: Pick<Punishment, 'createdAt'>, bannedAt: string | undefined): boolean {
  const at = bannedAt ? Date.parse(bannedAt) : NaN;
  const recorded = Date.parse(p.createdAt);
  return (
    Number.isFinite(at) && at >= recorded - OWN_BAN_BEFORE_MS && at <= recorded + OWN_BAN_AFTER_MS
  );
}

/**
 * Lifts the ban behind an expired temp-ban, by UUID, but only while it is
 * still that ban: one lifted meanwhile is left alone ('gone'), and so is a
 * ban issued since (a permanent one, or a new ban after an unban: 'replaced').
 * An unban the server did not confirm (over the console) counts only once the
 * ban is gone; otherwise it is 'unconfirmed' and tried again.
 */
async function liftTempban(p: Punishment): Promise<'lifted' | 'gone' | 'replaced' | 'unconfirmed'> {
  const { currentBan, unbanPlayer } = await import('./accessBans.js');
  const serverId = p.serverId ?? undefined;
  const ban = await currentBan(serverId, p.uuid ?? p.playerName);
  if (!ban) return 'gone';
  if (!isOwnBan(p, ban.bannedAt)) return 'replaced';
  const outcome = await unbanPlayer(serverId, ban.target);
  if (outcome.verified) return 'lifted';
  return (await currentBan(serverId, ban.target)) ? 'unconfirmed' : 'lifted';
}

/**
 * Background loop: every minute, lift expired temp bans and emit an event.
 * Hytale 0.7 bans have no end date, so the panel lifts them itself (by UUID
 * while the server runs, in bans.json while it is stopped), and only while
 * the server's ban is still the one the panel issued. A lift that fails for
 * a reason that can pass (server unreachable, busy, refused, or an unban the
 * server did not confirm) keeps the entry with its end date and is tried
 * again after a growing pause; otherwise the ban stays and the error is
 * logged. Expired temp mutes
 * (recorded by older panel versions, 0.7 has no mute) are only closed. The
 * access services are imported lazily to avoid a module cycle.
 */
export function startPunishmentExpiry(): void {
  if (expiryTimer) return;
  const run = async (): Promise<void> => {
    // A lift can wait on the server; the next tick must not start a second run.
    if (expiryRunning) return;
    expiryRunning = true;
    try {
      await liftDue();
    } finally {
      expiryRunning = false;
    }
  };
  const liftDue = async (): Promise<void> => {
    let lifted: Punishment[];
    try {
      lifted = consumeDuePunishments();
    } catch (err) {
      logger.error('[Punishments] expiry query failed:', err);
      return;
    }
    if (lifted.length === 0) return;
    const { describeAccessError } = await import('./accessContext.js');
    for (const p of lifted) {
      if (p.type === 'tempban') {
        let result: Awaited<ReturnType<typeof liftTempban>>;
        try {
          result = await liftTempban(p);
        } catch (err) {
          const { error, code } = describeAccessError(err);
          if (RETRY_LIFT_CODES.has(code)) {
            retryLift(p, error);
          } else {
            liftRetries.delete(p.id);
            reactivatePunishment(p.id, false);
            logger.error(
              `[Punishments] could not lift the tempban of ${p.playerName}: ${error}. The ban stays until it is lifted by hand.`,
            );
          }
          continue;
        }
        if (result === 'unconfirmed') {
          retryLift(p, 'the server did not confirm the unban');
          continue;
        }
        liftRetries.delete(p.id);
        if (result !== 'lifted') {
          logger.warn(
            result === 'gone'
              ? `[Punishments] tempban of ${p.playerName} ended; it had already been lifted`
              : `[Punishments] tempban of ${p.playerName} ended, but the player was banned again since; that ban stays`,
          );
          continue;
        }
      }
      publish(
        'player.banned',
        { player: p.playerName, action: 'expired', punishmentType: p.type, expired: true },
        p.serverId ?? undefined,
      );
      logger.info(`[Punishments] ${p.type} expired for ${p.playerName} — lifted`);
    }
  };
  expiryTimer = setInterval(() => {
    void run();
  }, 60_000);
  expiryTimer.unref?.();
  void run(); // catch ones already due at boot
  logger.info('[Punishments] expiry loop started');
}

export function stopPunishmentExpiry(): void {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}
