/**
 * Crash report capture.
 *
 * The watchdog (services/watchdog.ts) emits `server.crashed` on an unexpected
 * running->stopped transition. We snapshot the tail of the container log at
 * that moment into the `crash_reports` table so operators get a post-mortem
 * instead of a vanished crash. `server.restarted` (auto-restart) flags the most
 * recent open crash of that server as recovered.
 *
 * Every report stores the resolved server id; an event without one is the
 * default server's.
 */
import { getDb } from '../db/index.js';
import { subscribe } from './eventBus.js';
import { getLogs } from './docker.js';
import { resolveServerId } from './servers.js';

const nowIso = (): string => new Date().toISOString();
const MAX_LOG_CHARS = 20000;

async function onCrash(eventServerId: string | undefined, detectedAt: string): Promise<void> {
  const serverId = await resolveServerId(eventServerId);
  let logTail = '';
  try {
    logTail = await getLogs(250, serverId);
  } catch {
    // Container may already be gone — store the record without logs.
  }
  getDb()
    .prepare(
      'INSERT INTO crash_reports (server_id, detected_at, log_tail, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(
      serverId,
      detectedAt || nowIso(),
      logTail ? logTail.slice(-MAX_LOG_CHARS) : null,
      nowIso(),
    );
}

async function markAutoRestarted(eventServerId: string | undefined): Promise<void> {
  // Flag the latest not-yet-recovered crash for this server.
  const serverId = await resolveServerId(eventServerId);
  const db = getDb();
  const row = db
    .prepare(
      'SELECT id FROM crash_reports WHERE server_id = ? AND auto_restarted = 0 ORDER BY created_at DESC LIMIT 1',
    )
    .get(serverId) as { id: number } | undefined;
  if (row) db.prepare('UPDATE crash_reports SET auto_restarted = 1 WHERE id = ?').run(row.id);
}

let started = false;
export function startCrashCapture(): void {
  if (started) return;
  started = true;
  subscribe(['server.crashed'], (event) => {
    const p = (event.payload ?? {}) as { detectedAt?: string };
    onCrash(event.serverId, p.detectedAt ?? nowIso()).catch((e) =>
      console.error('[crash] capture failed', e),
    );
  });
  subscribe(['server.restarted'], (event) => {
    markAutoRestarted(event.serverId).catch((e) => console.error('[crash] flag failed', e));
  });
  console.log('[crash] capture started');
}

export interface CrashReport {
  id: number;
  serverId: string | null;
  detectedAt: string;
  autoRestarted: boolean;
  createdAt: string;
}
export interface CrashReportDetail extends CrashReport {
  logTail: string | null;
}

/** Recent crash reports, newest first: of one server, or of every server without `serverId`. */
export function getCrashReports(serverId?: string, limit = 50): CrashReport[] {
  const db = getDb();
  const where = serverId ? 'WHERE server_id = ?' : '';
  const params = serverId ? [serverId, Math.max(1, limit)] : [Math.max(1, limit)];
  const rows = db
    .prepare(
      `SELECT id, server_id, detected_at, auto_restarted, created_at FROM crash_reports ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as Array<{
    id: number;
    server_id: string | null;
    detected_at: string;
    auto_restarted: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    serverId: r.server_id,
    detectedAt: r.detected_at,
    autoRestarted: !!r.auto_restarted,
    createdAt: r.created_at,
  }));
}

/** One crash report with its log; with `serverId` only if it belongs to that server. */
export function getCrashReport(id: number, serverId?: string): CrashReportDetail | null {
  const r = getDb()
    .prepare(
      `SELECT id, server_id, detected_at, log_tail, auto_restarted, created_at FROM crash_reports WHERE id = ?${serverId ? ' AND server_id = ?' : ''}`,
    )
    .get(...(serverId ? [id, serverId] : [id])) as
    | {
        id: number;
        server_id: string | null;
        detected_at: string;
        log_tail: string | null;
        auto_restarted: number;
        created_at: string;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    serverId: r.server_id,
    detectedAt: r.detected_at,
    logTail: r.log_tail,
    autoRestarted: !!r.auto_restarted,
    createdAt: r.created_at,
  };
}
