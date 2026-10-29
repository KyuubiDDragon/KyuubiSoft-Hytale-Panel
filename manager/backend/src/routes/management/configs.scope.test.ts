/**
 * The mod/plugin config editor works on the folders of the request's server:
 * paths of another server are outside its roots, and the access files of the
 * server folder stay locked on every server. Auth and permissions are
 * stubbed; both servers have their own temp folders.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { ServerContext } from '../../services/serverContext.js';
import { serverContextIn } from '../../test/serverContextStub.js';

const { contexts } = vi.hoisted(() => ({ contexts: new Map<string, ServerContext>() }));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/activityLog.js', () => ({ logActivity: vi.fn() }));
vi.mock('../../services/serverContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/serverContext.js')>();
  return {
    ...actual,
    getServerContext: async (id?: string | null) => {
      const ctx = contexts.get(id ?? 'default');
      if (!ctx) throw new actual.UnknownServerError(String(id));
      return ctx;
    },
  };
});

const { default: configsRoutes } = await import('./configs.js');

let base: string;
let a: ServerContext;
let b: ServerContext;
let server: Server;
let legacy: string;
let scoped: string;

const scope = (id: string | null) => (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = id ?? req.params.serverId;
  next();
};

beforeAll(async () => {
  // Real path: the editor compares resolved paths.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-configs-scope-')));
  a = serverContextIn(path.join(base, 'a'), 'default');
  b = serverContextIn(path.join(base, 'b'), 'srv-b');
  for (const ctx of [a, b]) {
    contexts.set(ctx.id, ctx);
    fs.mkdirSync(path.join(ctx.paths.mods, 'cool_SomeMod'), { recursive: true });
    fs.mkdirSync(ctx.paths.plugins, { recursive: true });
    fs.mkdirSync(ctx.paths.server, { recursive: true });
    fs.mkdirSync(ctx.paths.data, { recursive: true });
    fs.writeFileSync(path.join(ctx.paths.mods, 'cool_SomeMod', 'settings.yml'), `on: ${ctx.id}`);
    fs.writeFileSync(path.join(ctx.paths.server, 'bans.json'), '[]');
  }

  const app = express();
  app.use(express.json());
  app.use('/api/management', scope('default'), configsRoutes);
  app.use('/api/servers/:serverId/management', scope(null), configsRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  legacy = `${origin}/api/management`;
  scoped = `${origin}/api/servers/srv-b/management`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

const readConfig = (url: string, file: string) =>
  fetch(`${url}/config/read?path=${encodeURIComponent(file)}`);

describe('config editor per server', () => {
  it("finds a mod's config files in the requested server", async () => {
    const { configs } = (await (await fetch(`${scoped}/mods/SomeMod-1.0.jar/configs`)).json()) as {
      configs: { path: string }[];
    };
    expect(configs.map((c) => c.path)).toEqual([
      path.join(b.paths.mods, 'cool_SomeMod', 'settings.yml'),
    ]);
  });

  it('reads and writes inside the requested server only', async () => {
    const fileB = path.join(b.paths.mods, 'cool_SomeMod', 'settings.yml');
    const fileA = path.join(a.paths.mods, 'cool_SomeMod', 'settings.yml');

    const read = (await (await readConfig(scoped, fileB)).json()) as { content: string };
    expect(read.content).toBe('on: srv-b');
    expect((await readConfig(scoped, fileA)).status).toBe(403);
    expect((await readConfig(legacy, fileB)).status).toBe(403);

    const write = await fetch(`${scoped}/config/write`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: fileB, content: 'on: changed' }),
    });
    expect(write.status).toBe(200);
    expect(fs.readFileSync(fileB, 'utf-8')).toBe('on: changed');
    expect(fs.readFileSync(fileA, 'utf-8')).toBe('on: default');

    const crossWrite = await fetch(`${scoped}/config/write`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: fileA, content: 'pwned' }),
    });
    expect(crossWrite.status).toBe(403);
    expect(fs.readFileSync(fileA, 'utf-8')).toBe('on: default');
  });

  it('keeps the access files locked on every server', async () => {
    expect((await readConfig(scoped, path.join(b.paths.server, 'bans.json'))).status).toBe(403);
    expect((await readConfig(legacy, path.join(a.paths.server, 'bans.json'))).status).toBe(403);
  });
});
