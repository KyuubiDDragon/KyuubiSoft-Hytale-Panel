/**
 * Event-action routes: saving a command rule answers with warnings, and still
 * saves it, when its template carries free text from the event or when it
 * hangs on joins/leaves of a server without a plugin connection (those come
 * from the server log then and run no commands).
 *
 * Real rule store (temp data dir); auth, permissions, the role lookup, the
 * server list and the plugin connection are stubbed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-event-action-routes-'));
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

vi.mock('../services/roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/roles.js')>()),
  hasPermission: async () => true,
}));
vi.mock('../services/audit.js', () => ({ audit: () => undefined }));
const plugin = vi.hoisted(() => ({ servers: ['default', 'b'], connected: new Set<string>() }));
vi.mock('../services/pluginEvents.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/pluginEvents.js')>()),
  isConnectedToPlugin: (id?: string) => (id ? plugin.connected.has(id) : plugin.connected.size > 0),
}));
vi.mock('../services/servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/servers.js')>()),
  listServers: async () => plugin.servers.map((id) => ({ id })),
  getServer: async (id: string) => (plugin.servers.includes(id) ? { id } : null),
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'admin';
    next();
  },
}));
// null = the caller may use every server; a list limits them to those servers.
const access = vi.hoisted(() => ({ allowed: null as string[] | null }));
vi.mock('../middleware/permissions.js', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  accessibleServerIds: async () => access.allowed,
  ALL_SERVERS_REQUIRED: 'ALL_SERVERS_REQUIRED',
  SERVER_NOT_ALLOWED: 'SERVER_NOT_ALLOWED',
}));

const express = (await import('express')).default;
const { default: router } = await import('./eventActions.js');
const { closeDb } = await import('../db/index.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/event-actions', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/event-actions`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  // The database file stays open (and locked on Windows) until it is closed.
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface SaveAnswer {
  rule: { id: string; actionPayload: { command?: string } };
  warnings: Array<{ code: string }>;
}

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as SaveAnswer };
}

const rule = (command: string) => ({
  name: 'rule',
  eventPattern: 'player.joined',
  actionType: 'command',
  actionPayload: { command },
});

describe('saving event actions', () => {
  // Every server has the plugin here; see the block below for the other case.
  beforeEach(() => {
    plugin.connected = new Set(plugin.servers);
  });

  it('saves a rule with only name placeholders without a warning', async () => {
    const { status, json } = await call('POST', '/', rule('/say Welcome {player}'));
    expect(status).toBe(200);
    expect(json.warnings).toEqual([]);
  });

  it('saves a rule with a free-text placeholder and warns about it, also on update', async () => {
    const created = await call('POST', '/', rule('/say {player}: {message}'));
    expect(created.status).toBe(200);
    expect(created.json.rule.id).toBeTruthy();
    expect(created.json.warnings).toEqual([
      expect.objectContaining({ code: 'free_text_placeholder', placeholders: ['message'] }),
    ]);

    const updated = await call('PUT', `/${created.json.rule.id}`, {
      actionPayload: { command: '/say {player} left: {reason}' },
    });
    expect(updated.status).toBe(200);
    expect(updated.json.rule.actionPayload.command).toBe('/say {player} left: {reason}');
    expect(updated.json.warnings).toEqual([
      expect.objectContaining({ code: 'free_text_placeholder', placeholders: ['reason'] }),
    ]);
  });
});

describe('command rules on joins and leaves without the plugin', () => {
  beforeEach(() => {
    plugin.connected = new Set();
  });

  const codes = (json: SaveAnswer) => json.warnings.map((w) => w.code);

  it('warns when the rule server has no plugin connection, and saves the rule anyway', async () => {
    const created = await call('POST', '/', { ...rule('/say Welcome {player}'), serverId: 'b' });
    expect(created.status).toBe(200);
    expect(created.json.warnings).toEqual([
      expect.objectContaining({ code: 'log_events_run_no_commands', events: ['player.joined'] }),
    ]);
    plugin.connected.add('b');
    const updated = await call('PUT', `/${created.json.rule.id}`, { eventPattern: 'player.*' });
    expect(updated.status).toBe(200);
    expect(codes(updated.json)).toEqual([]);
  });

  it('for a rule on every server, warns while one of them lacks the plugin', async () => {
    plugin.connected.add('default');
    const some = await call('POST', '/', {
      ...rule('/say bye {player}'),
      eventPattern: 'player.left',
    });
    expect(codes(some.json)).toEqual(['log_events_run_no_commands']);
    plugin.connected.add('b');
    const all = await call('POST', '/', {
      ...rule('/say bye {player}'),
      eventPattern: 'player.left',
    });
    expect(codes(all.json)).toEqual([]);
  });

  it('does not warn for announcements or for other events', async () => {
    const announce = await call('POST', '/', {
      ...rule(''),
      actionType: 'announce',
      actionPayload: { message: 'Welcome {player}' },
    });
    expect(announce.status).toBe(200);
    expect(codes(announce.json)).toEqual([]);
    const other = await call('POST', '/', { ...rule('/say crashed'), eventPattern: 'server.*' });
    expect(other.status).toBe(200);
    expect(codes(other.json)).toEqual([]);
  });
});

describe('rules and the servers a caller may use', () => {
  beforeEach(() => {
    plugin.connected = new Set(plugin.servers);
  });
  afterEach(() => {
    access.allowed = null;
  });

  it('a caller limited to server b manages rules of b only', async () => {
    const onDefault = await call('POST', '/', { ...rule('/say hi {player}'), serverId: 'default' });
    expect(onDefault.status).toBe(200);
    access.allowed = ['b'];

    expect((await call('POST', '/', rule('/say hi {player}'))).status).toBe(403);
    const forAll = await call('POST', '/', rule('/say hi {player}'));
    expect((forAll.json as unknown as { code: string }).code).toBe('ALL_SERVERS_REQUIRED');
    expect(
      (await call('POST', '/', { ...rule('/say hi {player}'), serverId: 'default' })).status,
    ).toBe(403);
    const onB = await call('POST', '/', { ...rule('/say hi {player}'), serverId: 'b' });
    expect(onB.status).toBe(200);

    // Another server's rule: neither listed nor changeable nor deletable.
    const list = (await call('GET', '/')).json as unknown as {
      rules: Array<{ id: string; serverId: string | null }>;
    };
    expect(list.rules.map((r) => r.id)).toContain(onB.json.rule.id);
    expect(new Set(list.rules.map((r) => r.serverId))).toEqual(new Set(['b']));
    const id = onDefault.json.rule.id;
    expect((await call('PUT', `/${id}`, { name: 'x' })).status).toBe(403);
    expect((await call('DELETE', `/${id}`)).status).toBe(403);
    // Nor may it move its own rule to every server.
    expect((await call('PUT', `/${onB.json.rule.id}`, { serverId: null })).status).toBe(403);
  });
});
