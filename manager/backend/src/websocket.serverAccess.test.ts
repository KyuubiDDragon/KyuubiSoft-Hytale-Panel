/**
 * Server lists on the console WebSocket: the ticket route, the ticket-server
 * binding and the socket's own rights check, for users (allowedServers) and
 * API keys (serverIds). The legacy socket counts as the default server A.
 *
 * Real ticket store, roles and users services (temp dir) and the real ws
 * handler; the registry, Docker, the log stream and the auth middleware are
 * stand-ins.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-ws-server-access-'));
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.MULTISERVER_ENABLED = 'true';
delete process.env.DEMO_MODE;

const now = new Date().toISOString();
fs.writeFileSync(
  path.join(tmpDir, 'roles.json'),
  JSON.stringify({
    version: 1,
    lastModified: now,
    appliedMigrations: [],
    roles: [
      { id: 'admin', name: 'admin', description: '', permissions: ['*'], isSystem: true },
      {
        id: 'operator',
        name: 'operator',
        description: '',
        permissions: ['console.view', 'console.execute'],
        isSystem: false,
      },
    ].map((r) => ({ ...r, createdAt: now, updatedAt: now })),
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
      user('oprevoke', 'operator', { allowedServers: [B] }),
    ],
  }),
);

vi.mock('./services/servers.js', () => ({
  listServers: async () => [{ id: 'default' }, { id: 'bbbb0001' }],
  getServer: async (id: string) => (['default', 'bbbb0001'].includes(id) ? { id } : null),
  getDefaultId: async () => 'default',
  resolveServerId: async (id?: string) => id ?? 'default',
  isComposeServer: (server: { id: string }) => server.id === 'default',
}));
const { execCommand } = vi.hoisted(() => ({
  execCommand: vi.fn(async () => ({ success: true, message: 'ok' })),
}));
vi.mock('./services/docker.js', () => ({ execCommand, getLogs: vi.fn(async () => '') }));
vi.mock('./services/serverLogStream.js', () => ({
  subscribeServerLogWithHistory: () => () => undefined,
}));
vi.mock('./services/playerPresence.js', () => ({ onPresenceChange: () => () => undefined }));
vi.mock('./services/audit.js', () => ({ audit: vi.fn() }));
vi.mock('./middleware/auth.js', () => ({
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
const { WebSocketServer, WebSocket } = await import('ws');
const { default: authRouter } = await import('./routes/auth.js');
const { setupWebSocket } = await import('./websocket.js');
const { createWsTicket, verifyWsTicket } = await import('./services/auth.js');
const { setUserAllowedServers } = await import('./services/users.js');
const { createApiKey, setApiKeyServerIds, revokeApiKey } = await import('./services/apiKeys.js');
const { closeDb } = await import('./db/index.js');

/** A real key of `owner`, limited to `serverIds` (null = no list). */
async function keyGrant(owner: string, scopes: string[], serverIds: string[] | null) {
  const { key } = await createApiKey({ ownerUsername: owner, name: 'ws', scopes });
  setApiKeyServerIds(owner, key.id, serverIds);
  return { id: key.id, scopes, serverIds };
}

let server: Server;
let wss: InstanceType<typeof WebSocketServer>;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  wss = new WebSocketServer({ server });
  setupWebSocket(wss, { heartbeatMs: 150 });
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function requestTicket(
  username: string,
  serverId?: string,
  key?: { id: string; scopes: string[]; serverIds: string[] | null },
) {
  const headers: Record<string, string> = {
    'x-test-user': username,
    'content-type': 'application/json',
  };
  if (key) headers['x-test-key'] = JSON.stringify(key);
  const r = await fetch(`http://${base}/api/auth/ws-ticket`, {
    method: 'POST',
    headers,
    body: JSON.stringify(serverId ? { serverId } : {}),
  });
  return { status: r.status, body: (await r.json()) as { ticket?: string; code?: string } };
}

const legacy = (ticket: string) => `ws://${base}/api/console/ws?ticket=${ticket}`;
const scoped = (serverId: string, ticket: string) =>
  `ws://${base}/api/servers/${serverId}/console/ws?ticket=${ticket}`;

/** 'open' once the socket answers a ping (authenticated), else the close code. */
function connect(url: string, keepOpen = false): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout'));
    }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
    ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type !== 'pong') return;
      clearTimeout(timer);
      if (!keepOpen) ws.close();
      resolve('open');
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('ws-ticket route', () => {
  it('refuses a ticket for A to a user limited to B', async () => {
    expect((await requestTicket('opb', A)).status).toBe(403);
  });

  it('refuses an unscoped ticket, which opens the default server A, to a user limited to B', async () => {
    expect(await requestTicket('opb')).toMatchObject({
      status: 403,
      body: { code: 'SERVER_NOT_ALLOWED' },
    });
  });

  it("checks an API key's own server list and hands the whole grant to the ticket", async () => {
    const keyB = await keyGrant('opall', ['console.view'], [B]);
    expect((await requestTicket('opall', A, keyB)).status).toBe(403);
    expect((await requestTicket('opall', undefined, keyB)).status).toBe(403);
    const r = await requestTicket('opall', B, keyB);
    expect(r.status).toBe(200);
    expect(verifyWsTicket(r.body.ticket!, B)).toMatchObject({
      valid: true,
      apiKeyId: keyB.id,
      apiKeyServerIds: [B],
    });
  });

  it('issues one for B', async () => {
    const r = await requestTicket('opb', B);
    expect(r.status).toBe(200);
    expect(await connect(scoped(B, r.body.ticket!))).toBe('open');
  });
});

describe('console socket', () => {
  it('closes the legacy socket (default server A) for a user limited to B', async () => {
    expect(await connect(legacy(createWsTicket('opb')))).toBe(4003);
  });

  it('closes the scoped socket of A for a user limited to B', async () => {
    expect(await connect(scoped(A, createWsTicket('opb', A)))).toBe(4003);
  });

  it('keeps users without a list and admins working as before', async () => {
    expect(await connect(legacy(createWsTicket('opall')))).toBe('open');
    expect(await connect(scoped(A, createWsTicket('opall', A)))).toBe('open');
    expect(await connect(legacy(createWsTicket('root')))).toBe('open');
  });

  it('opens a scoped socket only with a ticket for that server', async () => {
    // unscoped ticket on a scoped socket, and the other way round
    expect(await connect(scoped(B, createWsTicket('opall')))).toBe(4001);
    expect(await connect(legacy(createWsTicket('opall', A)))).toBe(4001);
    expect(await connect(scoped(B, createWsTicket('opall', A)))).toBe(4001);
  });

  it("enforces an API key's server list carried by the ticket", async () => {
    const keyB = await keyGrant('opall', ['console.view'], [B]);
    expect(await connect(scoped(A, createWsTicket('opall', A, keyB)))).toBe(4003);
    expect(await connect(legacy(createWsTicket('opall', undefined, keyB)))).toBe(4003);
    expect(await connect(scoped(B, createWsTicket('opall', B, keyB)))).toBe('open');
    const keyAll = await keyGrant('opall', ['console.view'], null);
    expect(await connect(legacy(createWsTicket('opall', undefined, keyAll)))).toBe('open');
  });

  it("uses the key's current state, not the ticket's copy", async () => {
    // Ticket says "no list", the key meanwhile is limited to B.
    const key = await keyGrant('opall', ['console.view'], null);
    setApiKeyServerIds('opall', key.id, [B]);
    expect(await connect(legacy(createWsTicket('opall', undefined, key)))).toBe(4003);
    // A revoked key opens nothing, and an unknown key id neither.
    const revoked = await keyGrant('opall', ['console.view'], null);
    revokeApiKey('opall', revoked.id);
    expect(await connect(legacy(createWsTicket('opall', undefined, revoked)))).toBe(4003);
    const ghost = { id: 'no-such-key', scopes: ['console.view'], serverIds: null };
    expect(await connect(legacy(createWsTicket('opall', undefined, ghost)))).toBe(4003);
  });

  it('refuses a command from a key revoked since the last heartbeat', async () => {
    const key = await keyGrant('opall', ['console.view', 'console.execute'], [B]);
    const ws = new WebSocket(scoped(B, createWsTicket('opall', B, key)));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    const replies: Array<{ type: string; success?: boolean }> = [];
    ws.on('message', (raw) => replies.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ type: 'ping' }));
    await vi.waitFor(() => expect(replies.some((r) => r.type === 'pong')).toBe(true));
    revokeApiKey('opall', key.id);
    ws.send(JSON.stringify({ type: 'command', payload: '/say hi' }));
    expect(await closed).toBe(4003);
    // The heartbeat may close the socket first; either way nothing ran.
    const answer = replies.find((r) => r.type === 'command_response');
    if (answer) expect(answer.success).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('closes an open key socket once the key is revoked', async () => {
    const key = await keyGrant('opall', ['console.view'], [B]);
    const ws = new WebSocket(scoped(B, createWsTicket('opall', B, key)));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    revokeApiKey('opall', key.id);
    expect(await closed).toBe(4003);
  });

  it('closes an open socket once the server is taken off the list', async () => {
    const ws = new WebSocket(scoped(B, createWsTicket('oprevoke', B)));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    await setUserAllowedServers('oprevoke', [A]);
    expect(await closed).toBe(4003);
  });
});

describe('ticket store', () => {
  it('keeps the id, scope list and server list of a key grant, copies of them', () => {
    const grant = { id: 'k3', scopes: ['console.view'], serverIds: [B] };
    const ticket = createWsTicket('opall', B, grant);
    grant.serverIds.push(A);
    expect(verifyWsTicket(ticket, B)).toMatchObject({
      valid: true,
      apiKeyId: 'k3',
      apiKeyScopes: ['console.view'],
      apiKeyServerIds: [B],
    });
  });

  it('carries no key data for a normal login', () => {
    const verified = verifyWsTicket(createWsTicket('opall'));
    expect(verified).toMatchObject({ valid: true, username: 'opall' });
    expect(verified.apiKeyScopes).toBeUndefined();
    expect(verified.apiKeyId).toBeUndefined();
  });
});
