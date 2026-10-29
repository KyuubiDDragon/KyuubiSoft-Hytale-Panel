/**
 * /api/health stays public; /api/health/permissions names host and container
 * folders of the compose server, so it needs a signed-in user with
 * settings.view and access to every server, and it checks the folders without
 * writing anything into them.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';

const { perms, servers } = vi.hoisted(() => ({
  perms: new Map<string, string[]>(),
  servers: new Map<string, string[]>(),
}));
vi.mock('../services/roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/roles.js')>()),
  getUserPermissions: async (user: string) => perms.get(user) ?? [],
  getUserAllowedServers: async (user: string) => servers.get(user) ?? null,
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, res: Response, next: NextFunction) => {
    const user = req.headers['x-test-user'];
    if (!user) {
      res.status(401).json({ detail: 'Missing or invalid authorization header' });
      return;
    }
    req.user = String(user);
    next();
  },
}));

const express = (await import('express')).default;
const { config } = await import('../config.js');
const { default: healthRouter } = await import('./health.js');

let server: Server;
let base: string;

beforeAll(async () => {
  for (const dir of [config.serverPath, config.backupsPath, config.dataPath]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  perms.set('admin', ['*']);
  perms.set('viewer', ['server.view_status']);
  perms.set('settings', ['settings.view']);
  perms.set('limited', ['settings.view']);
  servers.set('limited', ['srv-2']);
  const app = express();
  app.use('/api/health', healthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (url: string, user?: string) =>
  fetch(`${base}${url}`, { headers: user ? { 'x-test-user': user } : {} });

describe('/api/health', () => {
  it('answers without a login', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'hytale-manager' });
  });
});

describe('/api/health/permissions', () => {
  it('needs a login', async () => {
    expect((await get('/api/health/permissions')).status).toBe(401);
  });

  it('needs settings.view', async () => {
    expect((await get('/api/health/permissions', 'viewer')).status).toBe(403);
    expect((await get('/api/health/permissions', 'settings')).status).toBe(200);
  });

  it('is refused to an account limited to some servers', async () => {
    const res = await get('/api/health/permissions', 'limited');

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('ALL_SERVERS_REQUIRED');
    expect(body).not.toContain(config.serverPath);
  });

  it('reports the folders without writing into them', async () => {
    const before = fs.readdirSync(config.dataPath);

    const res = await get('/api/health/permissions', 'admin');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      issues: Array<{ name: string }>;
      hostDataPath: string;
    };
    expect(body.issues.map((i) => i.name)).not.toContain('Data');
    // The fix command names the configured host folder, not a fixed one.
    expect(body.hostDataPath).toBe(config.hostDataPath);
    expect(fs.readdirSync(config.dataPath)).toEqual(before);
  });
});
