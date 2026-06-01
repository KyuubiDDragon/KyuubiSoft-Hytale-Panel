/**
 * In-panel notifications center.
 *
 * Persists per-user notifications in SQLite, exposes user-preference toggles
 * per event-name, and bridges into the event bus so that events the user
 * opted into automatically create a notification row.
 */
import { getDb } from '../db/index.js';
import { subscribe } from './eventBus.js';
import type { PanelEvent } from '../schemas/events.js';
import { pushToUserAsync } from './webPush.js';

export type NotificationLevel = 'info' | 'warning' | 'error' | 'success';

export interface Notification {
  id: number;
  recipientUsername: string;
  title: string;
  body: string | null;
  level: NotificationLevel;
  link: string | null;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
}

interface NotificationRow {
  id: number;
  recipient_username: string;
  title: string;
  body: string | null;
  level: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

function rowToNotification(r: NotificationRow): Notification {
  return {
    id: r.id, recipientUsername: r.recipient_username, title: r.title,
    body: r.body, level: r.level as NotificationLevel, link: r.link,
    createdAt: r.created_at, readAt: r.read_at, dismissedAt: r.dismissed_at,
  };
}

export function notify(recipient: string, opts: { title: string; body?: string; level?: NotificationLevel; link?: string }): Notification {
  const now = new Date().toISOString();
  const info = getDb().prepare(`
    INSERT INTO notifications (recipient_username, title, body, level, link, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(recipient, opts.title, opts.body ?? null, opts.level ?? 'info', opts.link ?? null, now);
  // Mirror to the recipient's PWA devices (no-op unless Web Push is enabled).
  pushToUserAsync(recipient, { title: opts.title, body: opts.body ?? null, level: opts.level ?? 'info', link: opts.link ?? null });
  return rowToNotification(
    getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid) as NotificationRow
  );
}

export function listNotifications(recipient: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const sql = opts.unreadOnly
    ? 'SELECT * FROM notifications WHERE recipient_username = ? AND read_at IS NULL AND dismissed_at IS NULL ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM notifications WHERE recipient_username = ? AND dismissed_at IS NULL ORDER BY id DESC LIMIT ?';
  return (getDb().prepare(sql).all(recipient, limit) as NotificationRow[]).map(rowToNotification);
}

export function markRead(recipient: string, id: number): boolean {
  const info = getDb().prepare(
    'UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_username = ? AND read_at IS NULL'
  ).run(new Date().toISOString(), id, recipient);
  return info.changes > 0;
}

export function dismissAll(recipient: string): number {
  const info = getDb().prepare(
    'UPDATE notifications SET dismissed_at = ? WHERE recipient_username = ? AND dismissed_at IS NULL'
  ).run(new Date().toISOString(), recipient);
  return info.changes;
}

export interface NotificationPreference {
  eventName: string;
  inApp: boolean;
  email: boolean;
  webhook: boolean;
}

export function getPreferences(username: string): NotificationPreference[] {
  return (getDb().prepare('SELECT event_name, in_app, email, webhook FROM notification_prefs WHERE username = ?').all(username) as Array<{ event_name: string; in_app: number; email: number; webhook: number }>).map(r => ({
    eventName: r.event_name, inApp: r.in_app === 1, email: r.email === 1, webhook: r.webhook === 1,
  }));
}

export function setPreference(username: string, eventName: string, pref: { inApp?: boolean; email?: boolean; webhook?: boolean }): void {
  const existing = getDb().prepare('SELECT * FROM notification_prefs WHERE username = ? AND event_name = ?').get(username, eventName) as { in_app: number; email: number; webhook: number } | undefined;
  const next = {
    in_app: (pref.inApp ?? (existing ? existing.in_app === 1 : true)) ? 1 : 0,
    email: (pref.email ?? (existing ? existing.email === 1 : false)) ? 1 : 0,
    webhook: (pref.webhook ?? (existing ? existing.webhook === 1 : false)) ? 1 : 0,
  };
  getDb().prepare(`
    INSERT INTO notification_prefs (username, event_name, in_app, email, webhook)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username, event_name) DO UPDATE SET in_app=excluded.in_app, email=excluded.email, webhook=excluded.webhook
  `).run(username, eventName, next.in_app, next.email, next.webhook);
}

function fanOutEvent(event: PanelEvent): void {
  // Look up every user that has in-app delivery toggled on for this event.
  const recipients = getDb().prepare(
    'SELECT username FROM notification_prefs WHERE event_name = ? AND in_app = 1'
  ).all(event.name) as Array<{ username: string }>;
  if (recipients.length === 0) return;
  const title = describeEvent(event);
  for (const r of recipients) {
    notify(r.username, {
      title,
      body: JSON.stringify(event.payload, null, 2).slice(0, 500),
      level: levelForEvent(event.name),
    });
  }
}

function describeEvent(event: PanelEvent): string {
  switch (event.name) {
    case 'server.started': return 'Server started';
    case 'server.stopped': return 'Server stopped';
    case 'server.crashed': return 'Server crashed';
    case 'server.alert': return 'Server alert';
    case 'backup.completed': return 'Backup completed';
    case 'backup.failed': return 'Backup failed';
    case 'panel.update_available': return 'Panel update available';
    case 'update.available': return 'Server update available';
    case 'player.banned': return `Player banned: ${event.payload.player ?? ''}`;
    default: return event.name;
  }
}

function levelForEvent(name: string): NotificationLevel {
  if (name.endsWith('.failed') || name === 'server.crashed') return 'error';
  if (name.endsWith('.available') || name === 'server.stopping') return 'warning';
  if (name.endsWith('.started') || name.endsWith('.completed')) return 'success';
  return 'info';
}

export function startNotificationFanout(): void {
  subscribe(['*'], fanOutEvent);
}
