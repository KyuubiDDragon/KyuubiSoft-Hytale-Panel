/**
 * Delivering a webhook: every redirect hop is checked like the first request
 * (a public receiver must not bounce the panel to an internal or metadata
 * address), private receivers need ALLOW_INTERNAL_WEBHOOKS, and only the
 * start of a long answer is kept.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-webhooks-delivery-'));
process.env.MANAGER_DATA_PATH = tmpDir;

vi.mock('./servers.js', () => ({
  COMPOSE_SERVER_ID: 'default',
  resolveServerId: async (id?: string) => id ?? 'default',
  getServer: async () => null,
}));

const webhooks = await import('./webhooks.js');

const hits: string[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    req.resume();
    req.on('end', () => {
      if (req.url === '/bounce') {
        res.writeHead(307, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else if (req.url === '/long') {
        res.writeHead(200);
        res.end('x'.repeat(200_000));
      } else {
        res.writeHead(204);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  delete process.env.ALLOW_INTERNAL_WEBHOOKS;
  hits.length = 0;
});

const hook = (url: string) =>
  webhooks.createWebhook({
    name: `hook-${hits.length}-${Math.random()}`,
    url,
    type: 'generic',
    events: ['panel.update_available'],
    createdBy: 'admin',
  });

describe('webhook delivery', () => {
  it('refuses a private receiver unless internal webhooks are allowed', async () => {
    const wh = hook(`${base}/ok`);
    const blocked = await webhooks.testWebhook(wh.id, 'admin');
    expect(blocked.success).toBe(false);
    expect(blocked.body).toMatch(/private/i);
    expect(hits).toEqual([]);

    process.env.ALLOW_INTERNAL_WEBHOOKS = 'true';
    const sent = await webhooks.testWebhook(wh.id, 'admin');
    expect(sent).toMatchObject({ success: true, code: 204 });
    expect(hits).toEqual(['/ok']);
  });

  it('does not follow a redirect to a metadata address', async () => {
    process.env.ALLOW_INTERNAL_WEBHOOKS = 'true';
    const result = await webhooks.testWebhook(hook(`${base}/bounce`).id, 'admin');
    expect(result.success).toBe(false);
    expect(result.body).toMatch(/metadata/i);
    expect(hits).toEqual(['/bounce']);
  });

  it('keeps only the start of a long answer', async () => {
    process.env.ALLOW_INTERNAL_WEBHOOKS = 'true';
    const result = await webhooks.testWebhook(hook(`${base}/long`).id, 'admin');
    expect(result.success).toBe(true);
    expect(result.body).toHaveLength(500);
  });
});
