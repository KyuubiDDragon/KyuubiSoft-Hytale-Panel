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
 *
 * The endpoint is a URL the browser hands over, so it is only taken (and only
 * ever sent to) when it is an https URL of a browser push service
 * (PUSH_SERVICE_HOSTS, plus hosts listed in WEB_PUSH_EXTRA_HOSTS). Otherwise
 * any signed-in user could make the panel POST to an address of their choice.
 * A subscription stays with its user: another account only gets it when it
 * hands over the same keys, i.e. from the same browser.
 */
import https from 'https';
import { getDb } from '../db/index.js';
import { getConfig, updateConfig } from './configService.js';
import { logger } from '../utils/logger.js';
import { guardedLookup } from '../utils/safeFetch.js';

/** Push services of Chrome/Edge/Opera/Samsung (FCM), Firefox, Edge (WNS) and Safari. */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];
const PUSH_TIMEOUT_MS = 10_000;

function extraPushHosts(): string[] {
  return (process.env.WEB_PUSH_EXTRA_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const hostIn = (host: string, hosts: string[]) =>
  hosts.some((h) => host === h || host.endsWith(`.${h}`));

/** Is `endpoint` an https URL of a known push service or an operator-added host? */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return hostIn(host, PUSH_SERVICE_HOSTS) || hostIn(host, extraPushHosts());
}

/**
 * An agent that refuses metadata addresses, and private ones unless the
 * operator added the host. A new one for every send (no keep-alive): a pooled
 * connection would be reused without the lookup, so it must never be shared
 * with a send under another rule.
 */
function pushAgent(endpoint: string): https.Agent {
  const operatorHost = hostIn(new URL(endpoint).hostname.toLowerCase(), extraPushHosts());
  return new https.Agent({ lookup: guardedLookup(operatorHost) });
}

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
export async function ensureVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
  subject: string;
} | null> {
  const cfg = await getConfig();
  const wp = cfg.webPush ?? {
    enabled: false,
    vapidPublicKey: '',
    vapidPrivateKey: '',
    subject: 'mailto:admin@example.com',
  };
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

/**
 * Stores the subscription for `username`. False when the endpoint is not a
 * push service or belongs to another user and the keys differ (not the same
 * browser).
 */
export function saveSubscription(
  username: string,
  sub: PushSubscriptionInput,
  userAgent?: string,
): boolean {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  if (!isAllowedPushEndpoint(sub.endpoint)) return false;
  const info = getDb()
    .prepare(
      `
    INSERT INTO push_subscriptions (username, endpoint, p256dh, auth, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
    WHERE push_subscriptions.username = excluded.username
      OR (push_subscriptions.p256dh = excluded.p256dh AND push_subscriptions.auth = excluded.auth)
  `,
    )
    .run(
      username,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      userAgent ?? null,
      new Date().toISOString(),
    );
  return info.changes > 0;
}

/** Removes a subscription of `username` (all users' when `username` is omitted). */
export function removeSubscription(endpoint: string, username?: string): boolean {
  const info =
    username === undefined
      ? getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
      : getDb()
          .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND username = ?')
          .run(endpoint, username);
  return info.changes > 0;
}

export function countSubscriptions(username: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE username = ?')
    .get(username) as { n: number };
  return row.n;
}

function rowsForUser(username: string): SubRow[] {
  return getDb()
    .prepare('SELECT * FROM push_subscriptions WHERE username = ?')
    .all(username) as SubRow[];
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

  await Promise.all(
    rows.map(async (row) => {
      if (!isAllowedPushEndpoint(row.endpoint)) {
        logger.warn(`[WebPush] skipped a subscription of ${username}: not a push service endpoint`);
        return;
      }
      try {
        await mod.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          { TTL: 600, timeout: PUSH_TIMEOUT_MS, agent: pushAgent(row.endpoint) },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          removeSubscription(row.endpoint, username);
          logger.info(`[WebPush] pruned expired subscription for ${username}`);
        } else {
          logger.warn(
            `[WebPush] send failed for ${username}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }),
  );
}

/** Fire-and-forget wrapper for hot paths (notify fan-out). */
export function pushToUserAsync(username: string, payload: PushPayload): void {
  void pushToUser(username, payload).catch(() => {
    /* logged inside */
  });
}
