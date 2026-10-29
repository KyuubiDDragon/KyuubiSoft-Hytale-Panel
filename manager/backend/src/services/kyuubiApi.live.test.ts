/**
 * Live-data clients in kyuubiApi.ts against a plugin stand-in: paths, the
 * bearer token, typed data, and the plugin's refusal status passed through
 * (404 offline, 501 not offered by the server build).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

const tmpDir = path.join(os.tmpdir(), `kp-kyuubi-live-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

interface Seen {
  url: string;
  authorization?: string;
}
const seen: Seen[] = [];

// Answers like the plugin: data for known paths, {status, error} otherwise.
const routes: Record<string, { status: number; body: unknown }> = {
  '/api/server/status': {
    status: 200,
    body: {
      build: { version: '0.7.3', revision: 'e1a1986a', patchline: 'release' },
      update: { moduleEnabled: true, available: false, downloading: false },
      auth: {
        mode: 'NONE',
        authenticated: false,
        hasSessionToken: false,
        hasIdentityToken: false,
        singleplayer: false,
      },
      lifecycle: { booted: true, shuttingDown: false },
      collectedAt: '2026-10-22T12:00:00Z',
    },
  },
  '/api/plugins': { status: 200, body: { count: 0, plugins: [] } },
  '/api/access/whitelist': {
    status: 200,
    body: { enabled: true, permission: 'hytale.server.join', count: 0, entries: [] },
  },
  '/api/access/bans': { status: 200, body: { count: 0, activeCount: 0, entries: [] } },
  '/api/permissions/groups': { status: 501, body: { status: 501, error: 'not loaded' } },
  '/api/permissions/users': { status: 200, body: { complete: false, count: 0, users: [] } },
  '/api/permissions/users/11111111-2222-3333-4444-555555555555': {
    status: 200,
    body: { uuid: '11111111-2222-3333-4444-555555555555', online: false, groups: [] },
  },
  '/api/sessions': { status: 200, body: { count: 0, sessions: [] } },
  '/api/players/Steve/live': { status: 404, body: { status: 404, error: 'Player is not online' } },
  '/api/players/Steve/inventory': {
    status: 409,
    body: { status: 409, error: 'Player is changing worlds, try again' },
  },
};

const stand = http.createServer((req, res) => {
  seen.push({ url: req.url ?? '', authorization: req.headers.authorization });
  const route = routes[req.url ?? ''] ?? { status: 404, body: { status: 404, error: 'nope' } };
  res.writeHead(route.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(route.body));
});

let api: typeof import('./kyuubiApi.js');
let tokenFor: (id: string) => Promise<string>;

beforeAll(async () => {
  await new Promise<void>((resolve) => stand.listen(0, '127.0.0.1', () => resolve()));
  const port = (stand.address() as AddressInfo).port;
  fs.writeFileSync(
    path.join(tmpDir, 'servers.json'),
    JSON.stringify({
      schemaVersion: 1,
      defaultId: 'main',
      servers: [
        {
          id: 'main',
          name: 'main',
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
  api = await import('./kyuubiApi.js');
  ({ getPluginToken: tokenFor } = await import('./pluginAuth.js'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => stand.close(() => resolve()));
});

describe('live-data clients', () => {
  it('requests each endpoint with the server token and returns its data', async () => {
    const status = await api.getServerStatusFromPlugin('main');
    expect(status.success).toBe(true);
    expect(status.data?.build.version).toBe('0.7.3');
    expect(status.data?.auth).not.toHaveProperty('token');

    const calls: [() => Promise<{ success: boolean }>, string][] = [
      [() => api.getLoadedPluginsFromPlugin('main'), '/api/plugins'],
      [() => api.getWhitelistFromPlugin('main'), '/api/access/whitelist'],
      [() => api.getBansFromPlugin('main'), '/api/access/bans'],
      [() => api.getPermissionUsersFromPlugin('main'), '/api/permissions/users'],
      [
        () => api.getPermissionUserFromPlugin('11111111-2222-3333-4444-555555555555', 'main'),
        '/api/permissions/users/11111111-2222-3333-4444-555555555555',
      ],
      [() => api.getSessionsFromPlugin('main'), '/api/sessions'],
    ];
    for (const [call, url] of calls) {
      expect((await call()).success, url).toBe(true);
      expect(seen.at(-1)?.url).toBe(url);
    }
    const token = await tokenFor('main');
    expect(seen.every((s) => s.authorization === `Bearer ${token}`)).toBe(true);
  });

  it('passes the plugin refusal status through', async () => {
    const groups = await api.getPermissionGroupsFromPlugin('main');
    expect(groups).toMatchObject({ success: false, status: 501 });

    const live = await api.getPlayerLiveFromPlugin('Steve', 'main');
    expect(live).toMatchObject({ success: false, status: 404 });
    expect(seen.at(-1)?.url).toBe('/api/players/Steve/live');

    const inventory = await api.getPlayerLiveInventoryFromPlugin('Steve', 'main');
    expect(inventory).toMatchObject({ success: false, status: 409 });
  });

  it('encodes player names and UUIDs into the path', async () => {
    await api.getPlayerLiveFromPlugin('a/../b', 'main');
    expect(seen.at(-1)?.url).toBe('/api/players/a%2F..%2Fb/live');
  });

  it('answers 501 in demo mode without calling the plugin', async () => {
    const { config } = await import('../config.js');
    const before = seen.length;
    const original = config.demoMode;
    config.demoMode = true;
    try {
      const result = await api.getSessionsFromPlugin('main');
      expect(result).toMatchObject({ success: false, status: 501 });
    } finally {
      config.demoMode = original;
    }
    expect(seen.length).toBe(before);
  });
});
