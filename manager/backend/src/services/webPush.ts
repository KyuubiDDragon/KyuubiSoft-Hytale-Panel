/**
 * Web Push (PWA) notifications.
 *
 * OFF by default. Enabled via config.webPush. VAPID keys are auto-generated the
 * first time push is enabled (see ensureVapidKeys). Browsers register a
 * PushSubscription which we persist; alert-worthy panel events then fan out to
 * every device a user has subscribed. Subscriptions that the push service
 * reports as gone (404/410) are pruned automatically.
 *
 * `web-push` is imported lazily so installs that never enable push don't load
 * it, mirroring the Discord bot's optional-dependency pattern.
 */
import { getDb } from '../db/index.js';
import { getConfig, updateConfig } from './configService.js';
import { logger } from '../utils/logger.js';

type WebPushModule = typeof import('web-push');
let webpushMod: WebPushModule | null = null;

async function loadWebPush(): Promise<WebPushModule | null> {
  if (webpushMod) return webpushMod;
  try {
    webpushMod = await import('web-push');
    return webpushMod;
  } catch (err) {
    logger.error('[WebPush] web-push not installed:', err);
    return null;
  }
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface SubRow {
  id: number;
  username: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body?: string | null;
  level?: string;
  link?: string | null;
}

/** Ensure VAPID keys exist; generate + persist them on first enable. */
export async function ensureVapidKeys(): Promise<{ publicKey: string; privateKey: string; subject: string } | null> {
  const cfg = await getConfig();
  const wp = cfg.webPush ?? { enabled: false, vapidPublicKey: '', vapidPrivateKey: '', subject: 'mailto:admin@example.com' };
  if (wp.vapidPublicKey && wp.vapidPrivateKey) {
    return { publicKey: wp.vapidPublicKey, privateKey: wp.vapidPrivateKey, subject: wp.subject };
  }
  const mod = await loadWebPush();
  if (!mod) return null;
  const keys = mod.generateVAPIDKeys();
  const next = { ...wp, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey };
  await updateConfig({ webPush: next });
  logger.info('[WebPush] generated new VAPID key pair');
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: next.subject };
}

/** Public VAPID key for the browser, or null if push isn't usable. */
export async function getVapidPublicKey(): Promise<string | null> {
  const cfg = await getConfig();
  if (!cfg.webPush?.enabled) return null;
  const keys = await ensureVapidKeys();
  return keys?.publicKey ?? null;
}

export function saveSubscription(username: string, sub: PushSubscriptionInput, userAgent?: string): void {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;
  getDb().prepare(`
    INSERT INTO push_subscriptions (username, endpoint, p256dh, auth, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
  `).run(username, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent ?? null, new Date().toISOString());
}

export function removeSubscription(endpoint: string): boolean {
  const info = getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  return info.changes > 0;
}

export function countSubscriptions(username: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE username = ?').get(username) as { n: number };
  return row.n;
}

function rowsForUser(username: string): SubRow[] {
  return getDb().prepare('SELECT * FROM push_subscriptions WHERE username = ?').all(username) as SubRow[];
}

/** Send a push to every device a user has registered. Fire-and-forget safe. */
export async function pushToUser(username: string, payload: PushPayload): Promise<void> {
  const cfg = await getConfig();
  if (!cfg.webPush?.enabled) return;
  const rows = rowsForUser(username);
  if (rows.length === 0) return;

  const mod = await loadWebPush();
  const keys = await ensureVapidKeys();
  if (!mod || !keys) return;
  mod.setVapidDetails(keys.subject || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body ?? '',
    level: payload.level ?? 'info',
    link: payload.link ?? '/',
  });

  await Promise.all(rows.map(async (row) => {
    try {
      await mod.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        { TTL: 600 },
      );
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        removeSubscription(row.endpoint);
        logger.info(`[WebPush] pruned expired subscription for ${username}`);
      } else {
        logger.warn(`[WebPush] send failed for ${username}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }));
}

/** Fire-and-forget wrapper for hot paths (notify fan-out). */
export function pushToUserAsync(username: string, payload: PushPayload): void {
  void pushToUser(username, payload).catch(() => { /* logged inside */ });
}
