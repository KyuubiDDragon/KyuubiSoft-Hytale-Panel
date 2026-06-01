/**
 * Data-retention sweeps.
 *
 * Several tables are append-only operational logs that otherwise grow without
 * bound — degrading queries and filling the manager volume. This runs a cheap
 * delete-by-age sweep shortly after boot and then daily.
 *
 * play_sessions are intentionally NOT pruned: they feed the playtime
 * leaderboard totals, so deleting old ones would silently shrink players'
 * recorded playtime.
 */
import { getDb } from '../db/index.js';
import { pruneOldAuditEvents } from './audit.js';
import { logger } from '../utils/logger.js';

// Retention windows in days. Generous by default — these are records, not data.
const AUDIT_RETENTION_DAYS = 90;
const NOTIFICATION_RETENTION_DAYS = 60;
const CRASH_RETENTION_DAYS = 90;
const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

// table/column are module-local literals (never user input), so the inlined
// identifiers are safe.
function pruneByAge(table: string, column: string, days: number): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return getDb().prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff).changes;
}

export function runRetentionSweep(): void {
  try {
    const audit = pruneOldAuditEvents(AUDIT_RETENTION_DAYS);
    const notifications = pruneByAge('notifications', 'created_at', NOTIFICATION_RETENTION_DAYS);
    const crashes = pruneByAge('crash_reports', 'created_at', CRASH_RETENTION_DAYS);
    const deliveries = pruneByAge('webhook_deliveries', 'created_at', WEBHOOK_DELIVERY_RETENTION_DAYS);
    const total = audit + notifications + crashes + deliveries;
    if (total > 0) {
      logger.info(
        `[retention] pruned ${total} rows (audit=${audit} notifications=${notifications} ` +
        `crashes=${crashes} webhook_deliveries=${deliveries})`,
      );
    }
  } catch (err) {
    logger.warn(`[retention] sweep failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function startRetention(): void {
  if (timer) return;
  // First sweep a minute after boot (let the DB settle), then once a day.
  setTimeout(runRetentionSweep, 60_000).unref?.();
  timer = setInterval(runRetentionSweep, INTERVAL_MS);
  timer.unref?.();
  logger.info('[retention] daily cleanup scheduled');
}

export function stopRetention(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
