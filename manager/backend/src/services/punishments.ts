/**
 * Punishment history.
 *
 * A durable record of moderation actions (ban / tempban / kick / mute /
 * tempmute / warn) in SQLite, replacing the ad-hoc bans-names.json mapping.
 * Temp punishments carry an expiry; a background loop lifts them automatically
 * (issuing /unban or /unmute) when they lapse and marks them inactive.
 */
import { getDb } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { publish } from './eventBus.js';

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
  const m = String(input).trim().match(/^(\d+)\s*([smhdw]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 's').toLowerCase();
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * (mult[unit] ?? 1000);
}

export function recordPunishment(opts: {
  serverId?: string;
  playerName: string;
  uuid?: string | null;
  type: PunishmentType;
  reason?: string | null;
  byUser: string;
  durationMs?: number | null;
}): Punishment {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = opts.durationMs && opts.durationMs > 0 ? new Date(now + opts.durationMs).toISOString() : null;
  const active = STATEFUL.has(opts.type) ? 1 : 0;
  const info = getDb().prepare(`
    INSERT INTO punishments (server_id, player_name, uuid, type, reason, by_user, created_at, expires_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(opts.serverId ?? null, opts.playerName, opts.uuid ?? null, opts.type, opts.reason ?? null, opts.byUser, createdAt, expiresAt, active);
  return getPunishment(Number(info.lastInsertRowid))!;
}

export function getPunishment(id: number): Punishment | null {
  const row = getDb().prepare('SELECT * FROM punishments WHERE id = ?').get(id) as PunishmentRow | undefined;
  return row ? rowToPunishment(row) : null;
}

export function listPunishments(opts: { player?: string; type?: string; activeOnly?: boolean; limit?: number } = {}): Punishment[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.player) { where.push('player_name = ? COLLATE NOCASE'); params.push(opts.player); }
  if (opts.type) { where.push('type = ?'); params.push(opts.type); }
  if (opts.activeOnly) { where.push('active = 1'); }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const sql = `SELECT * FROM punishments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  const rows = getDb().prepare(sql).all(...params, limit) as PunishmentRow[];
  return rows.map(rowToPunishment);
}

export function getActivePunishments(playerName: string): Punishment[] {
  return listPunishments({ player: playerName, activeOnly: true });
}

/** Manually lift a punishment (e.g. on unban). Returns true if a row changed. */
export function revokePunishment(id: number, byUser: string): boolean {
  const info = getDb().prepare(
    'UPDATE punishments SET active = 0, revoked_at = ?, revoked_by = ? WHERE id = ? AND active = 1',
  ).run(new Date().toISOString(), byUser, id);
  return info.changes > 0;
}

/** Lift all active stateful punishments for a player (used on a manual /unban). */
export function deactivateActiveForPlayer(playerName: string, type: PunishmentType | PunishmentType[], byUser: string): number {
  const types = Array.isArray(type) ? type : [type];
  const placeholders = types.map(() => '?').join(',');
  const info = getDb().prepare(
    `UPDATE punishments SET active = 0, revoked_at = ?, revoked_by = ?
     WHERE active = 1 AND player_name = ? COLLATE NOCASE AND type IN (${placeholders})`,
  ).run(new Date().toISOString(), byUser, playerName, ...types);
  return info.changes;
}

/**
 * Mark all due temp punishments inactive and return them so the caller can
 * issue the matching un-command. Atomic per row via the active=1 guard.
 */
function consumeDuePunishments(): Punishment[] {
  const now = new Date().toISOString();
  const due = getDb().prepare(
    "SELECT * FROM punishments WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
  ).all(now) as PunishmentRow[];
  const lifted: Punishment[] = [];
  const upd = getDb().prepare("UPDATE punishments SET active = 0, revoked_at = ?, revoked_by = 'system:expiry' WHERE id = ? AND active = 1");
  for (const row of due) {
    if (upd.run(now, row.id).changes > 0) lifted.push(rowToPunishment(row));
  }
  return lifted;
}

let expiryTimer: NodeJS.Timeout | null = null;

/**
 * Background loop: every minute, lift expired temp bans/mutes by issuing the
 * matching un-command and emitting an event. `execCommand` is imported lazily
 * to avoid a module cycle (docker → players → … ).
 */
export function startPunishmentExpiry(): void {
  if (expiryTimer) return;
  const run = async (): Promise<void> => {
    let lifted: Punishment[];
    try {
      lifted = consumeDuePunishments();
    } catch (err) {
      logger.error('[Punishments] expiry query failed:', err);
      return;
    }
    if (lifted.length === 0) return;
    const { execCommand } = await import('./docker.js');
    for (const p of lifted) {
      const cmd = (p.type === 'tempban') ? `/unban ${p.playerName}`
        : (p.type === 'tempmute') ? `/unmute ${p.playerName}`
        : null;
      if (cmd) {
        try { await execCommand(cmd, p.serverId ?? undefined); } catch (err) {
          logger.warn(`[Punishments] failed to lift ${p.type} for ${p.playerName}: ${err instanceof Error ? err.message : err}`);
        }
      }
      publish('player.banned', { player: p.playerName, action: 'expired', punishmentType: p.type, expired: true }, p.serverId ?? undefined);
      logger.info(`[Punishments] ${p.type} expired for ${p.playerName} — lifted`);
    }
  };
  expiryTimer = setInterval(() => { void run(); }, 60_000);
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
