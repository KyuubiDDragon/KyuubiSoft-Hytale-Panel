/**
 * The webhook list never carries the signing secret, and shows the target URL
 * in full only to accounts that may manage webhooks.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.MANAGER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-webhook-secret-'));

const caller = vi.hoisted(() => ({ permissions: ['*'] as string[] }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'mod';
    next();
  },
}));
vi.mock('../middleware/permissions.js', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  accessibleServerIds: async () => null,
  effectivePermissions: async () => caller.permissions,
  ALL_SERVERS_REQUIRED: 'ALL_SERVERS_REQUIRED',
  SERVER_NOT_ALLOWED: 'SERVER_NOT_ALLOWED',
}));
vi.mock('../services/audit.js', () => ({ audit: () => undefined }));

const express = (await import('express')).default;
const { default: router, maskUrl } = await import('./webhooks.js');
const { getWebhook } = await import('../services/webhooks.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  caller.permissions = ['*'];
});

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const URL_WITH_TOKEN = 'https://discord.example.com/api/webhooks/123/very-secret-token';
const hook = {
  name: 'hook',
  url: URL_WITH_TOKEN,
  type: 'generic',
  events: ['player.joined'],
  secret: 'signing-key',
};

describe('webhook secrets and URLs', () => {
  it('never returns the secret, only whether there is one', async () => {
    const created = await call('POST', '/', hook);
    expect(created.status).toBe(200);
    expect(created.json.webhook.secret).toBeUndefined();
    expect(created.json.webhook.hasSecret).toBe(true);

    const list = await call('GET', '/');
    const entry = list.json.webhooks.find((w: { id: string }) => w.id === created.json.webhook.id);
    expect(entry.secret).toBeUndefined();
    expect(entry.hasSecret).toBe(true);
    expect(entry.url).toBe(URL_WITH_TOKEN);
  });

  it('masks the URL for an account that may only view', async () => {
    caller.permissions = ['webhooks.view'];
    const list = await call('GET', '/');
    const urls = list.json.webhooks.map((w: { url: string }) => w.url);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toBe('https://discord.example.com/…');
      expect(url).not.toContain('very-secret-token');
    }
  });

  it('keeps the stored secret when an update leaves it out', async () => {
    const created = await call('POST', '/', hook);
    const id = created.json.webhook.id as string;
    const updated = await call('PUT', `/${id}`, { name: 'renamed' });
    expect(updated.status).toBe(200);
    expect(updated.json.webhook.secret).toBeUndefined();
    expect(getWebhook(id)?.secret).toBe('signing-key');

    await call('PUT', `/${id}`, { secret: 'new-key' });
    expect(getWebhook(id)?.secret).toBe('new-key');
  });

  it('reports a webhook without a secret as such', async () => {
    const { secret: _secret, ...plain } = hook;
    const created = await call('POST', '/', plain);
    expect(created.json.webhook.hasSecret).toBe(false);
  });
});

describe('maskUrl', () => {
  it('keeps scheme and host only', () => {
    expect(maskUrl('http://host:8080/a/b?c=d')).toBe('http://host:8080/…');
    expect(maskUrl('not a url')).toBe('…');
  });
});
