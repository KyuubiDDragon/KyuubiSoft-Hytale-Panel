/**
 * Playtime / session tracking.
 *
 * Subscribes to player_join / player_leave on the eventBus (republished from the
 * KyuubiSoft plugin by services/pluginEvents.ts) and records each play session
 * in the `play_sessions` table, from which we derive per-player totals and a
 * leaderboard. Open sessions (player currently online) count their live time.
 */
import { getDb } from '../db/index.js';
import { eventBus, type PanelEvent } from './eventBus.js';

interface JoinLeavePayload {
  player?: string;
  uuid?: string;
  serverId?: string;
}

const nowIso = (): string => new Date().toISOString();

/** Close the latest still-open session for a player, stamping its duration. */
function closeOpenFor(uuid: string): void {
  const db = getDb();
  const sess = db
    .prepare('SELECT id, joined_at FROM play_sessions WHERE uuid = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1')
    .get(uuid) as { id: number; joined_at: string } | undefined;
  if (!sess) return;
  const joined = Date.parse(sess.joined_at);
  const dur = Number.isFinite(joined) ? Math.max(0, Date.now() - joined) : 0;
  db.prepare('UPDATE play_sessions SET left_at = ?, duration_ms = ? WHERE id = ?').run(nowIso(), dur, sess.id);
}

/** On startup, close any sessions orphaned by a panel/server restart. */
function closeAllOpen(): void {
  const db = getDb();
  const open = db.prepare('SELECT uuid FROM play_sessions WHERE left_at IS NULL').all() as Array<{ uuid: string }>;
  for (const o of open) closeOpenFor(o.uuid);
}

function onJoin(p: JoinLeavePayload): void {
  const uuid = String(p.uuid ?? p.player ?? '').trim();
  if (!uuid) return;
  closeOpenFor(uuid); // defensive: never leave two sessions open for one player
  getDb()
    .prepare('INSERT INTO play_sessions (server_id, uuid, player_name, joined_at) VALUES (?, ?, ?, ?)')
    .run(p.serverId ?? null, uuid, String(p.player ?? uuid), nowIso());
}

function onLeave(p: JoinLeavePayload): void {
  const uuid = String(p.uuid ?? p.player ?? '').trim();
  if (uuid) closeOpenFor(uuid);
}

let started = false;
export function startPlaytimeTracking(): void {
  if (started) return;
  started = true;
  try { closeAllOpen(); } catch (e) { console.error('[playtime] startup cleanup failed', e); }
  eventBus.subscribe(['player_join'], (evt: PanelEvent) => {
    try { onJoin(evt.payload as JoinLeavePayload); } catch (e) { console.error('[playtime] join error', e); }
  });
  eventBus.subscribe(['player_leave'], (evt: PanelEvent) => {
    try { onLeave(evt.payload as JoinLeavePayload); } catch (e) { console.error('[playtime] leave error', e); }
  });
  console.log('[playtime] tracking started');
}

export interface PlaytimeEntry {
  uuid: string;
  playerName: string;
  totalMs: number;
  sessions: number;
  lastSeen: string | null;
  online: boolean;
}

export function getLeaderboard(serverId?: string, limit = 50): PlaytimeEntry[] {
  const db = getDb();
  const filter = serverId ? 'WHERE server_id = ?' : '';
  const params = serverId ? [serverId] : [];

  const rows = db
    .prepare(
      `SELECT uuid,
              SUM(COALESCE(duration_ms, 0)) AS closedMs,
              COUNT(*) AS sessions,
              MAX(left_at) AS lastLeft
         FROM play_sessions ${filter}
        GROUP BY uuid`,
    )
    .all(...params) as Array<{ uuid: string; closedMs: number; sessions: number; lastLeft: string | null }>;

  const openRows = db
    .prepare(`SELECT uuid, player_name, joined_at FROM play_sessions WHERE left_at IS NULL ${serverId ? 'AND server_id = ?' : ''}`)
    .all(...params) as Array<{ uuid: string; player_name: string; joined_at: string }>;
  const now = Date.now();
  const openByUuid = new Map<string, number>();
  for (const o of openRows) {
    const j = Date.parse(o.joined_at);
    openByUuid.set(o.uuid, Number.isFinite(j) ? Math.max(0, now - j) : 0);
  }

  // Most recent display name per uuid (names can change over time).
  const nameRows = db
    .prepare(
      `SELECT uuid, player_name FROM play_sessions p
        WHERE joined_at = (SELECT MAX(joined_at) FROM play_sessions WHERE uuid = p.uuid)`,
    )
    .all() as Array<{ uuid: string; player_name: string }>;
  const nameByUuid = new Map(nameRows.map((r) => [r.uuid, r.player_name]));

  const entries: PlaytimeEntry[] = rows.map((r) => {
    const liveMs = openByUuid.get(r.uuid);
    return {
      uuid: r.uuid,
      playerName: nameByUuid.get(r.uuid) ?? r.uuid,
      totalMs: r.closedMs + (liveMs ?? 0),
      sessions: r.sessions,
      lastSeen: liveMs !== undefined ? null : r.lastLeft,
      online: liveMs !== undefined,
    };
  });
  entries.sort((a, b) => b.totalMs - a.totalMs);
  return entries.slice(0, Math.max(1, limit));
}

export interface SessionRow {
  joinedAt: string;
  leftAt: string | null;
  durationMs: number | null;
  serverId: string | null;
}

export function getPlayerSessions(uuid: string, limit = 50): {
  uuid: string;
  playerName: string;
  totalMs: number;
  online: boolean;
  sessions: SessionRow[];
} {
  const db = getDb();
  const rows = db
    .prepare('SELECT player_name, joined_at, left_at, duration_ms, server_id FROM play_sessions WHERE uuid = ? ORDER BY joined_at DESC LIMIT ?')
    .all(uuid, Math.max(1, limit)) as Array<{
      player_name: string;
      joined_at: string;
      left_at: string | null;
      duration_ms: number | null;
      server_id: string | null;
    }>;
  const totalRow = db.prepare('SELECT SUM(COALESCE(duration_ms, 0)) AS t FROM play_sessions WHERE uuid = ?').get(uuid) as { t: number | null };
  const open = db
    .prepare('SELECT joined_at FROM play_sessions WHERE uuid = ? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1')
    .get(uuid) as { joined_at: string } | undefined;
  let total = totalRow.t ?? 0;
  if (open) {
    const j = Date.parse(open.joined_at);
    if (Number.isFinite(j)) total += Math.max(0, Date.now() - j);
  }
  return {
    uuid,
    playerName: rows[0]?.player_name ?? uuid,
    totalMs: total,
    online: !!open,
    sessions: rows.map((r) => ({ joinedAt: r.joined_at, leftAt: r.left_at, durationMs: r.duration_ms, serverId: r.server_id })),
  };
}
