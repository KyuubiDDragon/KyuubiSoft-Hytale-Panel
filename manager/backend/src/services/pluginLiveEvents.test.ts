/**
 * Live-data events of the KyuubiSoft API plugin (2.1+): wire schemas, the
 * forwarding to the panel event bus, and the full path from the plugin
 * WebSocket to a panel event. Frames below were recorded from a 0.7.3 server.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { parsePluginEvent } from '../schemas/pluginEvents.js';
import { PanelEventNames, type PanelEvent } from '../schemas/events.js';
import { subscribe } from './eventBus.js';
import { forwardLiveEvent, type LiveDataEvent } from './pluginLiveEvents.js';

const tmpDir = path.join(os.tmpdir(), `kp-pluginlive-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

// In the stack the plugin listens on its fixed port inside each container;
// here the stand-in runs on a random local port.
const pluginPorts = vi.hoisted(() => new Map<string, number>());
vi.mock('./serverContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./serverContext.js')>();
  return {
    ...actual,
    getServerContext: async (id?: string | null) => {
      const ctx = await actual.getServerContext(id);
      const port = pluginPorts.get(ctx.id);
      return port ? { ...ctx, plugin: { ...ctx.plugin, port } } : ctx;
    },
  };
});

const ts = '2026-10-22T12:39:50.682345300Z';

// Recorded from the plugin on a 0.7.3 server (scratch copy).
const recorded = {
  groupAdded: {
    scope: 'user',
    action: 'group_added',
    uuid: '11111111-2222-3333-4444-555555555555',
    group: 'hytale:Builder',
    type: 'permission_changed',
    timestamp: ts,
  },
  groupPermissions: {
    scope: 'group',
    action: 'permissions_added',
    group: 'hytale:Builder',
    permissions: ['p3data.group.node'],
    type: 'permission_changed',
    timestamp: ts,
  },
  worldAdded: { world: 'p3probe', type: 'world_added', timestamp: ts },
  worldRemovedOnShutdown: {
    world: 'flat_world',
    reason: 'EXCEPTIONAL',
    serverShuttingDown: true,
    type: 'world_removed',
    timestamp: ts,
  },
  shutdown: { reason: 'normal', exitCode: 0, type: 'server_shutdown', timestamp: ts },
  pluginUnloaded: {
    plugin: 'Hytale:Parkour',
    name: 'Parkour',
    version: '1.0.0',
    from: 'ENABLED',
    to: 'UNLOADED',
    type: 'plugin_state',
    timestamp: ts,
  },
};

// Not recordable without a game client; shapes follow the plugin's frame classes.
const synthetic = {
  gamemode: {
    player: 'Steve',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    world: 'flat_world',
    from: 'adventure',
    to: 'creative',
    type: 'player_gamemode',
    timestamp: ts,
  },
  joinDenied: {
    player: 'Griefer',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
    kind: 'banned',
    reason: 'You are banned: griefing',
    reasonId: 'server.modules.ban.permanent',
    type: 'player_join_denied',
    timestamp: ts,
  },
  pluginFailed: {
    plugin: 'kyuubisoft:pets',
    from: 'START',
    to: 'FAILED',
    error: { type: 'java.lang.IllegalStateException', message: 'config broken' },
    type: 'plugin_state',
    timestamp: ts,
  },
};

function collect(patterns: string[]): { events: PanelEvent[]; stop: () => void } {
  const events: PanelEvent[] = [];
  const stop = subscribe(patterns, (e) => events.push(e));
  return { events, stop };
}

function parsed(raw: unknown): LiveDataEvent {
  const result = parsePluginEvent(raw);
  if (!result.ok) throw new Error(result.error);
  return result.event as LiveDataEvent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('live-data event schemas', () => {
  it('accepts every recorded and synthetic frame', () => {
    for (const frame of [...Object.values(recorded), ...Object.values(synthetic)]) {
      const result = parsePluginEvent(frame);
      expect(result.ok, JSON.stringify(frame)).toBe(true);
    }
  });

  it('rejects frames that drift from the contract', () => {
    expect(parsePluginEvent({ ...synthetic.joinDenied, kind: 'kicked' }).ok).toBe(false);
    expect(parsePluginEvent({ ...recorded.groupAdded, scope: 'world' }).ok).toBe(false);
    expect(parsePluginEvent({ ...recorded.groupAdded, action: 'renamed' }).ok).toBe(false);
    expect(parsePluginEvent({ type: 'world_added', timestamp: ts }).ok).toBe(false);
    expect(parsePluginEvent({ ...recorded.pluginUnloaded, to: undefined }).ok).toBe(false);
    expect(parsePluginEvent({ ...recorded.shutdown, exitCode: 'zero' }).ok).toBe(false);
    expect(parsePluginEvent({ ...synthetic.gamemode, to: undefined }).ok).toBe(false);
  });
});

describe('forwardLiveEvent', () => {
  it('publishes each frame as its panel event with the server id', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { events, stop } = collect(['*']);
    for (const frame of [...Object.values(recorded), ...Object.values(synthetic)]) {
      forwardLiveEvent('srv-1', parsed(frame));
    }
    stop();

    expect(events.map((e) => e.name)).toEqual([
      'permissions.changed',
      'permissions.changed',
      'world.added',
      'world.removed',
      'server.shutdown',
      'plugin.state_changed',
      'player.gamemode_changed',
      'player.join_denied',
      'plugin.state_changed',
    ]);
    expect(events.every((e) => e.serverId === 'srv-1')).toBe(true);

    const byName = (name: string) => events.filter((e) => e.name === name);
    expect(byName('world.removed')[0].payload).toEqual({
      world: 'flat_world',
      reason: 'EXCEPTIONAL',
      serverShuttingDown: true,
    });
    expect(byName('server.shutdown')[0].payload).toEqual({
      reason: 'normal',
      exitCode: 0,
      message: undefined,
    });
    expect(byName('player.join_denied')[0].payload).toMatchObject({
      player: 'Griefer',
      kind: 'banned',
      reason: 'You are banned: griefing',
    });
    expect(byName('player.gamemode_changed')[0].payload).toMatchObject({
      player: 'Steve',
      from: 'adventure',
      to: 'creative',
    });
    expect(byName('permissions.changed')[1].payload).toMatchObject({
      scope: 'group',
      group: 'hytale:Builder',
      permissions: ['p3data.group.node'],
    });
    // Failure detail travels as plain text, usable in webhooks and templates.
    expect(byName('plugin.state_changed')[1].payload).toMatchObject({
      plugin: 'kyuubisoft:pets',
      to: 'FAILED',
      error: 'config broken',
    });
  });

  it('defaults serverShuttingDown to false for a normal world unload', () => {
    const { events, stop } = collect(['world.removed']);
    forwardLiveEvent(
      'srv-1',
      parsed({ world: 'p3probe', reason: 'GENERAL', type: 'world_removed', timestamp: ts }),
    );
    stop();
    expect(events[0].payload.serverShuttingDown).toBe(false);
  });

  it('declares every forwarded name in the panel event catalog', async () => {
    const forwarded = [
      'server.shutdown',
      'player.gamemode_changed',
      'player.join_denied',
      'world.added',
      'world.removed',
      'plugin.state_changed',
      'permissions.changed',
    ];
    for (const name of forwarded) expect(PanelEventNames).toContain(name);
    // Event actions and webhooks bind to the catalog, categories included.
    const { isValidEventPattern } = await import('./eventActions.js');
    for (const pattern of ['world.*', 'plugin.*', 'permissions.*', 'player.join_denied']) {
      expect(isValidEventPattern(pattern), pattern).toBe(true);
    }
  });
});

describe('plugin WebSocket to panel event', () => {
  let wss: WebSocketServer;
  let events: typeof import('./pluginEvents.js');

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => resolve());
    });
    // The stand-in plugin sends live-data frames as soon as the panel connects.
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify(recorded.worldAdded));
      socket.send(JSON.stringify(synthetic.joinDenied));
      socket.send(JSON.stringify({ ...recorded.shutdown, exitCode: 'bad' }));
      socket.send(JSON.stringify(recorded.pluginUnloaded));
    });
    const port = (wss.address() as AddressInfo).port;
    pluginPorts.set('live', port);
    fs.writeFileSync(
      path.join(tmpDir, 'servers.json'),
      JSON.stringify({
        schemaVersion: 1,
        defaultId: 'live',
        servers: [
          {
            id: 'live',
            name: 'live',
            containerName: '127.0.0.1',
            status: 'ready',
            network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: port },
            paths: {
              server: '/tmp/s',
              data: '/tmp/d',
              backups: '/tmp/b',
              mods: '/tmp/m',
              plugins: '/tmp/p',
              assets: '/tmp/a',
              auth: '/tmp/au',
            },
            createdAt: new Date().toISOString(),
            createdBy: 'system',
          },
        ],
      }),
    );
    events = await import('./pluginEvents.js');
  });

  afterAll(async () => {
    events.disconnectAll();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('forwards valid frames and drops the malformed one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { events: published, stop } = collect([
      'world.*',
      'player.join_denied',
      'plugin.*',
      'server.*',
    ]);

    await events.connect('live');
    const start = Date.now();
    while (published.length < 3 && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Give a wrongly accepted malformed frame time to show up.
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();
    events.disconnect('live');

    expect(published.map((e) => e.name)).toEqual([
      'world.added',
      'player.join_denied',
      'plugin.state_changed',
    ]);
    expect(published.every((e) => e.serverId === 'live')).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Rejected event'))).toBe(true);
  });
});
