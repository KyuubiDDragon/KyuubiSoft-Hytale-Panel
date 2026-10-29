/**
 * Route tests for the server's own settings (quick settings and the config
 * file editor).
 *
 * Real filesystem (temp server folder); Docker, the lifecycle module, the
 * plugin's command endpoint, auth and permissions are stubbed. Covers: values
 * and apply modes read from config.json, writes only with the server stopped
 * (or with an explicit restart, which needs the restart permission), live
 * changes through the plugin that only count when the server confirms them,
 * schema checks before a write, `.bak` of the old content, and that every key
 * the panel does not edit stays as it was.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { PluginCommandAttempt } from '../../services/pluginCommands.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-serverconfig-route-'));
const serverDir = path.join(root, 'server');
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
fs.mkdirSync(process.env.MANAGER_DATA_PATH, { recursive: true });
delete process.env.DEMO_MODE;

const state = { running: false };
const denied = new Set<string>();

vi.mock('../../services/docker.js', () => ({
  getContainerState: vi.fn(async () => ({ running: state.running })),
}));
const withServerStopped = vi.fn(
  async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) => {
    const was = state.running;
    state.running = false;
    try {
      return await fn();
    } finally {
      state.running = was;
    }
  },
);
vi.mock('../../services/serverLifecycle.js', () => ({
  withServerStopped: (id: unknown, opts: unknown, fn: () => Promise<unknown>) =>
    withServerStopped(id, opts, fn),
  runWhileServerStopped: async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) =>
    state.running ? { ran: false } : { ran: true, value: await fn() },
  isLifecycleBusy: () => false,
  registerBeforeStartHook: () => undefined,
  LifecycleError: class LifecycleError extends Error {},
  LifecycleBusyError: class LifecycleBusyError extends Error {},
}));
vi.mock('../../services/servers.js', () => ({
  resolveServerId: async () => 'default',
  getDefaultId: async () => 'default',
}));
vi.mock('../../services/serverInstall.js', () => ({
  resolveInstallPaths: async () => ({ serverPath: serverDir, backupsPath: root }),
}));
// One server whose files the panel sees (the guard has its own tests).
vi.mock('../../middleware/serverScope.js', () => ({
  requireServerFiles: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
const runCommandViaPlugin = vi.fn<(command: string) => Promise<PluginCommandAttempt>>();
vi.mock('../../services/pluginCommands.js', () => ({
  runCommandViaPlugin: (command: string) => runCommandViaPlugin(command),
}));
vi.mock('../../services/kyuubiApi.js', () => ({ isPluginInstalled: async () => true }));
vi.mock('../../services/audit.js', () => ({ audit: () => undefined }));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'tester';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission:
    (...perms: string[]) =>
    (_req: Request, res: Response, next: NextFunction) =>
      perms.some((p) => denied.has(p)) ? res.status(403).json({ error: 'denied' }) : next(),
}));

const express = (await import('express')).default;
const { default: serverConfigRouter } = await import('./serverConfig.js');

const CONFIG = {
  Version: 4,
  ServerName: 'Hytale Server',
  MOTD: 'Hi',
  Password: '',
  MaxPlayers: 100,
  MaxViewRadius: 32,
  Defaults: { World: 'default', GameMode: 'Adventure', HardcoreMode: 'None' },
  Mods: { 'a:b': { Enabled: true } },
  Whitelist: true,
};
const configFile = () => path.join(serverDir, 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(configFile(), 'utf-8'));

function reply(messageIds: string[], text: string): PluginCommandAttempt {
  return {
    kind: 'reply',
    reply: {
      ok: true,
      status: 'DONE',
      command: '',
      sender: 'Panel:tester',
      output: [text],
      messageIds,
      error: null,
      truncated: false,
      durationMs: 1,
    },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/server', serverConfigRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/server`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(serverDir, { recursive: true, force: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(CONFIG, null, 2));
  state.running = false;
  denied.clear();
  withServerStopped.mockClear();
  runCommandViaPlugin.mockReset();
});

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('GET /quick-settings', () => {
  it('reads the settings with how each takes effect', async () => {
    const { status, json } = await call('GET', '/quick-settings');
    expect(status).toBe(200);
    expect(json).toMatchObject({
      serverName: 'Hytale Server',
      maxPlayers: 100,
      defaultGameMode: 'Adventure',
      fields: { maxPlayers: 'live', serverName: 'restart' },
      limits: { maxViewRadius: 32, gameModes: ['Adventure', 'Creative'] },
      serverRunning: false,
      legacyKeys: ['Whitelist'],
    });
  });

  it('asks the running server for its live values', async () => {
    state.running = true;
    runCommandViaPlugin
      .mockResolvedValueOnce(reply(['server.commands.maxplayers.get'], 'Max players: 50'))
      .mockResolvedValueOnce(reply(['server.commands.maxviewradius.get'], 'Max view radius: 16'));
    const { json } = await call('GET', '/quick-settings?live=1');
    expect(json).toMatchObject({
      serverRunning: true,
      liveAvailable: true,
      liveValues: { maxPlayers: 50, maxViewRadius: 16 },
    });
  });

  it('says when the server has not created config.json yet', async () => {
    fs.rmSync(configFile());
    const { status, json } = await call('GET', '/quick-settings');
    expect(status).toBe(404);
    expect(json.reason).toBe('config_missing');
  });
});

describe('PUT /quick-settings', () => {
  it('writes the file while the server is stopped and keeps every other key', async () => {
    const { status, json } = await call('PUT', '/quick-settings', {
      serverName: 'New',
      maxPlayers: 20,
      defaultGameMode: 'creative',
      motd: 'Hi',
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, applied: 'file', restarted: false });
    expect(readConfig()).toEqual({
      ...CONFIG,
      ServerName: 'New',
      MaxPlayers: 20,
      Defaults: { ...CONFIG.Defaults, GameMode: 'Creative' },
    });
    expect(JSON.parse(fs.readFileSync(`${configFile()}.bak`, 'utf-8'))).toEqual(CONFIG);
    expect(withServerStopped).not.toHaveBeenCalled();
  });

  it('refuses values the server would not accept', async () => {
    for (const body of [
      { maxViewRadius: 64 },
      { defaultGameMode: 'Survival' },
      { maxPlayers: -1 },
    ]) {
      const { status } = await call('PUT', '/quick-settings', body);
      expect(status, JSON.stringify(body)).toBe(400);
    }
    expect(readConfig()).toEqual(CONFIG);
  });

  it('asks for a restart when a start-only setting changes on a running server', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue({ kind: 'unavailable', reason: 'down' });
    const { status, json } = await call('PUT', '/quick-settings', {
      serverName: 'New',
      maxPlayers: 20,
    });
    expect(status).toBe(409);
    expect(json).toMatchObject({
      requiresRestart: true,
      reason: 'requires_restart',
      restartFields: ['serverName'],
      liveFields: ['maxPlayers'],
    });
    expect(readConfig()).toEqual(CONFIG);
  });

  it('saves with a restart when asked, and only with the restart permission', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue({ kind: 'unavailable', reason: 'down' });
    denied.add('server.restart');
    expect(
      (await call('PUT', '/quick-settings', { serverName: 'New', restart: true })).status,
    ).toBe(403);
    denied.clear();
    const { status, json } = await call('PUT', '/quick-settings', {
      serverName: 'New',
      restart: true,
      countdownSeconds: 30,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ applied: 'restart', restarted: true });
    expect(withServerStopped).toHaveBeenCalledTimes(1);
    expect(withServerStopped.mock.calls[0][1]).toMatchObject({
      reason: 'config',
      countdownSeconds: 30,
    });
    expect(readConfig().ServerName).toBe('New');
  });

  it('applies live settings with the server command and leaves the file to the server', async () => {
    state.running = true;
    runCommandViaPlugin.mockImplementation(async (command) => {
      if (command === '/maxplayers')
        return reply(['server.commands.maxplayers.get'], 'Max players: 100');
      if (command === '/maxviewradius') return reply(['server.commands.maxviewradius.get'], '32');
      if (command === '/maxplayers --amount 20')
        return reply(['server.commands.maxplayers.set'], 'set to 20');
      return reply([], 'unexpected');
    });
    const { status, json } = await call('PUT', '/quick-settings', {
      maxPlayers: 20,
      maxViewRadius: 32,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ applied: 'live', results: [{ field: 'maxPlayers', ok: true }] });
    expect(runCommandViaPlugin.mock.calls.map((c) => c[0])).toContain('/maxplayers --amount 20');
    expect(readConfig()).toEqual(CONFIG);
  });

  it('compares a live setting with what the running server uses, not with the file', async () => {
    // Changed live a moment ago to 50, the server has not saved it yet.
    state.running = true;
    runCommandViaPlugin.mockImplementation(async (command) => {
      if (command === '/maxplayers')
        return reply(['server.commands.maxplayers.get'], 'Max players: 50');
      if (command === '/maxviewradius') return reply(['server.commands.maxviewradius.get'], '32');
      return reply(['server.commands.maxplayers.set'], 'set to 100');
    });
    const { json } = await call('PUT', '/quick-settings', { maxPlayers: 100 });
    expect(json).toMatchObject({ applied: 'live' });
    expect(runCommandViaPlugin.mock.calls.map((c) => c[0])).toContain('/maxplayers --amount 100');
  });

  it('writes the sent live values with a restart, even when the file looked unchanged', async () => {
    // Live set to 50 a moment ago (the plugin is gone now); the server saves 50 on its way down.
    state.running = true;
    runCommandViaPlugin.mockResolvedValue({ kind: 'unavailable', reason: 'down' });
    withServerStopped.mockImplementationOnce(async (_id, _opts, fn) => {
      fs.writeFileSync(configFile(), JSON.stringify({ ...CONFIG, MaxPlayers: 50 }, null, 2));
      return fn();
    });
    const { status } = await call('PUT', '/quick-settings', {
      serverName: 'New',
      maxPlayers: 100,
      restart: true,
    });
    expect(status).toBe(200);
    expect(readConfig()).toMatchObject({ ServerName: 'New', MaxPlayers: 100 });
  });

  it('reports a live change the server did not confirm', async () => {
    state.running = true;
    runCommandViaPlugin.mockImplementation(async (command) =>
      command.includes(' ')
        ? reply(['server.commands.errors.permission'], 'no permission')
        : reply(['server.commands.maxplayers.get'], '100'),
    );
    const { status, json } = await call('PUT', '/quick-settings', { maxPlayers: 20 });
    expect(status).toBe(502);
    expect(json.reason).toBe('not_confirmed');
  });

  it('asks for a restart when the plugin is not reachable for a live change', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue({ kind: 'unavailable', reason: 'plugin not installed' });
    const { status, json } = await call('PUT', '/quick-settings', { maxPlayers: 20 });
    expect(status).toBe(409);
    expect(json.reason).toBe('live_unavailable');
    expect(readConfig()).toEqual(CONFIG);
  });

  it('does not rewrite a broken config.json', async () => {
    fs.writeFileSync(configFile(), '{ broken');
    const { status, json } = await call('PUT', '/quick-settings', { maxPlayers: 20 });
    expect(status).toBe(409);
    expect(json.reason).toBe('invalid_json');
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe('{ broken');
  });
});

describe('PUT /config/:filename', () => {
  const content = (value: unknown) => JSON.stringify(value, null, 2);

  it('checks config.json against the server schema before writing', async () => {
    const bad = await call('PUT', '/config/config.json', {
      content: content({ ...CONFIG, Defaults: { GameMode: 'Exploration' } }),
    });
    expect(bad.status).toBe(400);
    expect(bad.json.reason).toBe('invalid_config');
    const broken = await call('PUT', '/config/config.json', { content: '{ nope' });
    expect(broken.status).toBe(400);
    expect(broken.json.reason).toBe('invalid_json');
    expect(readConfig()).toEqual(CONFIG);
  });

  it('writes atomically with a .bak and passes warnings on', async () => {
    const next = { ...CONFIG, MaxViewRadius: 48 };
    const { status, json } = await call('PUT', '/config/config.json', { content: content(next) });
    expect(status).toBe(200);
    expect(json.warnings).toContain('MaxViewRadius: the server uses 32 (allowed 1-32)');
    expect(readConfig()).toEqual(next);
    expect(JSON.parse(fs.readFileSync(`${configFile()}.bak`, 'utf-8'))).toEqual(CONFIG);
    expect(fs.readdirSync(serverDir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('needs a restart while the server runs', async () => {
    state.running = true;
    const refused = await call('PUT', '/config/permissions.json', { content: '{"users":{}}' });
    expect(refused.status).toBe(409);
    expect(refused.json.requiresRestart).toBe(true);
    const done = await call('PUT', '/config/permissions.json', {
      content: '{"users":{}}',
      restart: true,
    });
    expect(done.status).toBe(200);
    expect(done.json.restarted).toBe(true);
  });

  it('needs the rights of the access pages for the access files', async () => {
    const put = (name: string, value: unknown) =>
      call('PUT', `/config/${name}`, { content: content(value) });
    const cases: [string, unknown, string[]][] = [
      ['permissions.json', { users: {} }, ['players.permissions', 'players.op']],
      ['bans.json', { Version: 1, Bans: [] }, ['players.ban', 'players.unban']],
      ['whitelist.json', { enabled: false, list: [] }, ['players.whitelist']],
      ['bans-names.json', {}, ['players.unban']],
    ];
    for (const [name, value, rights] of cases) {
      for (const right of rights) {
        denied.clear();
        denied.add(right);
        expect((await put(name, value)).status, `${name} without ${right}`).toBe(403);
      }
      expect(fs.existsSync(path.join(serverDir, name))).toBe(false);
      denied.clear();
      expect((await put(name, value)).status, name).toBe(200);
    }
    // Other files only need config.edit.
    denied.add('players.op');
    expect((await put('server.properties.json', {})).status).toBe(200);
  });

  it('treats the ban file config.json names like bans.json', async () => {
    fs.writeFileSync(
      configFile(),
      content({ ...CONFIG, BanStorage: { Type: 'Disk', Path: 'mybans.json' } }),
    );
    denied.add('players.unban');
    const refused = await call('PUT', '/config/mybans.json', {
      content: '{"Version":1,"Bans":[]}',
    });
    expect(refused.status).toBe(403);
  });

  it('treats a ban file with another ending the same, and wants JSON in it', async () => {
    fs.writeFileSync(
      configFile(),
      content({ ...CONFIG, BanStorage: { Type: 'Disk', Path: 'bans.yml' } }),
    );
    const broken = await call('PUT', '/config/bans.yml', { content: 'not: json' });
    expect(broken.status).toBe(400);
    expect(broken.json).toMatchObject({ reason: 'invalid_config' });
    expect(fs.existsSync(path.join(serverDir, 'bans.yml'))).toBe(false);
    denied.add('players.unban');
    expect((await call('PUT', '/config/bans.yml', { content: '{"Bans":[]}' })).status).toBe(403);
    // Another .yml file is no access file.
    expect((await call('PUT', '/config/other.yml', { content: 'a: 1' })).status).toBe(200);
  });

  it('needs the right of the access page to read an access file', async () => {
    fs.writeFileSync(path.join(serverDir, 'permissions.json'), '{"users":{}}');
    fs.writeFileSync(path.join(serverDir, 'bans.json'), '{"Version":1,"Bans":[]}');
    denied.add('players.permissions');
    expect((await call('GET', '/config/permissions.json')).status).toBe(403);
    expect((await call('GET', '/config/bans.json')).status).toBe(200);
    expect((await call('GET', '/config/config.json')).status).toBe(200);
    denied.clear();
    denied.add('players.ban');
    expect((await call('GET', '/config/bans.json')).status).toBe(403);
    expect((await call('GET', '/config/permissions.json')).json.content).toBe('{"users":{}}');
  });

  it('refuses an access file the server could not read', async () => {
    const r = await call('PUT', '/config/permissions.json', {
      content: content({ users: { 'name:Bob': { groups: ['Mods'] } } }),
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ reason: 'invalid_config' });
    expect(r.json.issues[0]).toMatch(/not a UUID/);
    const bans = await call('PUT', '/config/bans.json', { content: '{"Bans": 3}' });
    expect(bans.status).toBe(400);
    expect(fs.existsSync(path.join(serverDir, 'permissions.json'))).toBe(false);
  });

  it('needs the access rights for the whitelist switch and the ban storage in config.json', async () => {
    const put = (value: unknown) => call('PUT', '/config/config.json', { content: content(value) });
    denied.add('players.whitelist');
    expect((await put({ ...CONFIG, RequireJoinPermission: true })).status).toBe(403);
    denied.clear();
    denied.add('players.unban');
    expect((await put({ ...CONFIG, BanStorage: { Type: 'Disk', Path: 'x.json' } })).status).toBe(
      403,
    );
    expect(readConfig()).toEqual(CONFIG);
    // Other changes, and these settings left as they are, need config.edit only.
    denied.add('players.whitelist');
    expect((await put({ ...CONFIG, MOTD: 'new' })).status).toBe(200);
  });

  it('refuses names outside the server folder', async () => {
    for (const name of ['..%2Fx.json', 'a%5Cb.json', 'run.sh']) {
      expect((await call('PUT', `/config/${name}`, { content: '{}' })).status).toBe(400);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a config file that is a link',
    async () => {
      const outside = path.join(root, 'secret.json');
      fs.writeFileSync(outside, '{"jwtSecret":"x"}');
      fs.symlinkSync(outside, path.join(serverDir, 'linked.json'));
      expect((await call('GET', '/config/linked.json')).status).toBe(403);
      expect((await call('PUT', '/config/linked.json', { content: '{}' })).status).toBe(409);
      expect(fs.readFileSync(outside, 'utf-8')).toBe('{"jwtSecret":"x"}');
    },
  );
});
