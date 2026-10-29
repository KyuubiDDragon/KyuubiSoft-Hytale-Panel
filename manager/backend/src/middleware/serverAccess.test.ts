/**
 * Server lists for users (allowedServers) and API keys (serverIds), enforced
 * by requirePermission through the real roles and users services:
 *  - a user or key outside its list gets 403 SERVER_NOT_ALLOWED on scoped
 *    routes and on legacy routes (which act on the default server)
 *  - no list = every server (unchanged behaviour), admin '*' ignores its list
 *  - per-server role overrides only count inside the list
 *  - broken list data limits to no server
 *  - an account with a list loses the panel-wide account rights, a key with a
 *    list also the key management
 *  - the helpers for the registry routes (filter, :id access, all servers)
 *
 * Real users.json and roles.json in a temp dir; the registry, the auth
 * middleware and the legacy default-server middleware are stand-ins.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const A = 'default';
const B = 'bbbb0001';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-server-access-'));
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const now = new Date().toISOString();
const role = (id: string, permissions: string[]) => ({
  id,
  name: id,
  description: '',
  permissions,
  isSystem: false,
  createdAt: now,
  updatedAt: now,
});
const OPERATOR = ['server.view_status', 'server.stop', 'console.view', 'apikeys.manage'];
// Panel-wide rights an account with a server list must not keep.
const PANEL_WIDE = [
  'users.view',
  'users.create',
  'users.edit',
  'roles.manage',
  'webhooks.manage',
  'settings.edit',
  'audit.view',
  'audit.export',
];
const MANAGER_EXTRA = ['roles.view', 'webhooks.view', 'settings.view', ...PANEL_WIDE];
fs.writeFileSync(
  path.join(tmpDir, 'roles.json'),
  JSON.stringify({
    version: 1,
    lastModified: now,
    appliedMigrations: [],
    roles: [
      role('admin', ['*']),
      role('operator', OPERATOR),
      role('viewer', ['server.view_status']),
      role('manager', [...OPERATOR, ...MANAGER_EXTRA]),
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
fs.writeFileSync(
  path.join(tmpDir, 'users.json'),
  JSON.stringify({
    users: [
      user('root', 'admin', { allowedServers: [B] }),
      user('opall', 'operator'),
      user('opb', 'operator', { allowedServers: [B] }),
      user('opnone', 'operator', { allowedServers: [] }),
      user('opbroken', 'operator', { allowedServers: B }),
      user('mgr', 'manager'),
      user('mgrb', 'manager', { allowedServers: [B] }),
      // viewer everywhere it may go, operator on B through a per-server role
      user('scoped', 'viewer', {
        allowedServers: [A],
        serverScopes: { [B]: { roleId: 'operator' } },
      }),
    ],
  }),
);

vi.mock('../services/servers.js', () => ({
  listServers: async () => [{ id: 'default' }, { id: 'bbbb0001' }, { id: 'cccc0002' }],
  getServer: async (id: string) =>
    ['default', 'bbbb0001', 'cccc0002'].includes(id) ? { id } : null,
  getDefaultId: async () => 'default',
}));
// x-test-user = the user; x-test-key = JSON { scopes, serverIds? } marks an API key.
vi.mock('./auth.js', () => ({
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
const { authMiddleware } = await import('./auth.js');
const { requirePermission, requireServerAccess, requireAllServerAccess, filterAccessibleServers } =
  await import('./permissions.js');
const { getUserPermissions } = await import('../services/roles.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const probe = express.Router();
  probe.post('/stop', authMiddleware, requirePermission('server.stop'), (req, res) => {
    res.json({ ok: true, serverId: req.serverId });
  });
  const accounts = express.Router();
  accounts.post('/users', authMiddleware, requirePermission('users.create'), (_req, res) => {
    res.json({ ok: true });
  });
  accounts.post('/keys', authMiddleware, requirePermission('apikeys.manage'), (_req, res) => {
    res.json({ ok: true });
  });
  const registry = express.Router();
  registry.get('/', authMiddleware, async (req, res) => {
    const all = [{ id: A }, { id: B }, { id: 'cccc0002' }];
    res.json({ servers: (await filterAccessibleServers(req, all)).map((s) => s.id) });
  });
  registry.post('/', authMiddleware, requireAllServerAccess(), (_req, res) => {
    res.json({ ok: true });
  });
  registry.get('/:id', authMiddleware, requireServerAccess('id'), (req, res) => {
    res.json({ id: req.params.id });
  });

  const app = express();
  app.use(express.json());
  // Stand-ins for the scope middlewares: scoped mount and legacy (default server).
  app.use(
    '/api/servers/:serverId/server',
    (req: Request, _res: Response, next: NextFunction) => {
      req.serverId = req.params.serverId;
      next();
    },
    probe,
  );
  app.use(
    '/api/server',
    (req: Request, _res: Response, next: NextFunction) => {
      req.serverId = A;
      next();
    },
    probe,
  );
  app.use('/api/registry', registry);
  app.use('/api/accounts', accounts);
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  url: string,
  username: string,
  key?: { scopes: string[]; serverIds?: string[] | null },
) {
  const headers: Record<string, string> = { 'x-test-user': username };
  if (key) headers['x-test-key'] = JSON.stringify(key);
  const r = await fetch(`${base}${url}`, { method, headers });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const stop = (serverId: string | null, username: string, key?: Parameters<typeof call>[3]) =>
  call(
    'POST',
    serverId ? `/api/servers/${serverId}/server/stop` : '/api/server/stop',
    username,
    key,
  );

describe('user server lists', () => {
  it('gives a user without a list every server, as before', async () => {
    expect((await stop(A, 'opall')).status).toBe(200);
    expect((await stop(B, 'opall')).status).toBe(200);
    expect((await stop(null, 'opall')).status).toBe(200);
  });

  it('allows a user with allowedServers:[B] on B', async () => {
    expect(await stop(B, 'opb')).toMatchObject({ status: 200, body: { serverId: B } });
  });

  it('answers 403 SERVER_NOT_ALLOWED on A for a user limited to B', async () => {
    expect(await stop(A, 'opb')).toMatchObject({
      status: 403,
      body: { code: 'SERVER_NOT_ALLOWED', serverId: A },
    });
  });

  it('also refuses the legacy route, which acts on the default server A', async () => {
    expect(await stop(null, 'opb')).toMatchObject({
      status: 403,
      body: { code: 'SERVER_NOT_ALLOWED', serverId: A },
    });
  });

  it('refuses every server to a user with an empty list', async () => {
    expect((await stop(A, 'opnone')).status).toBe(403);
    expect((await stop(B, 'opnone')).status).toBe(403);
  });

  it('treats a list that is not an array of ids as no server (fail closed)', async () => {
    expect((await stop(B, 'opbroken')).status).toBe(403);
    expect((await stop(A, 'opbroken')).status).toBe(403);
  });

  it('lets admin * ignore its own list', async () => {
    expect((await stop(A, 'root')).status).toBe(200);
    expect((await stop(null, 'root')).status).toBe(200);
  });

  it('applies a per-server role only inside the list', async () => {
    // B is outside the list: the operator override there does not count.
    expect((await stop(B, 'scoped')).body).toMatchObject({ code: 'SERVER_NOT_ALLOWED' });
    // A is inside the list, but the viewer role has no server.stop.
    expect(await stop(A, 'scoped')).toMatchObject({
      status: 403,
      body: { error: 'Insufficient permissions' },
    });
  });
});

describe('API key server lists', () => {
  const opKey = (serverIds?: string[] | null) => ({ scopes: ['server.stop'], serverIds });

  it('lets a key without a list act wherever its owner may', async () => {
    expect((await stop(A, 'opall', opKey())).status).toBe(200);
    expect((await stop(A, 'opall', opKey(null))).status).toBe(200);
  });

  it('keeps a key with serverIds:[B] off A, scoped and legacy', async () => {
    expect(await stop(A, 'opall', opKey([B]))).toMatchObject({
      status: 403,
      body: { code: 'SERVER_NOT_ALLOWED' },
    });
    expect((await stop(null, 'opall', opKey([B]))).status).toBe(403);
    expect((await stop(B, 'opall', opKey([B]))).status).toBe(200);
  });

  it("binds a key to its owner's list as well", async () => {
    // The key names A, but its owner may only use B.
    expect((await stop(A, 'opb', opKey([A, B]))).status).toBe(403);
    expect((await stop(B, 'opb', opKey())).status).toBe(200);
  });

  it("limits an admin's key to its list too", async () => {
    const key = { scopes: ['*'], serverIds: [B] };
    expect((await stop(A, 'root', key)).status).toBe(403);
    expect((await stop(B, 'root', key)).status).toBe(200);
  });
});

describe('account rights of limited accounts and keys', () => {
  it('keeps the account rights of a manager without a list', async () => {
    expect((await call('POST', '/api/accounts/users', 'mgr')).status).toBe(200);
    expect(await getUserPermissions('mgr')).toContain('users.edit');
  });

  it('drops the panel-wide rights for a manager with a list', async () => {
    expect((await call('POST', '/api/accounts/users', 'mgrb')).status).toBe(403);
    const perms = await getUserPermissions('mgrb');
    for (const p of PANEL_WIDE) expect(perms).not.toContain(p);
    // reading stays, and own keys: a key of a limited owner is limited the same way
    for (const p of ['roles.view', 'webhooks.view', 'settings.view', 'apikeys.manage']) {
      expect(perms).toContain(p);
    }
    // the same role without a list keeps everything
    const full = await getUserPermissions('mgr');
    for (const p of PANEL_WIDE) expect(full).toContain(p);
  });

  it('drops account and key management for a key with a list, even with scope *', async () => {
    const limited = { scopes: ['*'], serverIds: [B] };
    expect((await call('POST', '/api/accounts/users', 'root', limited)).status).toBe(403);
    expect((await call('POST', '/api/accounts/keys', 'root', limited)).status).toBe(403);
    expect((await call('POST', '/api/accounts/keys', 'root', { scopes: ['*'] })).status).toBe(200);
  });
});

describe('registry helpers', () => {
  it('lists only the allowed servers', async () => {
    expect((await call('GET', '/api/registry', 'opb')).body.servers).toEqual([B]);
    expect((await call('GET', '/api/registry', 'opnone')).body.servers).toEqual([]);
    expect((await call('GET', '/api/registry', 'opall')).body.servers).toEqual([A, B, 'cccc0002']);
    expect((await call('GET', '/api/registry', 'root')).body.servers).toHaveLength(3);
    expect(
      (await call('GET', '/api/registry', 'opall', { scopes: [], serverIds: [A] })).body.servers,
    ).toEqual([A]);
  });

  it('guards a server named in the path', async () => {
    expect((await call('GET', `/api/registry/${B}`, 'opb')).status).toBe(200);
    expect(await call('GET', `/api/registry/${A}`, 'opb')).toMatchObject({
      status: 403,
      body: { code: 'SERVER_NOT_ALLOWED', serverId: A },
    });
  });

  it('reserves registry-wide actions for callers with every server', async () => {
    expect((await call('POST', '/api/registry', 'opall')).status).toBe(200);
    expect((await call('POST', '/api/registry', 'root')).status).toBe(200);
    expect(await call('POST', '/api/registry', 'opb')).toMatchObject({
      status: 403,
      body: { code: 'ALL_SERVERS_REQUIRED' },
    });
    expect(
      (await call('POST', '/api/registry', 'opall', { scopes: [], serverIds: [A, B] })).status,
    ).toBe(403);
  });
});
