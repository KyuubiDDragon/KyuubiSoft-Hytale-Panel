/**
 * Route tests for the world editor and the world file editor.
 *
 * Real filesystem (temp worlds root); Docker, the lifecycle module, the
 * plugin's command endpoint, auth and permissions are stubbed. Covers: the
 * 0.7 field names, writes only with the server stopped or an explicit
 * restart, PvP and the time pause applied live and checked against the
 * server's answer, seeds beyond 2^53 kept digit for digit, and the checks of
 * the generic file editor.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { PluginCommandAttempt } from '../../services/pluginCommands.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-worldconfig-route-'));
const worldsRoot = path.join(root, 'worlds');
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
delete process.env.DEMO_MODE;

const state = { running: false };

const getContainerState = vi.fn(async (_id?: string) => ({ running: state.running }));
vi.mock('../../services/docker.js', () => ({
  getContainerState: (id?: string) => getContainerState(id),
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
const runWhileServerStopped = vi.fn(
  async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) =>
    state.running ? { ran: false } : { ran: true, value: await fn() },
);
const isLifecycleBusy = vi.fn((_id: string) => false);
vi.mock('../../services/serverLifecycle.js', () => ({
  withServerStopped: (id: unknown, opts: unknown, fn: () => Promise<unknown>) =>
    withServerStopped(id, opts, fn),
  runWhileServerStopped: (id: unknown, opts: unknown, fn: () => Promise<unknown>) =>
    runWhileServerStopped(id, opts, fn),
  isLifecycleBusy: (id: string) => isLifecycleBusy(id),
  LifecycleError: class LifecycleError extends Error {},
  LifecycleBusyError: class LifecycleBusyError extends Error {},
}));
// Two registered servers; the worlds root belongs to the default one.
vi.mock('../../services/servers.js', () => ({
  resolveServerId: async (id?: string) => id ?? 'default',
  getDefaultId: async () => 'default',
  getServer: async (id: string) => (id === 'default' || id === 'other' ? { id } : null),
}));
vi.mock('../../services/managementHelpers.js', () => ({ getWorldsPaths: () => [worldsRoot] }));
const runCommandViaPlugin =
  vi.fn<(command: string, serverId?: string) => Promise<PluginCommandAttempt>>();
vi.mock('../../services/pluginCommands.js', () => ({
  runCommandViaPlugin: (command: string, serverId?: string) =>
    runCommandViaPlugin(command, serverId),
}));
const isPluginInstalled = vi.fn(async (_id?: string) => true);
vi.mock('../../services/kyuubiApi.js', () => ({
  isPluginInstalled: (id?: string) => isPluginInstalled(id),
}));
vi.mock('../../services/audit.js', () => ({ audit: () => undefined }));
vi.mock('../../services/activityLog.js', () => ({ logActivity: async () => undefined }));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'tester';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const express = (await import('express')).default;
const { default: worldConfigsRouter } = await import('./worldConfigs.js');
const { forgetLiveValues } = await import('../../services/worldSettings.js');
const { serverScopeMiddleware } = await import('../../middleware/serverScope.js');

// As the server writes it: a seed beyond 2^53 and keys the editor does not know.
const WORLD_TEXT = `{
  "Version": 4,
  "Seed": 9007199254740993,
  "IsPvpEnabled": false,
  "IsGameTimePaused": false,
  "GameTime": "0001-01-01T08:00:00Z",
  "DaytimeDurationSecondsOverride": 600,
  "WorldGen": {"Type": "Hytale", "Name": "Default"}
}`;
const worldDir = path.join(worldsRoot, 'default');
const worldFile = path.join(worldDir, 'config.json');

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
let origin: string;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/management', worldConfigsRouter);
  // Mounted like index.ts does for the scoped routes.
  app.use('/api/servers/:serverId/management', serverScopeMiddleware, worldConfigsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseUrl = `${origin}/api/management`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(worldsRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(worldDir, 'resources'), { recursive: true });
  fs.writeFileSync(worldFile, WORLD_TEXT);
  fs.writeFileSync(path.join(worldDir, 'resources', 'Time.json'), '{"Now":"x"}');
  state.running = false;
  withServerStopped.mockClear();
  runWhileServerStopped.mockClear();
  isLifecycleBusy.mockClear();
  getContainerState.mockClear();
  isPluginInstalled.mockClear();
  runCommandViaPlugin.mockReset();
  forgetLiveValues();
});

async function call(method: string, url: string, body?: unknown) {
  return send(method, baseUrl + url, body);
}

async function send(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('GET /worlds/:worldName/config', () => {
  it('returns the editor fields with the server fallbacks and the apply modes', async () => {
    const { status, json } = await call('GET', '/worlds/default/config');
    expect(status).toBe(200);
    expect(json).toMatchObject({
      name: 'default',
      seed: '9007199254740993',
      isPvpEnabled: false,
      isFallDamageEnabled: true,
      gameMode: null,
      daytimeDurationSeconds: null,
      fields: { isPvpEnabled: 'live', isGameTimePaused: 'live', gameMode: 'restart' },
      warnings: [
        'DaytimeDurationSecondsOverride: not a world setting; the server reads DaytimeDurationSeconds',
      ],
      serverRunning: false,
    });
  });

  it('refuses world names that leave the worlds folder', async () => {
    expect((await call('GET', '/worlds/..%2F..%2Fetc/config')).status).toBe(400);
    expect((await call('GET', '/worlds/missing/config')).status).toBe(404);
  });
});

describe('PUT /worlds/:worldName/config', () => {
  it('writes the real keys while the server is stopped and keeps everything else exactly', async () => {
    const { status, json } = await call('PUT', '/worlds/default/config', {
      isPvpEnabled: true,
      gameMode: 'Creative',
      daytimeDurationSeconds: 900,
      seed: 'ignored',
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ applied: 'file', restarted: false });
    const text = fs.readFileSync(worldFile, 'utf-8');
    expect(text).toContain('"Seed": 9007199254740993');
    const saved = JSON.parse(text);
    expect(saved).toMatchObject({
      IsPvpEnabled: true,
      GameMode: 'Creative',
      DaytimeDurationSeconds: 900,
      WorldGen: { Type: 'Hytale', Name: 'Default' },
    });
    expect(fs.readFileSync(`${worldFile}.bak`, 'utf-8')).toBe(WORLD_TEXT);
  });

  it('refuses invalid values', async () => {
    for (const body of [
      { gameMode: 'Survival' },
      { daytimeDurationSeconds: -1 },
      { isPvpEnabled: 'on' },
    ]) {
      expect((await call('PUT', '/worlds/default/config', body)).status, JSON.stringify(body)).toBe(
        400,
      );
    }
    expect(fs.readFileSync(worldFile, 'utf-8')).toBe(WORLD_TEXT);
  });

  it('asks for a restart for start-only fields on a running server', async () => {
    state.running = true;
    const refused = await call('PUT', '/worlds/default/config', {
      isSpawningNPC: false,
      isPvpEnabled: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      restartFields: ['isSpawningNPC'],
      liveFields: ['isPvpEnabled'],
    });
    expect(fs.readFileSync(worldFile, 'utf-8')).toBe(WORLD_TEXT);
    const done = await call('PUT', '/worlds/default/config', {
      isSpawningNPC: false,
      restart: true,
    });
    expect(done.json).toMatchObject({ applied: 'restart', restarted: true });
    expect(JSON.parse(fs.readFileSync(worldFile, 'utf-8')).IsSpawningNPC).toBe(false);
    expect(runCommandViaPlugin).not.toHaveBeenCalled();
  });

  it('switches PvP live and remembers it until the server saved the world', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue(
      reply(['server.universe.setpvp.info'], 'PvP is now true'),
    );
    const { status, json } = await call('PUT', '/worlds/default/config', { isPvpEnabled: true });
    expect(status).toBe(200);
    expect(json.applied).toBe('live');
    expect(runCommandViaPlugin.mock.calls.map((c) => c[0])).toEqual([
      '/world config pvp true --world default',
    ]);
    expect(fs.readFileSync(worldFile, 'utf-8')).toBe(WORLD_TEXT);
    // The file still says false; the editor shows what the server uses.
    expect((await call('GET', '/worlds/default/config')).json.isPvpEnabled).toBe(true);
    // Switching back right away is a change again.
    runCommandViaPlugin.mockClear();
    await call('PUT', '/worlds/default/config', { isPvpEnabled: false });
    expect(runCommandViaPlugin.mock.calls.map((c) => c[0])).toEqual([
      '/world config pvp false --world default',
    ]);
  });

  it('applies a PvP change live when the form sends every field at its default', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue(
      reply(['server.universe.setpvp.info'], 'PvP is now true'),
    );
    const form = (await call('GET', '/worlds/default/config')).json;
    const { status, json } = await call('PUT', '/worlds/default/config', {
      ...form,
      isPvpEnabled: true,
    });
    expect(status).toBe(200);
    expect(json.applied).toBe('live');
    expect(fs.readFileSync(worldFile, 'utf-8')).toBe(WORLD_TEXT);
  });

  it('toggles the time pause until the server reports the wanted state', async () => {
    state.running = true;
    runCommandViaPlugin
      .mockResolvedValueOnce(reply(['server.commands.pausetime.timeInfoResumed'], 'resumed'))
      .mockResolvedValueOnce(reply(['server.commands.pausetime.timeInfo'], 'paused'));
    const { status, json } = await call('PUT', '/worlds/default/config', {
      isGameTimePaused: true,
    });
    expect(status).toBe(200);
    expect(json.results).toEqual([{ key: 'IsGameTimePaused', ok: true, message: 'paused' }]);
    expect(runCommandViaPlugin).toHaveBeenCalledTimes(2);
  });

  it('reports a live change the server did not confirm', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue(
      reply(['server.commands.errors.noWorld'], 'no such world'),
    );
    const { status, json } = await call('PUT', '/worlds/default/config', { isPvpEnabled: true });
    expect(status).toBe(502);
    expect(json.reason).toBe('not_confirmed');
  });

  it('asks for a restart when the plugin is not reachable', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue({ kind: 'unavailable', reason: 'plugin not installed' });
    const { status, json } = await call('PUT', '/worlds/default/config', { isPvpEnabled: true });
    expect(status).toBe(409);
    expect(json.reason).toBe('live_unavailable');
  });
});

describe('world files', () => {
  it('reads and writes resources/*.json only with the server stopped', async () => {
    const read = await call('GET', '/worlds/default/files/resources/Time.json');
    expect(read.json.content).toEqual({ Now: 'x' });
    state.running = true;
    const refused = await call('PUT', '/worlds/default/files/resources/Time.json', {
      content: '{"Now":"y"}',
    });
    expect(refused.status).toBe(409);
    state.running = false;
    const done = await call('PUT', '/worlds/default/files/resources/Time.json', {
      content: '{"Now":"y"}',
    });
    expect(done.status).toBe(200);
    expect(fs.readFileSync(path.join(worldDir, 'resources', 'Time.json'), 'utf-8')).toBe(
      '{"Now":"y"}',
    );
    expect(fs.readFileSync(path.join(worldDir, 'resources', 'Time.json.bak'), 'utf-8')).toBe(
      '{"Now":"x"}',
    );
  });

  it('checks paths, JSON and the world config schema', async () => {
    expect(
      (await call('PUT', '/worlds/default/files/chunks/x.json', { content: '{}' })).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/worlds/default/files/resources/Time.json', { content: '{ no' })).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/worlds/default/files/resources/New.json', { content: '{}' })).status,
    ).toBe(404);
    const bad = await call('PUT', '/worlds/default/files/config.json', {
      content: '{"GameMode":"Survival"}',
    });
    expect(bad.status).toBe(400);
    expect(fs.readFileSync(worldFile, 'utf-8')).toBe(WORLD_TEXT);
  });
});

describe('two servers', () => {
  const scoped = (id: string, url: string) => `${origin}/api/servers/${id}/management${url}`;
  const ids = (fn: { mock: { calls: unknown[][] } }, arg = 0) => fn.mock.calls.map((c) => c[arg]);

  it('uses the default server for state, live commands, lock and restart on its scoped route', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue(
      reply(['server.universe.setpvp.info'], 'PvP is now true'),
    );
    const read = await send('GET', scoped('default', '/worlds/default/config'));
    expect(read.json).toMatchObject({ serverRunning: true, liveAvailable: true });
    expect(ids(isPluginInstalled)).toEqual(['default']);

    const live = await send('PUT', scoped('default', '/worlds/default/config'), {
      isPvpEnabled: true,
    });
    expect(live.json.applied).toBe('live');
    expect(ids(runCommandViaPlugin, 1)).toEqual(['default']);

    const restarted = await send('PUT', scoped('default', '/worlds/default/config'), {
      isSpawningNPC: false,
      restart: true,
    });
    expect(restarted.json).toMatchObject({ applied: 'restart', restarted: true });
    expect(ids(withServerStopped)).toEqual(['default']);
    expect(ids(isLifecycleBusy)).toEqual(['default']);
    expect(new Set(ids(getContainerState))).toEqual(new Set(['default']));
  });

  it('passes the stopped server on to the lock when it writes a file', async () => {
    const done = await send('PUT', scoped('default', '/worlds/default/files/resources/Time.json'), {
      content: '{"Now":"y"}',
    });
    expect(done.status).toBe(200);
    expect(ids(runWhileServerStopped)).toEqual(['default']);
  });

  it('refuses another server instead of reading, changing or restarting the default one', async () => {
    state.running = true;
    runCommandViaPlugin.mockResolvedValue(
      reply(['server.universe.setpvp.info'], 'PvP is now true'),
    );
    const requests: Array<[string, string, unknown?]> = [
      ['GET', '/worlds/default/config'],
      ['PUT', '/worlds/default/config', { isPvpEnabled: true }],
      ['PUT', '/worlds/default/config', { isSpawningNPC: false, restart: true }],
      ['GET', '/worlds/default/files/resources/Time.json'],
      ['PUT', '/worlds/default/files/resources/Time.json', { content: '{}', restart: true }],
    ];
    for (const [method, url, body] of requests) {
      const r = await send(method, scoped('other', url), body);
      expect(r.status, `${method} ${url}`).toBe(409);
      expect(r.json.reason).toBe('default_server_only');
    }
    expect(fs.readFileSync(worldFile, 'utf-8')).toBe(WORLD_TEXT);
    expect(runCommandViaPlugin).not.toHaveBeenCalled();
    expect(withServerStopped).not.toHaveBeenCalled();
    expect(runWhileServerStopped).not.toHaveBeenCalled();
    expect(getContainerState).not.toHaveBeenCalled();
  });

  it('answers an unknown server with 404 before any world code runs', async () => {
    const r = await send('GET', scoped('nope', '/worlds/default/config'));
    expect(r.status).toBe(404);
    expect(getContainerState).not.toHaveBeenCalled();
  });
});
