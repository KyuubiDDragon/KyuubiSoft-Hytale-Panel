/**
 * API-key scopes on the command paths (#34, command part): a key may only do
 * what BOTH its scopes and its owner's role allow.
 *  - HTTP console: admin commands need console.execute.admin in the key scope
 *  - ws-ticket: issued only for keys scoped for console.view / players.view; the
 *    scopes travel with the ticket and the WS console honours them
 *  - players bulk: kick/ban/unban need the matching scope (and server scope)
 *  - a failing rights lookup answers 500 instead of leaving the request hanging
 *
 * Real routers, real requirePermission and real WS handler; the roles service,
 * authentication and Docker are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { PassThrough } from 'stream';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-apikey-scopes-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;
fs.writeFileSync(
  path.join(tmpDir, 'servers.json'),
  JSON.stringify({
    schemaVersion: 1,
    defaultId: 'default',
    servers: [
      {
        id: 'default',
        name: 'Primary',
        containerName: 'hytale-primary',
        status: 'ready',
        network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: 18085 },
        paths: {
          server: '/tmp/s1',
          data: '/tmp/d1',
          backups: '/tmp/b1',
          mods: '/tmp/m1',
          plugins: '/tmp/p1',
          assets: '/tmp/a1',
          auth: '/tmp/au1',
        },
        createdAt: new Date().toISOString(),
        createdBy: 'system',
      },
    ],
  }),
);

const { perms, serverPerms, execCommand } = vi.hoisted(() => ({
  perms: new Map<string, string[]>(),
  serverPerms: new Map<string, string[]>(), // `${user}@${serverId}` → extra perms
  execCommand: vi.fn(async (command: string) => ({ success: true, message: `sent ${command}` })),
}));

function lookup(user: string, serverId?: string): string[] {
  if (user === 'broken') throw new Error('users.json could not be parsed');
  const base = perms.get(user) ?? [];
  return serverId ? [...base, ...(serverPerms.get(`${user}@${serverId}`) ?? [])] : base;
}

vi.mock('../services/roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/roles.js')>()),
  getUserPermissions: async (user: string) => lookup(user),
  getUserPermissionsForServer: async (user: string, serverId?: string) => lookup(user, serverId),
  hasPermission: async (user: string, permission: string, serverId?: string) => {
    const p = lookup(user, serverId);
    return p.includes('*') || p.includes(permission);
  },
}));
vi.mock('../services/docker.js', () => ({
  execCommand,
  getLogs: vi.fn(async () => ''),
  getDockerInstance: () => ({ getContainer: () => ({ logs: async () => new PassThrough() }) }),
}));
vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));
// Test identity: x-test-user = owner, x-test-scopes = JSON scopes (marks an API key).
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (
    req: Request & { user?: string; apiKey?: unknown },
    _res: Response,
    next: NextFunction,
  ) => {
    req.user = String(req.headers['x-test-user'] ?? '');
    const scopes = req.headers['x-test-scopes'];
    if (typeof scopes === 'string') req.apiKey = { id: 'k1', scopes: JSON.parse(scopes) };
    next();
  },
}));

const express = (await import('express')).default;
const { WebSocketServer, WebSocket } = await import('ws');
const { default: consoleRouter } = await import('./console.js');
const { default: playersRouter } = await import('./players.js');
const { default: authRouter } = await import('./auth.js');
const { setupWebSocket } = await import('../websocket.js');
const { createWsTicket, verifyWsTicket } = await import('../services/auth.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/console', consoleRouter);
  app.use('/api/players', playersRouter);
  app.use(
    '/api/scoped/players',
    (req: Request & { serverId?: string }, _res, next) => {
      req.serverId = 'srv-b';
      next();
    },
    playersRouter,
  );
  app.use('/api/auth', authRouter);
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  setupWebSocket(new WebSocketServer({ server }));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  perms.clear();
  serverPerms.clear();
  perms.set('root', ['*']);
  perms.set('operator', ['console.view', 'console.execute', 'players.view']);
  execCommand.mockClear();
});

async function post(url: string, body: unknown, user: string, scopes?: string[]) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-test-user': user,
  };
  if (scopes) headers['x-test-scopes'] = JSON.stringify(scopes);
  const res = await fetch(`http://${base}${url}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('HTTP console honours API-key scopes', () => {
  it('rejects /op for a key scoped to console.execute even if the owner is admin', async () => {
    const r = await post('/api/console/command', { command: '/op add Evil' }, 'root', [
      'console.execute',
    ]);
    expect(r.status).toBe(403);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('allows /op for a key that also carries console.execute.admin (owner admin)', async () => {
    const r = await post('/api/console/command', { command: '/op add Steve' }, 'root', [
      'console.execute',
      'console.execute.admin',
    ]);
    expect(r.status).toBe(200);
    expect(execCommand).toHaveBeenCalledWith('/op add Steve', undefined);
  });

  it('still requires the owner to hold the admin tier', async () => {
    const r = await post('/api/console/command', { command: '/stop' }, 'operator', [
      'console.execute',
      'console.execute.admin',
    ]);
    expect(r.status).toBe(403);
  });

  it('lets a console.execute key run plain commands', async () => {
    const r = await post('/api/console/command', { command: '/say hi' }, 'root', [
      'console.execute',
    ]);
    expect(r.status).toBe(200);
  });
});

describe('ws-ticket and WS console honour API-key scopes', () => {
  it('refuses a ticket to a key without console.view / players.view scope', async () => {
    const r = await post('/api/auth/ws-ticket', {}, 'root', ['server.view_status']);
    expect(r.status).toBe(403);
  });

  it('issues a ticket to a scoped key and binds the scopes to it', async () => {
    const r = await post('/api/auth/ws-ticket', {}, 'root', ['console.view', 'console.execute']);
    expect(r.status).toBe(200);
    const verified = verifyWsTicket(String(r.body.ticket));
    expect(verified.apiKeyScopes).toEqual(['console.view', 'console.execute']);
  });

  function sendOverWs(
    ticket: string,
    command: string,
  ): Promise<{ type: string; success?: boolean; error?: string } | { closed: number }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}/api/console/ws?ticket=${ticket}`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('timeout'));
      }, 5000);
      // The server attaches its message handler only after the auth checks and
      // the initial log replay, so resend until it answers.
      let resend: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(timer);
        clearInterval(resend);
      };
      ws.on('open', () => {
        const send = () => ws.send(JSON.stringify({ type: 'command', payload: command }));
        send();
        resend = setInterval(send, 100);
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'command_response') {
          done();
          ws.close();
          resolve(msg);
        }
      });
      ws.on('close', (code) => {
        done();
        resolve({ closed: code });
      });
    });
  }

  it('the WS console rejects /op for a ticket whose key lacks console.execute.admin', async () => {
    const ticket = createWsTicket('root', undefined, ['console.view', 'console.execute']);
    const msg = await sendOverWs(ticket, '/op add Evil');
    expect(msg).toMatchObject({ type: 'command_response', success: false });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('the WS console allows /op when the key is scoped for it', async () => {
    const ticket = createWsTicket('root', undefined, [
      'console.view',
      'console.execute',
      'console.execute.admin',
    ]);
    const msg = await sendOverWs(ticket, '/op add Steve');
    expect(msg).toMatchObject({ type: 'command_response', success: true });
    expect(execCommand).toHaveBeenCalledWith('/op add Steve', 'default');
  });

  it('closes the socket for a key ticket without console.view', async () => {
    const ticket = createWsTicket('root', undefined, ['players.view']);
    expect(await sendOverWs(ticket, '/say hi')).toEqual({ closed: 4003 });
  });
});

describe('players bulk honours API-key and server scopes', () => {
  it('rejects bulk kick for a key without players.kick (owner admin)', async () => {
    const r = await post('/api/players/bulk', { names: ['Steve'], action: 'kick' }, 'root', [
      'players.view',
    ]);
    expect(r.status).toBe(403);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('allows bulk kick for a key scoped to players.kick', async () => {
    const r = await post('/api/players/bulk', { names: ['Steve'], action: 'kick' }, 'root', [
      'players.kick',
    ]);
    expect(r.status).toBe(200);
    expect(execCommand).toHaveBeenCalledWith('/kick Steve', undefined);
  });

  it('honours a per-server role and rejects unknown actions', async () => {
    serverPerms.set('scoped-mod@srv-b', ['players.kick']);
    expect(
      (await post('/api/players/bulk', { names: ['Steve'], action: 'kick' }, 'scoped-mod')).status,
    ).toBe(403);
    const scoped = await post(
      '/api/scoped/players/bulk',
      { names: ['Steve'], action: 'kick' },
      'scoped-mod',
    );
    expect(scoped.status).toBe(200);
    expect(execCommand).toHaveBeenCalledWith('/kick Steve', 'srv-b');
    expect(
      (await post('/api/players/bulk', { names: ['Steve'], action: 'op' }, 'root')).status,
    ).toBe(400);
  });
});

describe('unreadable users file → 500 instead of a hanging request', () => {
  it('console, bulk and ws-ticket answer 500', async () => {
    expect((await post('/api/console/command', { command: '/say hi' }, 'broken')).status).toBe(500);
    expect(
      (await post('/api/players/bulk', { names: ['Steve'], action: 'kick' }, 'broken')).status,
    ).toBe(500);
    expect((await post('/api/auth/ws-ticket', {}, 'broken')).status).toBe(500);
  });
});
