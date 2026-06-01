/**
 * Crash report capture.
 *
 * The watchdog (services/watchdog.ts) emits `server.crashed` on an unexpected
 * running->stopped transition. We snapshot the tail of the container log at
 * that moment into the `crash_reports` table so operators get a post-mortem
 * instead of a vanished crash. `server.restarted` (auto-restart) flags the most
 * recent open crash as recovered.
 */
import { getDb } from '../db/index.js';
import { subscribe } from './eventBus.js';
import { getLogs } from './docker.js';

const nowIso = (): string => new Date().toISOString();
const MAX_LOG_CHARS = 20000;

async function onCrash(serverId: string | undefined, detectedAt: string): Promise<void> {
  let logTail = '';
  try {
    logTail = await getLogs(250, serverId);
  } catch {
    // Container may already be gone — store the record without logs.
  }
  getDb()
    .prepare('INSERT INTO crash_reports (server_id, detected_at, log_tail, created_at) VALUES (?, ?, ?, ?)')
    .run(serverId ?? null, detectedAt || nowIso(), logTail ? logTail.slice(-MAX_LOG_CHARS) : null, nowIso());
}

function markAutoRestarted(serverId: string | undefined): void {
  // Flag the latest not-yet-recovered crash for this server.
  const db = getDb();
  const where = serverId ? 'server_id = ?' : 'server_id IS NULL';
  const row = db
    .prepare(`SELECT id FROM crash_reports WHERE ${where} AND auto_restarted = 0 ORDER BY created_at DESC LIMIT 1`)
    .get(...(serverId ? [serverId] : [])) as { id: number } | undefined;
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
    try { markAutoRestarted(event.serverId); } catch (e) { console.error('[crash] flag failed', e); }
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

export function getCrashReports(serverId?: string, limit = 50): CrashReport[] {
  const db = getDb();
  const where = serverId ? 'WHERE server_id = ?' : '';
  const params = serverId ? [serverId, Math.max(1, limit)] : [Math.max(1, limit)];
  const rows = db
    .prepare(`SELECT id, server_id, detected_at, auto_restarted, created_at FROM crash_reports ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as Array<{ id: number; server_id: string | null; detected_at: string; auto_restarted: number; created_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    serverId: r.server_id,
    detectedAt: r.detected_at,
    autoRestarted: !!r.auto_restarted,
    createdAt: r.created_at,
  }));
}

export function getCrashReport(id: number): CrashReportDetail | null {
  const r = getDb()
    .prepare('SELECT id, server_id, detected_at, log_tail, auto_restarted, created_at FROM crash_reports WHERE id = ?')
    .get(id) as
    | { id: number; server_id: string | null; detected_at: string; log_tail: string | null; auto_restarted: number; created_at: string }
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
