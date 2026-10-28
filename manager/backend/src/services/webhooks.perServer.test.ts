/**
 * Webhooks and servers: a delivered event names its server (id and name, also
 * in the Discord/Slack footer), and a webhook with `serverIds` only gets the
 * events of those servers. An empty list keeps the old behaviour: every
 * server and the panel-wide events.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-webhooks-per-server-'));
process.env.MANAGER_DATA_PATH = tmpDir;

const NAMES: Record<string, string> = { a: 'Survival', b: 'Creative' };
// The registry: "a" is the default server.
vi.mock('./servers.js', () => ({
  COMPOSE_SERVER_ID: 'default',
  resolveServerId: async (id?: string) => id ?? 'a',
  getServer: async (id: string) => (NAMES[id] ? { id, name: NAMES[id] } : null),
}));

const webhooks = await import('./webhooks.js');
const { getDb } = await import('../db/index.js');
import type { PanelEvent, PanelEventName } from '../schemas/events.js';

const event = (name: PanelEventName, serverId?: string): PanelEvent => ({
  name,
  timestamp: new Date().toISOString(),
  serverId,
  payload: { player: 'Steve' },
});

/** Queued deliveries per webhook name, as the stored events. */
function queued(): Record<string, Array<PanelEvent & { serverName?: string }>> {
  const rows = getDb()
    .prepare(
      'SELECT w.name AS hook, d.payload AS payload FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id ORDER BY d.id',
    )
    .all() as { hook: string; payload: string }[];
  const out: Record<string, Array<PanelEvent & { serverName?: string }>> = {};
  for (const r of rows) (out[r.hook] ??= []).push(JSON.parse(r.payload));
  return out;
}

beforeEach(() => {
  getDb().prepare('DELETE FROM webhook_deliveries').run();
  getDb().prepare('DELETE FROM webhooks').run();
  const hook = (name: string, serverIds?: string[]) =>
    webhooks.createWebhook({
      name,
      url: 'https://example.com/hook',
      type: 'generic',
      events: ['player.joined', 'server.started', 'auth.login_failed'],
      serverIds,
      createdBy: 'admin',
    });
  hook('all');
  hook('only-b', ['b']);
});

describe('webhooks per server', () => {
  it('stores the server list; an empty one means every server', () => {
    const byName = Object.fromEntries(webhooks.listWebhooks().map((w) => [w.name, w.serverIds]));
    expect(byName).toEqual({ all: [], 'only-b': ['b'] });
  });

  it('a webhook for server B does not fire for server A', async () => {
    await webhooks.dispatchEvent(event('player.joined', 'a'));
    const q = queued();
    expect(q.all).toHaveLength(1);
    expect(q['only-b']).toBeUndefined();
  });

  it('fires for its own server, with the server id and name in the payload', async () => {
    await webhooks.dispatchEvent(event('player.joined', 'b'));
    const q = queued();
    expect(q['only-b']).toHaveLength(1);
    expect(q['only-b'][0]).toMatchObject({ serverId: 'b', serverName: 'Creative' });
    expect(q.all[0]).toMatchObject({ serverId: 'b', serverName: 'Creative' });
  });

  it('an event without a server is the default server’s; panel-wide events skip filtered hooks', async () => {
    await webhooks.dispatchEvent(event('server.started'));
    expect(queued().all[0]).toMatchObject({ serverId: 'a', serverName: 'Survival' });
    expect(queued()['only-b']).toBeUndefined();

    getDb().prepare('DELETE FROM webhook_deliveries').run();
    await webhooks.dispatchEvent(event('auth.login_failed'));
    const q = queued();
    expect(q.all).toHaveLength(1);
    expect(q.all[0].serverId).toBeUndefined();
    expect(q['only-b']).toBeUndefined();
  });

  it('can change and clear the server list', async () => {
    const hook = webhooks.listWebhooks().find((w) => w.name === 'only-b')!;
    expect(webhooks.updateWebhook(hook.id, { serverIds: ['a'] })?.serverIds).toEqual(['a']);
    await webhooks.dispatchEvent(event('player.joined', 'a'));
    expect(queued()['only-b']).toHaveLength(1);
    expect(webhooks.updateWebhook(hook.id, { serverIds: [] })?.serverIds).toEqual([]);
    expect(webhooks.getWebhook(hook.id)?.serverIds).toEqual([]);
  });

  it('names the server in the Discord and Slack footer', () => {
    const delivered = { ...event('server.started', 'b'), serverName: 'Creative' };
    const discord = webhooks.formatDiscordPayload(delivered) as {
      embeds: Array<{ footer: { text: string } }>;
    };
    expect(discord.embeds[0].footer.text).toBe('KyuubiSoft Panel · Creative');
    const slack = webhooks.formatSlackPayload(delivered) as {
      attachments: Array<{ footer: string }>;
    };
    expect(slack.attachments[0].footer).toBe('KyuubiSoft Panel · Creative');
    const panelWide = webhooks.formatDiscordPayload(event('auth.login_failed')) as {
      embeds: Array<{ footer: { text: string } }>;
    };
    expect(panelWide.embeds[0].footer.text).toBe('KyuubiSoft Panel');
  });
});
