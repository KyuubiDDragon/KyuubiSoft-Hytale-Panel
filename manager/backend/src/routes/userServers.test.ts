/**
 * /api/auth/.../servers: reading and changing the server lists of users and
 * API keys without any way to widen one's own access.
 *
 * Real router, users.json, roles.json and api_keys table in a temp dir; the
 * registry and the auth middleware are stand-ins.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-user-servers-'));
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
const OPERATOR = ['server.view_status', 'server.stop', 'apikeys.manage'];
fs.writeFileSync(
  path.join(tmpDir, 'roles.json'),
  JSON.stringify({
    version: 1,
    lastModified: now,
    appliedMigrations: [],
    roles: [
      role('admin', ['*']),
      role('operator', OPERATOR),
      role('manager', [...OPERATOR, 'users.view', 'users.edit']),
      role('auditor', ['users.view', 'users.edit', 'audit.view']),
      role('rolemgr', [...OPERATOR, 'roles.manage']),
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
      user('root', 'admin'),
      user('boss', 'admin'),
      user('mgr', 'manager'),
      user('mgrb', 'manager', { allowedServers: [B] }),
      user('auditor', 'auditor'),
      user('opall', 'operator'),
      user('opb', 'operator', { allowedServers: [B] }),
      // roles.manage is held back while the list is there
      user('rmb', 'rolemgr', { allowedServers: [B] }),
      user('gone', 'operator', { allowedServers: [A, 'cccc0002'] }),
    ],
  }),
);

const { deleteHooks, addHooks } = vi.hoisted(() => ({
  deleteHooks: [] as Array<(serverId: string) => void | Promise<void>>,
  addHooks: [] as Array<(server: { id: string }) => void | Promise<void>>,
}));
vi.mock('../services/servers.js', () => ({
  listServers: async () => [{ id: 'default' }, { id: 'bbbb0001' }],
  getServer: async (id: string) => (['default', 'bbbb0001'].includes(id) ? { id } : null),
  getDefaultId: async () => 'default',
  onServerDeleted: (hook: (serverId: string) => void | Promise<void>) => {
    deleteHooks.push(hook);
    return () => undefined;
  },
  onServerAdded: (hook: (server: { id: string }) => void | Promise<void>) => {
    addHooks.push(hook);
    return () => undefined;
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
    if (typeof key === 'string') req.apiKey = { id: 'k-test', ...JSON.parse(key) };
    next();
  },
}));

const express = (await import('express')).default;
const { default: userServersRouter } = await import('./userServers.js');
const { createApiKey, getOwnApiKey, revokeApiKey, setApiKeyServerIds } =
  await import('../services/apiKeys.js');
const { getUserPermissionsForServer } = await import('../services/roles.js');
const { closeDb } = await import('../db/index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', userServersRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: String(err) });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  method: string,
  url: string,
  username: string,
  body?: unknown,
  key?: { scopes: string[]; serverIds?: string[] | null },
) {
  const headers: Record<string, string> = {
    'x-test-user': username,
    'content-type': 'application/json',
  };
  if (key) headers['x-test-key'] = JSON.stringify(key);
  const r = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

describe('user server lists', () => {
  it('lets a user manager limit an account and lift the limit again', async () => {
    const put = await call('PUT', '/api/auth/users/opall/servers', 'mgr', {
      allowedServers: [B, B],
    });
    expect(put).toMatchObject({ status: 200, body: { success: true, allowedServers: [B] } });
    expect(await getUserPermissionsForServer('opall', A)).toEqual([]);
    expect(await getUserPermissionsForServer('opall', B)).toContain('server.stop');
    expect((await call('GET', '/api/auth/users/opall/servers', 'mgr')).body).toEqual({
      username: 'opall',
      allowedServers: [B],
      unrestricted: false,
    });

    expect(
      (await call('PUT', '/api/auth/users/opall/servers', 'mgr', { allowedServers: null })).status,
    ).toBe(200);
    expect((await call('GET', '/api/auth/users/opall/servers', 'mgr')).body).toMatchObject({
      allowedServers: null,
      unrestricted: true,
    });
  });

  it('reports an admin as unrestricted whatever its list says', async () => {
    expect(
      (await call('PUT', '/api/auth/users/boss/servers', 'root', { allowedServers: [B] })).status,
    ).toBe(200);
    expect((await call('GET', '/api/auth/users/boss/servers', 'root')).body).toMatchObject({
      allowedServers: [B],
      unrestricted: true,
    });
    expect(await getUserPermissionsForServer('boss', A)).toEqual(['*']);
  });

  it('rejects malformed lists and unknown servers', async () => {
    for (const body of [{}, { allowedServers: B }, { allowedServers: ['../etc'] }]) {
      expect(await call('PUT', '/api/auth/users/opall/servers', 'mgr', body)).toMatchObject({
        status: 400,
        body: { code: 'INVALID_SERVER_LIST' },
      });
    }
    expect(
      await call('PUT', '/api/auth/users/opall/servers', 'mgr', { allowedServers: ['ffff9999'] }),
    ).toMatchObject({ status: 400, body: { code: 'UNKNOWN_SERVER', serverIds: ['ffff9999'] } });
  });

  it('answers 404 for an unknown user', async () => {
    expect(
      (await call('PUT', '/api/auth/users/nobody/servers', 'mgr', { allowedServers: [A] })).status,
    ).toBe(404);
  });

  it('refuses a limited manager its own escalation (no users.edit with a list)', async () => {
    const r = await call('PUT', '/api/auth/users/mgrb/servers', 'mgrb', { allowedServers: null });
    expect(r.status).toBe(403);
    expect(
      (await call('PUT', '/api/auth/users/opb/servers', 'mgrb', { allowedServers: [A, B] })).status,
    ).toBe(403);
  });

  it('refuses a key with a server list, even with an admin owner', async () => {
    const r = await call(
      'PUT',
      '/api/auth/users/root/servers',
      'root',
      { allowedServers: null },
      { scopes: ['*'], serverIds: [B] },
    );
    expect(r.status).toBe(403);
  });

  it('refuses to change an account holding rights the caller lacks', async () => {
    // auditor has users.edit but not the operator rights of opb, nor admin
    for (const target of ['opb', 'root']) {
      expect(
        await call('PUT', `/api/auth/users/${target}/servers`, 'auditor', { allowedServers: [A] }),
      ).toMatchObject({ status: 403, body: { code: 'TARGET_OUTRANKS_YOU' } });
    }
  });

  it('counts the rights a list holds back when the list would be lifted', async () => {
    // mgr lacks roles.manage, which rmb gets back without the list
    expect(
      await call('PUT', '/api/auth/users/rmb/servers', 'mgr', { allowedServers: null }),
    ).toMatchObject({ status: 403, body: { code: 'TARGET_OUTRANKS_YOU' } });
    expect(
      (await call('PUT', '/api/auth/users/rmb/servers', 'root', { allowedServers: null })).status,
    ).toBe(200);
  });

  it('needs users.edit to change and users.view to read', async () => {
    expect(
      (await call('PUT', '/api/auth/users/opb/servers', 'opall', { allowedServers: [A] })).status,
    ).toBe(403);
    expect((await call('GET', '/api/auth/users/opb/servers', 'opall')).status).toBe(403);
  });
});

describe('API key server lists', () => {
  it('lets a limited owner narrow a key to its own servers, not beyond', async () => {
    const { key } = await createApiKey({
      ownerUsername: 'opb',
      name: 'k',
      scopes: ['server.stop'],
    });
    const url = `/api/auth/api-keys/${key.id}/servers`;
    expect(await call('PUT', url, 'opb', { serverIds: [A] })).toMatchObject({
      status: 403,
      body: { code: 'SERVERS_NOT_HELD', serverIds: [A] },
    });
    expect((await call('PUT', url, 'opb', { serverIds: [B] })).status).toBe(200);
    expect(getOwnApiKey('opb', key.id)?.serverIds).toEqual([B]);
    expect((await call('GET', url, 'opb')).body).toEqual({ id: key.id, serverIds: [B] });
    // null = follow the owner, which never reaches beyond the owner's servers
    expect((await call('PUT', url, 'opb', { serverIds: null })).status).toBe(200);
    expect(getOwnApiKey('opb', key.id)?.serverIds).toBeNull();
  });

  it("only touches the caller's own, active keys", async () => {
    const { key } = await createApiKey({ ownerUsername: 'opall', name: 'k', scopes: [] });
    const url = `/api/auth/api-keys/${key.id}/servers`;
    expect((await call('PUT', url, 'opb', { serverIds: [B] })).status).toBe(404);
    expect((await call('GET', url, 'opb')).status).toBe(404);
    revokeApiKey('opall', key.id);
    expect((await call('PUT', url, 'opall', { serverIds: [B] })).status).toBe(404);
  });

  it('refuses a key with a list to manage keys', async () => {
    const { key } = await createApiKey({ ownerUsername: 'opall', name: 'k', scopes: [] });
    const r = await call(
      'PUT',
      `/api/auth/api-keys/${key.id}/servers`,
      'opall',
      { serverIds: null },
      { scopes: ['apikeys.manage'], serverIds: [B] },
    );
    expect(r.status).toBe(403);
    expect(getOwnApiKey('opall', key.id)?.serverIds).toBeNull();
  });
});

describe('deleted servers', () => {
  it('leave no id behind in user and key lists', async () => {
    const { key } = await createApiKey({ ownerUsername: 'opall', name: 'd', scopes: [] });
    setApiKeyServerIds('opall', key.id, [A, 'cccc0002']);
    expect(deleteHooks).toHaveLength(1);
    await deleteHooks[0]('cccc0002');
    expect((await call('GET', '/api/auth/users/gone/servers', 'root')).body).toMatchObject({
      allowedServers: [A],
    });
    expect(getOwnApiKey('opall', key.id)?.serverIds).toEqual([A]);
  });

  it('give a new server under a listed id no old grants, and install the hooks once', async () => {
    const { installServerListCleanup } = await import('../services/serverLists.js');
    installServerListCleanup();
    expect(addHooks).toHaveLength(1);
    expect(deleteHooks).toHaveLength(1);
    const { key } = await createApiKey({ ownerUsername: 'opall', name: 'e', scopes: [] });
    setApiKeyServerIds('opall', key.id, [A, 'dddd0003']);
    await addHooks[0]({ id: 'dddd0003' });
    expect(getOwnApiKey('opall', key.id)?.serverIds).toEqual([A]);
  });
});

describe('GET /me/servers', () => {
  it("names the caller's servers, narrowed by its key", async () => {
    expect((await call('GET', '/api/auth/me/servers', 'opb')).body).toEqual({
      allowedServers: [B],
      unrestricted: false,
    });
    expect((await call('GET', '/api/auth/me/servers', 'root')).body).toEqual({
      allowedServers: null,
      unrestricted: true,
    });
    const viaKey = await call('GET', '/api/auth/me/servers', 'opall', undefined, {
      scopes: [],
      serverIds: [A],
    });
    expect(viaKey.body).toEqual({ allowedServers: [A], unrestricted: false });
  });
});
