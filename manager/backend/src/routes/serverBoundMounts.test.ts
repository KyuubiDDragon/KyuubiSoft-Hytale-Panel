/**
 * Live positions, replays and WebMap sessions are server-bound: mounted as in
 * index.ts (legacy path with the default server, scoped path with the named
 * one), a user limited to server B reads none of the default server's data
 * and gets B's on the scoped path. Real permission and scope middleware;
 * users, roles and the registry are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.MANAGER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-bound-mounts-'));

// "bee" may use server b only, with players.view and replay.view there.
const RIGHTS = ['players.view', 'replay.view'];
vi.mock('../services/roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/roles.js')>()),
  getUserPermissions: async () => RIGHTS,
  getUserPermissionsForServer: async (_u: string, serverId?: string) =>
    serverId === undefined || serverId === 'b' ? RIGHTS : [],
  getUserAllowedServers: async () => ['b'],
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'bee';
    next();
  },
}));
vi.mock('../services/servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/servers.js')>()),
  getDefaultId: async () => 'default',
  resolveServerId: async (id?: string | null) => id ?? 'default',
}));
vi.mock('../services/serverContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/serverContext.js')>()),
  getServerContext: async (id?: string | null) => ({
    id: id ?? 'default',
    kind: (id ?? 'default') === 'default' ? 'compose' : 'managed',
  }),
}));

const express = (await import('express')).default;
const { legacyServerScope, serverScopeMiddleware } = await import('../middleware/serverScope.js');
const { default: playerLocationsRoutes } = await import('./playerLocations.js');
const { default: replayRoutes } = await import('./replay.js');
const { default: webMapRoutes } = await import('./webmap.js');
const locations = await import('../services/playerLocations.js');
const { config } = await import('../config.js');

let server: Server;
let base: string;

beforeAll(async () => {
  (config as { multiserverEnabled: boolean }).multiserverEnabled = true;
  locations.pushSample({
    serverId: 'default',
    playerName: 'Alice',
    uuid: 'a',
    x: 1,
    y: 2,
    z: 3,
    world: 'Orbis',
    latencyMs: 0,
    ts: Date.now(),
  });
  locations.pushSample({
    serverId: 'b',
    playerName: 'Bob',
    uuid: 'b',
    x: 1,
    y: 2,
    z: 3,
    world: 'Orbis',
    latencyMs: 0,
    ts: Date.now(),
  });
  const app = express();
  app.use(express.json());
  // As in index.ts.
  app.use('/api/players/locations', legacyServerScope, playerLocationsRoutes);
  app.use('/api/replay', legacyServerScope, replayRoutes);
  app.use('/api/webmap', legacyServerScope, webMapRoutes);
  app.use('/api/servers/:serverId/players/locations', serverScopeMiddleware, playerLocationsRoutes);
  app.use('/api/servers/:serverId/replay', serverScopeMiddleware, replayRoutes);
  app.use('/api/servers/:serverId/webmap', serverScopeMiddleware, webMapRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = async (method: string, url: string) => {
  const res = await fetch(base + url, { method });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, unknown>,
  };
};

describe('server-bound mounts', () => {
  it('the legacy paths act on the default server, which the user may not use', async () => {
    for (const [method, url] of [
      ['GET', '/api/players/locations'],
      ['GET', '/api/players/locations/history'],
      ['GET', '/api/replay'],
      ['POST', '/api/webmap/session'],
    ] as const) {
      const r = await call(method, url);
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(r.json.code, `${method} ${url}`).toBe('SERVER_NOT_ALLOWED');
    }
  });

  it("the scoped paths serve the user's own server", async () => {
    const own = await call('GET', '/api/servers/b/players/locations');
    expect(own.status).toBe(200);
    expect((own.json.samples as Array<{ playerName: string }>).map((s) => s.playerName)).toEqual([
      'Bob',
    ]);
    expect((await call('GET', '/api/servers/b/replay')).status).toBe(200);
    expect((await call('POST', '/api/servers/b/webmap/session')).status).toBe(200);
    expect((await call('GET', '/api/servers/default/players/locations')).status).toBe(403);
  });
});
