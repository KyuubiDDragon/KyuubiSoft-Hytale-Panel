/**
 * POST /api/auth/api-keys takes the key's server list in the same request:
 * the key is stored with it, and a list the caller may not grant creates no
 * key at all, so a key is never wider than chosen.
 *
 * Real router, users.json, roles.json and api_keys table in a temp dir; the
 * registry's server list and the auth middleware are stand-ins.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-api-keys-'));
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
fs.writeFileSync(
  path.join(tmpDir, 'roles.json'),
  JSON.stringify({
    version: 1,
    lastModified: now,
    appliedMigrations: [],
    roles: [role('admin', ['*']), role('operator', ['server.view_status', 'apikeys.manage'])],
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
    users: [user('opall', 'operator'), user('opb', 'operator', { allowedServers: [B] })],
  }),
);

vi.mock('../services/servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/servers.js')>()),
  listServers: async () => [{ id: 'default' }, { id: 'bbbb0001' }],
}));
vi.mock('../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth.js')>()),
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = String(req.headers['x-test-user'] ?? '');
    next();
  },
}));
vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));

const express = (await import('express')).default;
const { default: authRouter } = await import('./auth.js');
const { listApiKeys } = await import('../services/apiKeys.js');
const { closeDb } = await import('../db/index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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

async function create(username: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/auth/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': username },
    body: JSON.stringify({ scopes: ['server.view_status'], ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('POST /api/auth/api-keys with a server list', () => {
  it('stores the list with the key', async () => {
    const r = await create('opall', { name: 'only-b', serverIds: [B] });
    expect(r.status).toBe(200);
    expect(r.body.key.serverIds).toEqual([B]);
    expect(listApiKeys('opall').find((k) => k.id === r.body.key.id)?.serverIds).toEqual([B]);
  });

  it('without a list the key follows its owner, as before', async () => {
    const r = await create('opall', { name: 'owner' });
    expect(r.status).toBe(200);
    expect(r.body.key.serverIds).toBeNull();
  });

  it('creates no key when the list names a server the caller does not have', async () => {
    const before = listApiKeys('opb').length;
    const r = await create('opb', { name: 'wider', serverIds: [A] });
    expect(r).toMatchObject({ status: 403, body: { code: 'SERVERS_NOT_HELD' } });
    expect(r.body.token).toBeUndefined();
    expect(listApiKeys('opb')).toHaveLength(before);
  });

  it('creates no key for an unknown server or a malformed list', async () => {
    const before = listApiKeys('opall').length;
    expect(await create('opall', { name: 'x', serverIds: ['nope0000'] })).toMatchObject({
      status: 400,
      body: { code: 'UNKNOWN_SERVER' },
    });
    expect(await create('opall', { name: 'x', serverIds: 'all' })).toMatchObject({
      status: 400,
      body: { code: 'INVALID_SERVER_LIST' },
    });
    expect(listApiKeys('opall')).toHaveLength(before);
  });
});
