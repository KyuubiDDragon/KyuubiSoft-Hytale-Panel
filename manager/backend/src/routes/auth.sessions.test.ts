/**
 * Sessions and API keys end with the account they belong to, and a key never
 * hands out more than it holds itself:
 *  - an access or refresh token of an account that is gone (also after a
 *    restart) is refused, and an account created again under the same name
 *    does not take over the old tokens or keys;
 *  - a key creates keys only with scopes it holds itself and never one that
 *    outlives it;
 *  - keys cannot enrol or change the owner's 2FA.
 *
 * Real router, real auth middleware, users.json, roles.json and api_keys table
 * in a temp dir.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-auth-sessions-'));
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.JWT_SECRET = 'auth-sessions-test-secret-0123456789abcdef0123456789';
delete process.env.DEMO_MODE;

const now = new Date().toISOString();
const role = (id: string, permissions: string[]) => ({
  id,
  name: id,
  description: '',
  permissions,
  isSystem: id === 'admin',
  createdAt: now,
  updatedAt: now,
});
fs.writeFileSync(
  path.join(tmpDir, 'roles.json'),
  JSON.stringify({
    version: 1,
    lastModified: now,
    appliedMigrations: [],
    roles: [
      role('admin', ['*']),
      role('viewer', ['server.view_status']),
      role('operator', ['server.view_status', 'console.view', 'apikeys.manage']),
    ],
  }),
);
const account = (username: string, roleId: string) => ({
  username,
  passwordHash: `$2b$10$${'a'.repeat(53)}`,
  roleId,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  tokenVersion: 1,
});
const usersFile = path.join(tmpDir, 'users.json');
fs.writeFileSync(
  usersFile,
  JSON.stringify({ users: [account('boss', 'admin'), account('second', 'admin')] }),
);

vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { default: authRouter } = await import('./auth.js');
const { createAccessToken, createRefreshToken } = await import('../services/auth.js');
const { createUser, deleteUser, claimTokenVersion } = await import('../services/users.js');
const { createApiKey } = await import('../services/apiKeys.js');
const { closeDb } = await import('../db/index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
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

const PASSWORD = 'Sessions-Test-Pass-2026!';

async function call(
  method: string,
  url: string,
  auth: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const bearer = async (username: string) => `Bearer ${await createAccessToken(username)}`;

async function refresh(token: string) {
  const res = await fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: token }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** Takes an account out of users.json the way a restart sees it: nothing in memory. */
function removeFromFile(username: string): void {
  const data = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
  data.users = data.users.filter((u: { username: string }) => u.username !== username);
  fs.writeFileSync(usersFile, JSON.stringify(data));
}

describe('tokens of an account that is gone', () => {
  it('refuses an access token once the account is no longer in users.json', async () => {
    await createUser('gone1', PASSWORD, 'viewer');
    const auth = await bearer('gone1');
    expect((await call('GET', '/api/auth/me', auth)).status).toBe(200);

    removeFromFile('gone1');

    const res = await call('GET', '/api/auth/me', auth);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('USER_DELETED');
  });

  it('refuses a refresh token once the account is no longer in users.json', async () => {
    await createUser('gone2', PASSWORD, 'viewer');
    const token = await createRefreshToken('gone2');
    expect((await refresh(token)).status).toBe(200);

    removeFromFile('gone2');

    const res = await refresh(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('USER_DELETED');
  });

  it('gives an account created again under the same name none of the old sessions', async () => {
    await createUser('reused', PASSWORD, 'viewer');
    const oldAccess = await bearer('reused');
    const oldRefresh = await createRefreshToken('reused');
    await deleteUser('reused');

    await createUser('reused', PASSWORD, 'viewer');

    expect((await call('GET', '/api/auth/me', oldAccess)).body.code).toBe('TOKEN_INVALIDATED');
    expect((await refresh(oldRefresh)).status).toBe(401);
    // The new account's own sessions work.
    expect((await call('GET', '/api/auth/me', await bearer('reused'))).status).toBe(200);
    expect((await refresh(await createRefreshToken('reused'))).status).toBe(200);
  });
});

describe('claimTokenVersion (other writers that create accounts, such as SSO)', () => {
  it('starts above a deleted account of the same name and takes its record out', () => {
    const data = { deletedTokenVersions: { alice: 3 } as Record<string, number> };
    expect(claimTokenVersion(data, 'alice')).toBe(4);
    expect(data.deletedTokenVersions).toEqual({});
    expect(claimTokenVersion(data, 'bob')).toBe(1);
  });
});

describe('API keys of an account that is gone', () => {
  it('are revoked with the account and stay dead when the name is used again', async () => {
    await createUser('keyowner', PASSWORD, 'operator');
    const { token } = await createApiKey({
      ownerUsername: 'keyowner',
      name: 'k',
      scopes: ['server.view_status'],
    });
    const auth = `ApiKey ${token}`;
    expect((await call('GET', '/api/auth/me', auth)).status).toBe(200);

    expect(
      (await call('DELETE', '/api/auth/users/keyowner', await bearer('boss'))).body.success,
    ).toBe(true);
    expect((await call('GET', '/api/auth/me', auth)).status).toBe(401);

    await createUser('keyowner', PASSWORD, 'operator');
    expect((await call('GET', '/api/auth/me', auth)).status).toBe(401);
  });

  it('stop working when the owner is no longer in users.json', async () => {
    await createUser('keyowner2', PASSWORD, 'operator');
    const { token } = await createApiKey({
      ownerUsername: 'keyowner2',
      name: 'k',
      scopes: ['server.view_status'],
    });
    removeFromFile('keyowner2');

    expect((await call('GET', '/api/auth/me', `ApiKey ${token}`)).status).toBe(401);
  });
});

describe('a key creating keys', () => {
  async function keyOf(scopes: string[], expiresAt?: string) {
    const { token } = await createApiKey({
      ownerUsername: 'boss',
      name: 'parent',
      scopes,
      expiresAt: expiresAt ?? null,
    });
    return `ApiKey ${token}`;
  }

  it('cannot give the new key a scope it does not hold itself (owner admin)', async () => {
    const parent = await keyOf(['apikeys.manage', 'server.view_status']);

    const res = await call('POST', '/api/auth/api-keys', parent, {
      name: 'child',
      scopes: ['console.execute.admin'],
    });

    expect(res.status).toBe(403);
    expect(res.body.scopes).toEqual(['console.execute.admin']);
  });

  it('cannot create a key with every right from a key without it', async () => {
    const parent = await keyOf(['apikeys.manage']);
    const res = await call('POST', '/api/auth/api-keys', parent, { name: 'child', scopes: ['*'] });
    expect(res.status).toBe(403);
  });

  it('may create a key with scopes it holds', async () => {
    const parent = await keyOf(['apikeys.manage', 'server.view_status']);
    const res = await call('POST', '/api/auth/api-keys', parent, {
      name: 'child',
      scopes: ['server.view_status'],
    });
    expect(res.status).toBe(200);
    expect(res.body.key.scopes).toEqual(['server.view_status']);
  });

  it('gives the new key at most its own lifetime', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const parent = await keyOf(['apikeys.manage', 'server.view_status'], until);

    const inherited = await call('POST', '/api/auth/api-keys', parent, {
      name: 'child',
      scopes: ['server.view_status'],
    });
    expect(inherited.status).toBe(200);
    expect(inherited.body.key.expiresAt).toBe(until);

    const later = await call('POST', '/api/auth/api-keys', parent, {
      name: 'child',
      scopes: ['server.view_status'],
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(later.status).toBe(403);
  });

  it('refuses an expiry that is not a date', async () => {
    const res = await call('POST', '/api/auth/api-keys', await bearer('boss'), {
      name: 'k',
      scopes: ['server.view_status'],
      expiresAt: 'someday',
    });
    expect(res.status).toBe(400);
  });

  it('works for a signed-in admin as before', async () => {
    const res = await call('POST', '/api/auth/api-keys', await bearer('boss'), {
      name: 'k',
      scopes: ['console.execute.admin'],
    });
    expect(res.status).toBe(200);
  });
});

describe('2FA of the owner', () => {
  it.each([
    ['POST', '/api/auth/2fa/setup', {}],
    ['POST', '/api/auth/2fa/verify-enable', { code: '123456' }],
    ['POST', '/api/auth/2fa/disable', { password: 'x', code: '123456' }],
    ['POST', '/api/auth/2fa/regenerate-backup-codes', { password: 'x' }],
  ])('cannot be changed with an API key: %s %s', async (method, url, body) => {
    const { token } = await createApiKey({ ownerUsername: 'boss', name: 'k', scopes: ['*'] });
    const res = await call(method, url, `ApiKey ${token}`, body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('API_KEY_NOT_ALLOWED');
  });
});
