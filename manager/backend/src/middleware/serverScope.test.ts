/**
 * Server-scope middleware: id validation after authentication, the
 * multiserver gate, the legacy default id, the files guard and the
 * compose-only guard. Real registry against a temp dir; authentication is a
 * stub that accepts an `x-test-user` header.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-scope-'));
const instancesRoot = path.join(root, 'instances');
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
process.env.INSTANCES_PATH = instancesRoot;
delete process.env.MULTISERVER_ENABLED;
fs.mkdirSync(process.env.MANAGER_DATA_PATH, { recursive: true });
fs.mkdirSync(path.join(instancesRoot, 'aaaa0001', 'server'), { recursive: true });

function instance(id: string) {
  const base = path.join(instancesRoot, id).split(path.sep).join('/');
  const dirs = ['server', 'data', 'backups', 'mods', 'plugins', 'assets', 'auth'] as const;
  return {
    id,
    name: id,
    containerName: `hytale-srv-${id}`,
    status: 'ready',
    network: { serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084 },
    paths: Object.fromEntries(dirs.map((d) => [d, `${base}/${d}`])),
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: 'system',
  };
}

fs.writeFileSync(
  path.join(process.env.MANAGER_DATA_PATH, 'servers.json'),
  JSON.stringify({
    schemaVersion: 2,
    defaultId: 'default',
    servers: [
      { ...instance('default'), name: 'Primary' },
      instance('aaaa0001'),
      instance('bbbb0002'),
    ],
  }),
);

const authCalls = vi.fn();
vi.mock('./auth.js', () => ({
  authMiddleware: async (req: Request & { user?: string }, res: Response, next: NextFunction) => {
    authCalls();
    const user = req.headers['x-test-user'];
    if (user === 'broken') throw new Error('users file unreadable');
    if (typeof user !== 'string' || !user) {
      res.status(401).json({ detail: 'Missing or invalid authorization header' });
      return;
    }
    req.user = user;
    next();
  },
}));
// "bob" may only use the compose server.
vi.mock('./permissions.js', () => ({
  serverNotAllowed: (serverId: string) => ({
    error: 'No access to this server',
    code: 'SERVER_NOT_ALLOWED',
    serverId,
  }),
  mayAccessServer: async (req: { user?: string }, serverId: string) =>
    req.user !== 'bob' || serverId === 'default',
}));

const express = (await import('express')).default;
const scope = await import('./serverScope.js');
const { config } = await import('../config.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  const echo = (req: Request & { serverId?: string }, res: Response) =>
    res.json({ serverId: req.serverId ?? null });
  app.get('/api/legacy/thing', scope.legacyServerScope, echo);
  app.get('/api/servers/:serverId/thing', scope.serverScopeMiddleware, echo);
  app.get(
    '/api/servers/:serverId/files',
    scope.serverScopeMiddleware,
    scope.requireServerFiles,
    echo,
  );
  app.get(
    '/api/servers/:serverId/worlds',
    scope.serverScopeMiddleware,
    scope.composeServerOnly('World configs'),
    echo,
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  config.multiserverEnabled = false;
  authCalls.mockClear();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.INSTANCES_PATH;
});

async function get(url: string, user?: string) {
  const res = await fetch(`${base}${url}`, { headers: user ? { 'x-test-user': user } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('serverScopeMiddleware', () => {
  it('passes the compose server through without authenticating itself', async () => {
    expect(await get('/api/servers/default/thing')).toEqual({
      status: 200,
      body: { serverId: 'default' },
    });
    expect(authCalls).not.toHaveBeenCalled();
  });

  it('answers 401 before saying whether an id exists', async () => {
    expect((await get('/api/servers/nope/thing')).status).toBe(401);
    expect((await get('/api/servers/aaaa0001/thing')).status).toBe(401);
  });

  it('answers 404 for an unknown id once authenticated', async () => {
    expect(await get('/api/servers/nope/thing', 'alice')).toEqual({
      status: 404,
      body: { detail: 'Server not found' },
    });
  });

  it('refuses additional servers while multiserver is off', async () => {
    const r = await get('/api/servers/aaaa0001/thing', 'alice');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MULTISERVER_DISABLED');
  });

  it('answers a caller outside the server list like the permission check', async () => {
    expect(await get('/api/servers/aaaa0001/thing', 'bob')).toEqual({
      status: 403,
      body: { error: 'No access to this server', code: 'SERVER_NOT_ALLOWED', serverId: 'aaaa0001' },
    });
  });

  it('passes an authentication failure on instead of hanging', async () => {
    const res = await fetch(`${base}/api/servers/nope/thing`, {
      headers: { 'x-test-user': 'broken' },
    });
    expect(res.status).toBe(500);
  });

  it('scopes to an additional server with multiserver on', async () => {
    config.multiserverEnabled = true;
    expect(await get('/api/servers/aaaa0001/thing', 'alice')).toEqual({
      status: 200,
      body: { serverId: 'aaaa0001' },
    });
  });
});

describe('legacyServerScope', () => {
  it('sets the default server id on legacy routes', async () => {
    expect(await get('/api/legacy/thing')).toEqual({ status: 200, body: { serverId: 'default' } });
  });
});

describe('requireServerFiles', () => {
  it('lets the compose server and a visible instance through', async () => {
    config.multiserverEnabled = true;
    expect((await get('/api/servers/default/files', 'alice')).status).toBe(200);
    expect((await get('/api/servers/aaaa0001/files', 'alice')).status).toBe(200);
  });

  it('answers 409 server_files_unavailable for an instance without folder, after auth', async () => {
    config.multiserverEnabled = true;
    expect((await get('/api/servers/bbbb0002/files')).status).toBe(401);
    const r = await get('/api/servers/bbbb0002/files', 'alice');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ success: false, code: 'server_files_unavailable' });
    expect(['mount_missing', 'not_found']).toContain(r.body.reason);
    // Name and folder of the server only go to callers who may use it.
    const other = await get('/api/servers/bbbb0002/files', 'bob');
    expect(other.status).toBe(403);
    expect(other.body).not.toHaveProperty('detail');
  });
});

describe('composeServerOnly', () => {
  it('serves the compose server and refuses any other with 409', async () => {
    config.multiserverEnabled = true;
    expect((await get('/api/servers/default/worlds', 'alice')).status).toBe(200);
    const r = await get('/api/servers/aaaa0001/worlds', 'alice');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: 'compose_server_only' });
    expect(r.body.error).toMatch(/^World configs can only be used on the primary server/);
  });
});
