/**
 * Webhook engine.
 *
 * Webhook subscriptions are persisted in SQLite. On publish, the dispatcher
 * matches the event against every enabled webhook's subscribed events,
 * enqueues a delivery row, and works the queue with exponential backoff.
 *
 * Three formats:
 *   - 'discord': Discord embed
 *   - 'slack':   Slack attachment
 *   - 'generic': raw JSON, signed with X-KyuubiSoft-Signature (HMAC-SHA256)
 *
 * Deliveries retry up to MAX_ATTEMPTS times with backoff
 * 30s → 5min → 30min → 6h → 24h, then move to status='gave_up'.
 */
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { publish as publishEvent, subscribe } from './eventBus.js';
import type { PanelEvent, PanelEventName } from '../schemas/events.js';

const RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000, 6 * 3600_000, 24 * 3600_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
const DELIVERY_TIMEOUT_MS = 10_000;
const TICK_MS = 5_000;

export interface Webhook {
  id: string;
  name: string;
  url: string;
  type: 'discord' | 'slack' | 'generic';
  events: PanelEventName[];
  secret: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  type: string;
  events: string;
  secret: string | null;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToWebhook(r: WebhookRow): Webhook {
  return {
    id: r.id, name: r.name, url: r.url, type: r.type as Webhook['type'],
    events: JSON.parse(r.events) as PanelEventName[], secret: r.secret,
    enabled: r.enabled === 1, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listWebhooks(): Webhook[] {
  return (getDb().prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as WebhookRow[]).map(rowToWebhook);
}

export function getWebhook(id: string): Webhook | null {
  const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined;
  return row ? rowToWebhook(row) : null;
}

export function createWebhook(opts: {
  name: string;
  url: string;
  type: 'discord' | 'slack' | 'generic';
  events: PanelEventName[];
  secret?: string | null;
  enabled?: boolean;
  createdBy: string;
}): Webhook {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO webhooks (id, name, url, type, events, secret, enabled, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.name, opts.url, opts.type, JSON.stringify(opts.events), opts.secret ?? null,
         opts.enabled === false ? 0 : 1, opts.createdBy, now, now);
  return getWebhook(id)!;
}

export function updateWebhook(id: string, patch: Partial<Omit<Webhook, 'id' | 'createdAt' | 'createdBy' | 'updatedAt'>>): Webhook | null {
  const current = getWebhook(id);
  if (!current) return null;
  const next: Webhook = { ...current, ...patch, updatedAt: new Date().toISOString() };
  getDb().prepare(`
    UPDATE webhooks SET name=?, url=?, type=?, events=?, secret=?, enabled=?, updated_at=? WHERE id=?
  `).run(next.name, next.url, next.type, JSON.stringify(next.events), next.secret ?? null,
         next.enabled ? 1 : 0, next.updatedAt, id);
  return next;
}

export function deleteWebhook(id: string): boolean {
  const info = getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return info.changes > 0;
}

interface DeliveryRow {
  id: number;
  webhook_id: string;
  event_name: string;
  payload: string;
  attempt: number;
  next_retry_at: string | null;
  status: string;
  response_code: number | null;
  response_body_truncated: string | null;
  created_at: string;
  completed_at: string | null;
}

export function listDeliveries(webhookId: string, opts: { limit?: number; cursor?: number; status?: string } = {}): { deliveries: DeliveryRow[]; nextCursor: number | null } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: Array<string | number> = [webhookId];
  let cursorClause = '';
  if (opts.cursor) { cursorClause += ' AND id < ?'; params.push(opts.cursor); }
  if (opts.status) { cursorClause += ' AND status = ?'; params.push(opts.status); }
  params.push(limit + 1);
  const rows = getDb().prepare(`
    SELECT * FROM webhook_deliveries WHERE webhook_id = ? ${cursorClause}
    ORDER BY id DESC LIMIT ?
  `).all(...params) as DeliveryRow[];
  const overflow = rows.length > limit;
  return { deliveries: rows.slice(0, limit), nextCursor: overflow ? rows[limit - 1].id : null };
}

function enqueueDelivery(webhookId: string, event: PanelEvent): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO webhook_deliveries
      (webhook_id, event_name, payload, attempt, next_retry_at, status, created_at)
    VALUES (?, ?, ?, 0, ?, 'pending', ?)
  `).run(webhookId, event.name, JSON.stringify(event), now, now);
}

function pickReadyDeliveries(limit = 20): Array<DeliveryRow> {
  const now = new Date().toISOString();
  return getDb().prepare(`
    SELECT * FROM webhook_deliveries
    WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY id ASC LIMIT ?
  `).all(now, limit) as DeliveryRow[];
}

function markCompleted(deliveryId: number, success: boolean, code: number | null, bodySnippet: string | null, attempt: number): void {
  const now = new Date().toISOString();
  if (success) {
    getDb().prepare(`
      UPDATE webhook_deliveries
      SET status='success', response_code=?, response_body_truncated=?, attempt=?, completed_at=?
      WHERE id=?
    `).run(code, bodySnippet, attempt, now, deliveryId);
    return;
  }
  if (attempt >= MAX_ATTEMPTS) {
    getDb().prepare(`
      UPDATE webhook_deliveries
      SET status='gave_up', response_code=?, response_body_truncated=?, attempt=?, completed_at=?
      WHERE id=?
    `).run(code, bodySnippet, attempt, now, deliveryId);
    return;
  }
  const nextAt = new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]).toISOString();
  getDb().prepare(`
    UPDATE webhook_deliveries
    SET status='pending', response_code=?, response_body_truncated=?, attempt=?, next_retry_at=?
    WHERE id=?
  `).run(code, bodySnippet, attempt, nextAt, deliveryId);
}

function formatDiscordPayload(event: PanelEvent): unknown {
  const colorByName: Record<string, number> = {
    'server.started': 0x22c55e,
    'server.stopped': 0xfbbf24,
    'server.crashed': 0xef4444,
    'backup.completed': 0x60a5fa,
    'backup.failed': 0xef4444,
    'player.joined': 0x22c55e,
    'player.left': 0x9ca3af,
    'player.banned': 0xef4444,
    'update.available': 0xfbbf24,
  };
  const color = colorByName[event.name] ?? 0xff6b35;
  const fields = Object.entries(event.payload).slice(0, 10).map(([k, v]) => ({
    name: k, value: String(v).slice(0, 1024), inline: true,
  }));
  return {
    embeds: [{
      title: event.name,
      color,
      timestamp: event.timestamp,
      footer: { text: 'KyuubiSoft Panel' },
      fields,
    }],
  };
}

function formatSlackPayload(event: PanelEvent): unknown {
  return {
    text: `*${event.name}*`,
    attachments: [{
      color: '#FF6B35',
      ts: Math.floor(Date.parse(event.timestamp) / 1000),
      fields: Object.entries(event.payload).slice(0, 10).map(([k, v]) => ({
        title: k, value: String(v).slice(0, 1024), short: true,
      })),
    }],
  };
}

async function deliverOne(delivery: DeliveryRow, webhook: Webhook): Promise<void> {
  const event = JSON.parse(delivery.payload) as PanelEvent;
  const body =
    webhook.type === 'discord' ? JSON.stringify(formatDiscordPayload(event)) :
    webhook.type === 'slack'   ? JSON.stringify(formatSlackPayload(event)) :
    JSON.stringify(event);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'KyuubiSoft-Panel/3.0',
    'X-KyuubiSoft-Event': event.name,
    'X-KyuubiSoft-Delivery': String(delivery.id),
  };
  if (webhook.type === 'generic' && webhook.secret) {
    const sig = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
    headers['X-KyuubiSoft-Signature'] = `sha256=${sig}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  let code: number | null = null;
  let bodySnippet: string | null = null;
  let success = false;
  try {
    const resp = await fetch(webhook.url, { method: 'POST', body, headers, signal: controller.signal });
    code = resp.status;
    success = resp.status >= 200 && resp.status < 300;
    bodySnippet = (await resp.text()).slice(0, 500);
  } catch (err) {
    code = null;
    bodySnippet = err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
  } finally {
    clearTimeout(timer);
  }
  markCompleted(delivery.id, success, code, bodySnippet, delivery.attempt + 1);
}

let tickHandle: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const ready = pickReadyDeliveries();
  if (ready.length === 0) return;
  await Promise.all(ready.map(async d => {
    const wh = getWebhook(d.webhook_id);
    if (!wh || !wh.enabled) {
      markCompleted(d.id, false, null, 'webhook disabled or deleted', MAX_ATTEMPTS);
      return;
    }
    await deliverOne(d, wh);
  }));
}

export function startWebhookDispatcher(): void {
  // Subscribe once. Match any event the webhook is listening to.
  subscribe(['*'], event => {
    const hooks = (getDb().prepare('SELECT * FROM webhooks WHERE enabled = 1').all() as WebhookRow[]).map(rowToWebhook);
    for (const wh of hooks) {
      if (wh.events.some(p => {
        const s = p as string;
        return s === '*' || s === event.name || (s.endsWith('.*') && event.name.startsWith(s.slice(0, -1)));
      })) {
        enqueueDelivery(wh.id, event);
      }
    }
  });
  tickHandle = setInterval(() => { void tick().catch(() => {}); }, TICK_MS);
}

export function stopWebhookDispatcher(): void {
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
}

/** Send a synthetic test event, bypassing the queue but recording a delivery row. */
export async function testWebhook(id: string, actor: string): Promise<{ success: boolean; code: number | null; body: string | null }> {
  const wh = getWebhook(id);
  if (!wh) throw new Error('Webhook not found');
  const event: PanelEvent = {
    name: 'panel.update_available',
    timestamp: new Date().toISOString(),
    payload: { test: true, triggeredBy: actor },
  };
  enqueueDelivery(id, event);
  const d = (getDb().prepare(
    'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 1'
  ).get(id) as DeliveryRow | undefined);
  if (!d) throw new Error('Failed to enqueue test delivery');
  await deliverOne(d, wh);
  const after = (getDb().prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(d.id) as DeliveryRow);
  return { success: after.status === 'success', code: after.response_code, body: after.response_body_truncated };
}

// re-export the event publish helper so callers don't need to import both
export { publishEvent };
