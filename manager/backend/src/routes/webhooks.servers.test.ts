/**
 * Webhook routes and the servers a caller may use: a webhook delivers its
 * servers' events, so a caller limited to some servers only sees and manages
 * webhooks for those, and one for every server needs access to all.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.MANAGER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-webhook-routes-'));

const access = vi.hoisted(() => ({ allowed: null as string[] | null }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'mod';
    next();
  },
}));
vi.mock('../middleware/permissions.js', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  accessibleServerIds: async () => access.allowed,
  effectivePermissions: async () => ['*'],
  ALL_SERVERS_REQUIRED: 'ALL_SERVERS_REQUIRED',
  SERVER_NOT_ALLOWED: 'SERVER_NOT_ALLOWED',
}));
vi.mock('../services/audit.js', () => ({ audit: () => undefined }));
vi.mock('../services/servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/servers.js')>()),
  getServer: async (id: string) => (['a', 'b'].includes(id) ? { id, name: id } : null),
}));

const express = (await import('express')).default;
const { default: router } = await import('./webhooks.js');

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
  access.allowed = null;
});

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new Error(`${method} ${url} answered ${res.status}: ${text.slice(0, 300)}`);
  }
}

const hook = (serverIds?: string[]) => ({
  name: 'hook',
  url: 'https://example.com/hook',
  type: 'generic',
  events: ['player.joined'],
  serverIds,
});

describe('webhook routes per server', () => {
  it('rejects unknown servers', async () => {
    const r = await call('POST', '/', hook(['zzz']));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('unknown_server');
  });

  it('a caller limited to server b manages webhooks for b only', async () => {
    const forAll = await call('POST', '/', hook());
    expect(forAll.status).toBe(200);
    const forA = await call('POST', '/', hook(['a']));
    access.allowed = ['b'];

    const denied = await call('POST', '/', hook());
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('ALL_SERVERS_REQUIRED');
    expect((await call('POST', '/', hook(['a', 'b']))).status).toBe(403);
    const forB = await call('POST', '/', hook(['b']));
    expect(forB.status).toBe(200);

    const ids = ((await call('GET', '/')).json.webhooks as Array<{ id: string }>).map((w) => w.id);
    const idOf = (r: { json: Record<string, unknown> }) => (r.json.webhook as { id: string }).id;
    expect(ids).toEqual([idOf(forB)]);
    expect((await call('PUT', `/${idOf(forA)}`, { name: 'x' })).status).toBe(403);
    expect((await call('DELETE', `/${idOf(forAll)}`)).status).toBe(403);
    expect((await call('GET', `/${idOf(forA)}/deliveries`)).status).toBe(403);
    // Its own webhook cannot be widened to every server.
    expect((await call('PUT', `/${idOf(forB)}`, { serverIds: [] })).status).toBe(403);
    expect((await call('PUT', `/${idOf(forB)}`, { name: 'renamed' })).status).toBe(200);
  });
});
