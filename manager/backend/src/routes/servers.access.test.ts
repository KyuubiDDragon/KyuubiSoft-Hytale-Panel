/**
 * Server lists on the registry routes: a user or API key limited to some
 * servers only sees and changes those, and registry-wide actions (adding a
 * server, moving the default, reconcile, trash) need every server.
 *
 * Real registry, router, permissions middleware, users.json and roles.json
 * in a temp dir; auth is a stand-in and Docker is never reached (every
 * request here is refused before a handler would touch a container, or only
 * reads the registry).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-servers-access-'));
fs.mkdirSync(path.join(tmpDir, 'instances'), { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.INSTANCES_PATH = path.join(tmpDir, 'instances');
process.env.MULTISERVER_ENABLED = 'true';
delete process.env.DEMO_MODE;

const now = new Date().toISOString();
const SERVERS_ALL = ['servers.list', 'servers.create', 'servers.manage', 'servers.delete'];
fs.writeFileSync(
  path.join(tmpDir, 'roles.json'),
  JSON.stringify({
    version: 1,
    lastModified: now,
    appliedMigrations: ['mod-panel-permissions', 'servers-manage-permission'],
    roles: [
      {
        id: 'admin',
        name: 'admin',
        description: '',
        permissions: ['*'],
        isSystem: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'srvadmin',
        name: 'srvadmin',
        description: '',
        permissions: SERVERS_ALL,
        isSystem: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }),
);
const user = (username: string, roleId: string, extra: Record<string, unknown> = {}) => ({
  username,
  passwordHash: 'x',
  roleId,
  createdAt: now,
  tokenVersion: 1,
  ...extra,
});
const usersFile = path.join(tmpDir, 'users.json');

vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../services/docker.js', () => ({
  getDockerInstance: () => {
    throw new Error('Docker must not be reached in this test');
  },
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (
    req: Request & { user?: string; apiKey?: unknown },
    _res: Response,
    next: NextFunction,
  ) => {
    req.user = String(req.headers['x-test-user'] ?? '');
    const key = req.headers['x-test-key'];
    if (typeof key === 'string') req.apiKey = { id: 'k1', ...JSON.parse(key) };
    next();
  },
}));

const express = (await import('express')).default;
const registry = await import('../services/servers.js');
const { default: serversRouter } = await import('./servers.js');

let server: Server;
let base: string;
let B: string;

beforeAll(async () => {
  const created = await registry.createServerInstance({ name: 'B', createdBy: 'test' });
  B = created.id;
  await registry.updateServerInstance(B, { status: 'ready' });
  fs.writeFileSync(
    usersFile,
    JSON.stringify({
      users: [
        user('root', 'admin', { allowedServers: [B] }),
        user('all', 'srvadmin'),
        user('onlyb', 'srvadmin', { allowedServers: [B] }),
        user('nolist', 'nobody'),
      ],
    }),
  );
  const app = express();
  app.use(express.json());
  app.use('/api/servers', serversRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/servers`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  suffix: string,
  username: string,
  body?: unknown,
  key?: { scopes: string[]; serverIds?: string[] | null },
) {
  const headers: Record<string, string> = {
    'x-test-user': username,
    'content-type': 'application/json',
  };
  if (key) headers['x-test-key'] = JSON.stringify(key);
  const res = await fetch(`${base}${suffix}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const ids = (r: { body: Record<string, unknown> }) =>
  (r.body.servers as Array<{ id: string }>).map((s) => s.id).sort();

describe('GET /api/servers', () => {
  it('lists every server for callers without a list, and for admins', async () => {
    expect(ids(await call('GET', '/', 'all'))).toEqual(['default', B].sort());
    expect(ids(await call('GET', '/', 'root'))).toEqual(['default', B].sort());
  });

  it('lists only the allowed servers for a user or key with a list', async () => {
    expect(ids(await call('GET', '/', 'onlyb'))).toEqual([B]);
    const key = { scopes: ['servers.list'], serverIds: ['default'] };
    expect(ids(await call('GET', '/', 'all', undefined, key))).toEqual(['default']);
  });
});

describe('/api/servers/:id', () => {
  it('reads an allowed server and refuses another one', async () => {
    expect((await call('GET', `/${B}`, 'onlyb')).status).toBe(200);
    expect(await call('GET', '/default', 'onlyb')).toMatchObject({
      status: 200, // GET /default is the default pointer, not the server
    });
    expect(await call('PUT', '/default', 'onlyb', { name: 'Taken over' })).toMatchObject({
      status: 403,
      body: { code: 'SERVER_NOT_ALLOWED', serverId: 'default' },
    });
    expect(await call('DELETE', '/default', 'onlyb')).toMatchObject({
      status: 403,
      body: { code: 'SERVER_NOT_ALLOWED' },
    });
    expect((await registry.getServer('default'))?.name).not.toBe('Taken over');
  });

  it('lets a caller rename a server on its list', async () => {
    expect((await call('PUT', `/${B}`, 'onlyb', { name: 'B renamed' })).status).toBe(200);
    expect((await registry.getServer(B))?.name).toBe('B renamed');
  });
});

describe('default pointer', () => {
  it('needs servers.list to read', async () => {
    expect((await call('GET', '/_default', 'all')).body).toEqual({ defaultId: 'default' });
    expect((await call('GET', '/_default', 'nolist')).status).toBe(403);
    expect((await call('GET', '/default', 'nolist')).status).toBe(403);
  });
});

describe('registry-wide actions', () => {
  it('need every server', async () => {
    const refused = { status: 403, body: { code: 'ALL_SERVERS_REQUIRED' } };
    expect(await call('PUT', '/_default', 'onlyb', { id: B })).toMatchObject(refused);
    expect(await call('PUT', '/default', 'onlyb', { id: B })).toMatchObject(refused);
    expect(await call('POST', '/', 'onlyb', { name: 'New' })).toMatchObject(refused);
    expect(await call('POST', '/_reconcile', 'onlyb')).toMatchObject(refused);
    expect(await call('GET', '/_trash', 'onlyb')).toMatchObject(refused);
    expect(await call('DELETE', '/_trash/x', 'onlyb')).toMatchObject(refused);
    const keyB = { scopes: ['servers.manage'], serverIds: [B] };
    expect(await call('PUT', '/_default', 'all', { id: B }, keyB)).toMatchObject(refused);
    expect(await registry.getDefaultId()).toBe('default');
  });

  it('stay available to callers with every server', async () => {
    expect((await call('PUT', '/_default', 'all', { id: 'default' })).status).toBe(200);
    expect((await call('PUT', '/_default', 'root', { id: 'default' })).status).toBe(200);
    // Another target passes the access check and becomes the default.
    expect((await call('PUT', '/_default', 'all', { id: B })).status).toBe(200);
    expect(await registry.getDefaultId()).toBe(B);
    expect((await call('PUT', '/_default', 'all', { id: 'default' })).status).toBe(200);
    expect(await registry.getDefaultId()).toBe('default');
  });
});
