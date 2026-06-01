/**
 * Audit log v2.
 *
 * Backed by SQLite (db/index.ts). Replaces services/activityLog.ts for new
 * call sites — the legacy in-memory log keeps working for views that haven't
 * been migrated yet.
 *
 * The audit helper is intentionally synchronous: SQLite via better-sqlite3 is
 * a blocking API and the writes finish in <1 ms. Returning a Promise would
 * make every route handler `await` for no gain.
 */
import type { Request } from 'express';
import { getDb } from '../db/index.js';
import type { AuthenticatedRequest } from '../types/index.js';

export type AuditActorType = 'user' | 'api_key' | 'scheduler' | 'system';

export interface AuditOptions {
  actor?: string;
  actorType?: AuditActorType;
  target?: string;
  metadata?: Record<string, unknown>;
  success?: boolean;
  ip?: string;
  userAgent?: string;
}

export function audit(req: Request | null, action: string, opts: AuditOptions = {}): void {
  try {
    const authReq = req as AuthenticatedRequest | null;
    const actor = opts.actor ?? authReq?.user ?? 'anonymous';
    const ip = opts.ip ?? (req?.ip || (req?.headers['x-forwarded-for'] as string | undefined) || null);
    const userAgent = opts.userAgent ?? (req?.headers['user-agent'] as string | undefined) ?? null;
    const stmt = getDb().prepare(`
      INSERT INTO audit_events
        (ts, actor_username, actor_type, action, target, ip, user_agent, metadata, success)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      new Date().toISOString(),
      actor,
      opts.actorType ?? (authReq?.apiKey ? 'api_key' : 'user'),
      action,
      opts.target ?? null,
      ip,
      userAgent,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      opts.success === false ? 0 : 1,
    );
  } catch (err) {
    // Never let audit failures break a request.
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record event:', err);
  }
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: number;
}

export interface AuditEvent {
  id: number;
  ts: string;
  actorUsername: string;
  actorType: AuditActorType;
  action: string;
  target: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  success: boolean;
}

interface AuditRow {
  id: number;
  ts: string;
  actor_username: string;
  actor_type: string;
  action: string;
  target: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: string | null;
  success: number;
}

function rowToEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    ts: row.ts,
    actorUsername: row.actor_username,
    actorType: row.actor_type as AuditActorType,
    action: row.action,
    target: row.target,
    ip: row.ip,
    userAgent: row.user_agent,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    success: row.success === 1,
  };
}

export function listAuditEvents(filter: AuditFilter): { events: AuditEvent[]; nextCursor: number | null } {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.actor) { where.push('actor_username = ?'); params.push(filter.actor); }
  if (filter.action) { where.push('action LIKE ?'); params.push(`${filter.action}%`); }
  if (filter.from) { where.push('ts >= ?'); params.push(filter.from); }
  if (filter.to) { where.push('ts <= ?'); params.push(filter.to); }
  if (filter.cursor) { where.push('id < ?'); params.push(filter.cursor); }
  const sql = `
    SELECT * FROM audit_events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?
  `;
  params.push(limit + 1);
  const rows = getDb().prepare(sql).all(...params) as AuditRow[];
  const overflow = rows.length > limit;
  const events = rows.slice(0, limit).map(rowToEvent);
  const nextCursor = overflow ? events[events.length - 1].id : null;
  return { events, nextCursor };
}

export function listDistinctActions(): string[] {
  return (getDb().prepare('SELECT DISTINCT action FROM audit_events ORDER BY action').all() as { action: string }[])
    .map(r => r.action);
}

export function pruneOldAuditEvents(retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const info = getDb().prepare('DELETE FROM audit_events WHERE ts < ?').run(cutoff);
  return info.changes;
}
