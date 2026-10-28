/**
 * No privilege escalation through account or role management:
 *  - accounts are created, changed (password, role) and deleted only by a
 *    caller holding every right of that account; an admin only by an admin
 *  - nobody grants a role, a permission or a server beyond their own
 *  - roles: catalog permissions only, '*' only by an admin, system roles only
 *    by an admin, no widening of one's own role, no reshaping of a stronger role
 *
 * Real auth and roles routers with real users.json / roles.json in a temp dir;
 * the auth middleware, the registry, Docker and logging are stand-ins.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const B = 'bbbb0001';
const PASSWORD = 'Vq7!mZr2#Lp9xW';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-account-policy-'));
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const now = new Date().toISOString();
const role = (id: string, permissions: string[], isSystem = false) => ({
  id,
  name: id,
  description: '',
  permissions,
  isSystem,
  createdAt: now,
  updatedAt: now,
});
const BASIC = ['server.view_status', 'players.view'];
fs.writeFileSync(
  path.join(tmpDir, 'roles.json'),
  JSON.stringify({
    version: 1,
    lastModified: now,
    appliedMigrations: [],
    roles: [
      role('admin', ['*'], true),
      role('operator', [...BASIC, 'server.stop', 'console.execute'], true),
      role('viewer', BASIC, true),
      role('usermgr', [...BASIC, 'users.view', 'users.create', 'users.edit', 'users.delete']),
      role('rolemgr', [...BASIC, 'roles.view', 'roles.manage', 'backups.view']),
      role('small', ['players.view']),
      role('big', [...BASIC, 'users.delete']),
      role('legacy', ['players.view', 'old.removed_permission']),
    ],
  }),
);
const user = (username: string, roleId: string) => ({
  username,
  passwordHash: `hash-of-${username}`,
  roleId,
  createdAt: now,
  tokenVersion: 1,
});
const usersFile = path.join(tmpDir, 'users.json');
fs.writeFileSync(
  usersFile,
  JSON.stringify({
    users: [
      user('root', 'admin'),
      user('root2', 'admin'),
      user('usermgr', 'usermgr'),
      user('rolemgr', 'rolemgr'),
      user('op1', 'operator'),
      user('viewer1', 'viewer'),
      user('viewer2', 'viewer'),
      // carries the id of a role that no longer exists
      user('orphan', 'gone-role-id'),
    ],
  }),
);
const passwordHashOf = (name: string) =>
  JSON.parse(fs.readFileSync(usersFile, 'utf-8')).users.find(
    (u: { username: string }) => u.username === name,
  )?.passwordHash;

vi.mock('../services/servers.js', () => ({
  listServers: async () => [{ id: 'default' }, { id: 'bbbb0001' }],
  getServer: async (id: string) => (['default', 'bbbb0001'].includes(id) ? { id } : null),
  getDefaultId: async () => 'default',
  resolveServerId: async (id?: string) => id ?? 'default',
  onServerDeleted: () => () => undefined,
  onServerAdded: () => () => undefined,
}));
vi.mock('../services/docker.js', () => ({
  execCommand: vi.fn(async () => ({ success: true })),
  getLogs: vi.fn(async () => ''),
}));
vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../services/activityLog.js', () => ({ logActivity: vi.fn(async () => undefined) }));
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
const { default: authRouter } = await import('./auth.js');
const { default: rolesRouter } = await import('./roles.js');
const { getUser } = await import('../services/users.js');
const { getRole } = await import('../services/roles.js');
const { closeDb } = await import('../db/index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/roles', rolesRouter);
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

describe('accounts: password, role and deletion', () => {
  it("refuses a users.edit holder the admin's password", async () => {
    const before = passwordHashOf('root');
    const r = await call('PUT', '/api/auth/users/root', 'usermgr', { password: PASSWORD });
    expect(r).toMatchObject({ status: 403, body: { code: 'TARGET_OUTRANKS_YOU' } });
    expect(passwordHashOf('root')).toBe(before);
  });

  it('refuses the password of an account with rights the caller lacks', async () => {
    const r = await call('PUT', '/api/auth/users/op1', 'usermgr', { password: PASSWORD });
    expect(r).toMatchObject({ status: 403, body: { code: 'TARGET_OUTRANKS_YOU' } });
  });

  it('allows it for an account within the caller’s rights, and for an admin anywhere', async () => {
    expect(
      (await call('PUT', '/api/auth/users/viewer1', 'usermgr', { password: PASSWORD })).status,
    ).toBe(200);
    expect(passwordHashOf('viewer1')).not.toBe('hash-of-viewer1');
    expect((await call('PUT', '/api/auth/users/op1', 'root', { password: PASSWORD })).status).toBe(
      200,
    );
  });

  it('refuses roles beyond the caller, on change and on creation', async () => {
    expect(
      await call('PUT', '/api/auth/users/viewer2', 'usermgr', { roleId: 'admin' }),
    ).toMatchObject({ status: 403, body: { code: 'ROLE_EXCEEDS_YOURS' } });
    expect(
      await call('POST', '/api/auth/users', 'usermgr', {
        username: 'newop',
        password: PASSWORD,
        roleId: 'operator',
      }),
    ).toMatchObject({ status: 403, body: { code: 'ROLE_EXCEEDS_YOURS' } });
    expect(await getUser('newop')).toBeNull();
    expect((await getUser('viewer2'))?.roleId).toBe('viewer');
  });

  it('creates an account within the caller’s rights, with a server list if named', async () => {
    const r = await call('POST', '/api/auth/users', 'usermgr', {
      username: 'newviewer',
      password: PASSWORD,
      roleId: 'viewer',
      allowedServers: [B],
    });
    expect(r).toMatchObject({ status: 200, body: { user: { allowedServers: [B] } } });
    expect((await getUser('newviewer'))?.allowedServers).toEqual([B]);
    // without a list the new account has every server, as before
    await call('POST', '/api/auth/users', 'usermgr', {
      username: 'plainviewer',
      password: PASSWORD,
      roleId: 'viewer',
    });
    expect((await getUser('plainviewer'))?.allowedServers).toBeUndefined();
    expect(
      await call('POST', '/api/auth/users', 'usermgr', {
        username: 'badlist',
        password: PASSWORD,
        allowedServers: 'all',
      }),
    ).toMatchObject({ status: 400, body: { code: 'INVALID_SERVER_LIST' } });
  });

  it('refuses deleting an admin or a stronger account, allows a weaker one', async () => {
    expect((await call('DELETE', '/api/auth/users/root', 'usermgr')).body).toMatchObject({
      code: 'TARGET_OUTRANKS_YOU',
    });
    expect((await call('DELETE', '/api/auth/users/op1', 'usermgr')).status).toBe(403);
    expect(await getUser('root')).not.toBeNull();
    expect((await call('DELETE', '/api/auth/users/viewer2', 'usermgr')).status).toBe(200);
    expect(await getUser('viewer2')).toBeNull();
    expect((await call('DELETE', '/api/auth/users/root2', 'root')).status).toBe(200);
  });

  it('limits an API key to its own scopes, even with an admin owner', async () => {
    const key = { scopes: ['users.view', 'users.edit'] };
    const r = await call('PUT', '/api/auth/users/viewer1', 'root', { password: PASSWORD }, key);
    expect(r).toMatchObject({ status: 403, body: { code: 'TARGET_OUTRANKS_YOU' } });
  });

  it('accepts existing roles only, as a plain id', async () => {
    expect(
      await call('PUT', '/api/auth/users/viewer1', 'root', { roleId: { evil: true } }),
    ).toMatchObject({ status: 400 });
    expect(await call('PUT', '/api/auth/users/viewer1', 'root', { roleId: 'nope' })).toMatchObject({
      status: 400,
      body: { code: 'UNKNOWN_ROLE' },
    });
    expect(
      await call('POST', '/api/auth/users', 'root', {
        username: 'norole',
        password: PASSWORD,
        roleId: 'nope',
      }),
    ).toMatchObject({ status: 400, body: { code: 'UNKNOWN_ROLE' } });
    expect((await getUser('viewer1'))?.roleId).toBe('viewer');
    const { updateUser } = await import('../services/users.js');
    await expect(updateUser('viewer1', { roleId: 'nope' })).rejects.toThrow('Unknown role');
  });

  it('answers 404 for an unknown account', async () => {
    expect(
      (await call('PUT', '/api/auth/users/nobody', 'root', { password: PASSWORD })).status,
    ).toBe(404);
    expect((await call('DELETE', '/api/auth/users/nobody', 'root')).status).toBe(404);
  });
});

describe('roles', () => {
  const create = (by: string, permissions: unknown, name = `r-${Math.random()}`) =>
    call('POST', '/api/roles', by, { name, description: 'd', permissions });

  it('creates a role within the caller’s permissions', async () => {
    expect((await create('rolemgr', ['players.view', 'backups.view'])).status).toBe(201);
  });

  it('refuses permissions the caller lacks, and * for anyone but an admin', async () => {
    expect(await create('rolemgr', ['players.view', 'users.delete'])).toMatchObject({
      status: 403,
      body: { code: 'PERMISSIONS_EXCEED_YOURS', permissions: ['users.delete'] },
    });
    expect(await create('rolemgr', ['*'])).toMatchObject({
      status: 403,
      body: { code: 'PERMISSIONS_EXCEED_YOURS' },
    });
    expect((await create('root', ['*'])).status).toBe(201);
  });

  it('accepts catalog permissions only', async () => {
    expect(await create('root', ['players.view', 'made.up'])).toMatchObject({
      status: 400,
      body: { code: 'UNKNOWN_PERMISSION', permissions: ['made.up'] },
    });
    expect(await create('root', 'players.view')).toMatchObject({
      status: 400,
      body: { code: 'INVALID_PERMISSIONS' },
    });
  });

  it('refuses widening the caller’s own role', async () => {
    const r = await call('PUT', '/api/roles/rolemgr', 'rolemgr', {
      permissions: [...BASIC, 'roles.view', 'roles.manage', 'backups.view', 'users.delete'],
    });
    expect(r).toMatchObject({ status: 403, body: { code: 'PERMISSIONS_EXCEED_YOURS' } });
    expect((await getRole('rolemgr'))?.permissions).not.toContain('users.delete');
  });

  it('protects system roles from everyone but an admin', async () => {
    expect(
      await call('PUT', '/api/roles/viewer', 'rolemgr', { permissions: ['players.view'] }),
    ).toMatchObject({ status: 403, body: { code: 'SYSTEM_ROLE_PROTECTED' } });
    expect(
      (await call('PUT', '/api/roles/viewer', 'root', { description: 'read only' })).status,
    ).toBe(200);
    // the administrator role always keeps '*'
    expect(
      await call('PUT', '/api/roles/admin', 'root', { permissions: ['players.view'] }),
    ).toMatchObject({ status: 400, body: { code: 'SYSTEM_ROLE_PROTECTED' } });
    expect((await getRole('admin'))?.permissions).toEqual(['*']);
  });

  it('refuses changing or deleting a role stronger than the caller', async () => {
    expect(await call('PUT', '/api/roles/big', 'rolemgr', { name: 'renamed' })).toMatchObject({
      status: 403,
      body: { code: 'ROLE_EXCEEDS_YOURS' },
    });
    expect((await call('DELETE', '/api/roles/big', 'rolemgr')).status).toBe(403);
    expect(await getRole('big')).not.toBeNull();
    expect((await call('DELETE', '/api/roles/small', 'rolemgr')).status).toBe(200);
  });

  it('keeps role names unique and off legacy names and role ids', async () => {
    const named = (name: string) => create('root', ['players.view'], name);
    // unique regardless of case (this fixture names its roles like their ids)
    for (const name of ['ROLEMGR', 'Viewer']) {
      expect(await named(name)).toMatchObject({
        status: 400,
        body: { error: 'Role name already exists' },
      });
    }
    // legacy names and role ids that accounts carry are reserved
    for (const name of ['Moderator', 'Administrator', 'gone-role-id']) {
      expect(await named(name)).toMatchObject({
        status: 400,
        body: { error: 'Role name is reserved' },
      });
    }
    expect(
      (await call('PUT', '/api/roles/legacy', 'root', { name: 'Moderator' })).body,
    ).toMatchObject({ error: 'Role name is reserved' });
    // a system role may take back its own legacy name
    expect((await call('PUT', '/api/roles/viewer', 'root', { name: 'Viewer' })).status).toBe(200);
  });

  it('leaves stored permissions alone when only other fields change', async () => {
    expect((await call('PUT', '/api/roles/legacy', 'root', { description: 'kept' })).status).toBe(
      200,
    );
    expect((await getRole('legacy'))?.permissions).toEqual([
      'players.view',
      'old.removed_permission',
    ]);
  });
});
