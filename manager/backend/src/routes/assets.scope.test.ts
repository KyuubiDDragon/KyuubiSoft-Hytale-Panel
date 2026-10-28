/**
 * The Asset Explorer cache is shared by all servers; its status names the
 * server the cache came from and looks for the Assets.zip of the requested
 * server. Auth and permissions are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { ServerContext } from '../services/serverContext.js';
import { serverContextIn } from '../test/serverContextStub.js';

const { contexts } = vi.hoisted(() => ({ contexts: new Map<string, ServerContext>() }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAllServerAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  mayAccessServer: async () => true,
  SERVER_NOT_ALLOWED: 'SERVER_NOT_ALLOWED',
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

const { default: assetsRoutes } = await import('./assets.js');
const { config } = await import('../config.js');

let base: string;
let a: ServerContext;
let b: ServerContext;
let server: Server;
let origin: string;

const scope = (id: string | null) => (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = id ?? req.params.serverId;
  next();
};

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-assets-scope-'));
  a = serverContextIn(path.join(base, 'a'), 'default');
  b = serverContextIn(path.join(base, 'b'), 'srv-b');
  for (const ctx of [a, b]) {
    contexts.set(ctx.id, ctx);
    fs.mkdirSync(ctx.paths.server, { recursive: true });
    fs.mkdirSync(ctx.paths.data, { recursive: true });
  }
  // Only B has an archive; the shared cache was extracted from A.
  fs.writeFileSync(path.join(b.paths.server, 'Assets.zip'), 'zip');
  fs.mkdirSync(path.join(config.assetsPath, 'Common'), { recursive: true });
  fs.writeFileSync(path.join(config.assetsPath, 'Common', 'x.json'), '{}');
  fs.writeFileSync(
    path.join(config.assetsPath, '.asset-meta.json'),
    JSON.stringify({
      sourceHash: 'abc',
      extractedAt: '2026-10-28T00:00:00.000Z',
      sourceFile: path.join(a.paths.server, 'Assets.zip'),
      fileCount: 1,
      sourceServerId: 'default',
      sourceServerName: 'Primary',
    }),
  );

  const app = express();
  app.use('/api/assets', scope('default'), assetsRoutes);
  app.use('/api/servers/:serverId/assets', scope(null), assetsRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(config.assetsPath, { recursive: true, force: true });
});

describe('asset explorer status per server', () => {
  it("looks for the requested server's archive and names where the cache came from", async () => {
    const statusB = await (await fetch(`${origin}/api/servers/srv-b/assets/status`)).json();
    expect(statusB).toMatchObject({
      extracted: true,
      sourceExists: true,
      sourceFile: path.join(b.paths.server, 'Assets.zip'),
      cacheSource: { serverId: 'default', serverName: 'Primary' },
      cacheFromThisServer: false,
      // Another server's archive is never compared with the cache.
      needsUpdate: false,
    });

    const statusA = await (await fetch(`${origin}/api/assets/status`)).json();
    expect(statusA).toMatchObject({
      sourceExists: false,
      cacheSource: { serverId: 'default' },
      cacheFromThisServer: true,
    });
  });

  it("treats a cache extracted before multiserver as the default server's", async () => {
    const metaFile = path.join(config.assetsPath, '.asset-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    delete meta.sourceServerId;
    delete meta.sourceServerName;
    fs.writeFileSync(metaFile, JSON.stringify(meta));

    const statusA = (await (await fetch(`${origin}/api/assets/status`)).json()) as {
      cacheSource: unknown;
      cacheFromThisServer: boolean;
    };
    expect(statusA.cacheSource).toEqual({ serverId: 'default', serverName: null });
    expect(statusA.cacheFromThisServer).toBe(true);
  });
});
