/**
 * The wiki is server-bound: mounted as in index.ts (legacy /api/wiki with the
 * default server, /api/servers/:id/wiki with the named one), a user limited
 * to server B reads and scans none of the default server's wiki and gets B's
 * on the scoped path. Real permission and scope middleware; users, roles and
 * the registry are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { ServerContext } from '../services/serverContext.js';
import { serverContextIn } from '../test/serverContextStub.js';

process.env.MANAGER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-wiki-access-'));

const { contexts } = vi.hoisted(() => ({ contexts: new Map<string, ServerContext>() }));
// "bee" may use server b only, with the wiki rights there.
const RIGHTS = ['wiki.view', 'wiki.manage'];
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
vi.mock('../services/activityLog.js', () => ({ logActivity: vi.fn() }));
vi.mock('../services/servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/servers.js')>()),
  getDefaultId: async () => 'default',
  resolveServerId: async (id?: string | null) => id ?? 'default',
}));
vi.mock('../services/serverContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/serverContext.js')>();
  return {
    ...actual,
    getServerContext: async (id?: string | null) => {
      const ctx = contexts.get(id ?? 'default');
      if (!ctx) throw new actual.UnknownServerError(String(id));
      return ctx;
    },
  };
});

const express = (await import('express')).default;
const { legacyServerScope, serverScopeMiddleware } = await import('../middleware/serverScope.js');
const { default: wikiRoutes } = await import('./wiki.js');
const { managerDataDir } = await import('../services/perServerData.js');
const { config } = await import('../config.js');

let base: string;
let server: Server;
let origin: string;

beforeAll(async () => {
  (config as { multiserverEnabled: boolean }).multiserverEnabled = true;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-wiki-access-servers-'));
  for (const [id, jar] of [
    ['default', 'SecretModOfA.jar'],
    ['b', 'ModOfB.jar'],
  ]) {
    const ctx = serverContextIn(path.join(base, id), id);
    contexts.set(id, ctx);
    fs.mkdirSync(ctx.paths.mods, { recursive: true });
    fs.mkdirSync(ctx.paths.server, { recursive: true });
    fs.writeFileSync(path.join(ctx.paths.mods, jar), 'not a real jar');
  }
  const app = express();
  app.use(express.json());
  // As in index.ts.
  app.use('/api/wiki', legacyServerScope, wikiRoutes);
  app.use('/api/servers/:serverId/wiki', serverScopeMiddleware, wikiRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

const call = async (method: string, url: string) => {
  const res = await fetch(origin + url, { method });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, unknown>,
  };
};

describe('wiki access per server', () => {
  it('the legacy paths act on the default server, which the user may not use', async () => {
    for (const [method, url] of [
      ['GET', '/api/wiki'],
      ['GET', '/api/wiki/mod-secretmodofa'],
      ['POST', '/api/wiki/regenerate'],
    ] as const) {
      const r = await call(method, url);
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(r.json.code, `${method} ${url}`).toBe('SERVER_NOT_ALLOWED');
      expect(JSON.stringify(r.json)).not.toContain('SecretModOfA');
    }
    // Refused before the handler: not even a first scan of A's mods was stored.
    expect(fs.existsSync(path.join(managerDataDir('default'), 'wiki', 'index.json'))).toBe(false);
  });

  it("the scoped paths serve the user's own server only", async () => {
    expect((await call('POST', '/api/servers/b/wiki/regenerate')).status).toBe(200);
    const own = await call('GET', '/api/servers/b/wiki');
    expect(own.status).toBe(200);
    expect((own.json.entries as Array<{ fileName: string }>).map((e) => e.fileName)).toEqual([
      'ModOfB.jar',
    ]);
    expect((await call('GET', '/api/servers/default/wiki')).status).toBe(403);
  });
});
