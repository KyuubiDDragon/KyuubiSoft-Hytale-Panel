/**
 * The world routes work on the worlds of the requested server: the list,
 * details, a world backup and the chunk pre-generation of server B find B's
 * world folders and write into B's backups, and server A's world of another
 * name is not found on B's mount. Auth, permissions, Docker and the backup
 * lock are stubbed; both servers have temp folders.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { ServerContext } from '../../services/serverContext.js';
import { serverContextIn } from '../../test/serverContextStub.js';

const { contexts, execCommand } = vi.hoisted(() => ({
  contexts: new Map<string, ServerContext>(),
  execCommand: vi.fn(),
}));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
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
vi.mock('../../services/docker.js', () => ({
  execCommand: (cmd: string, id: string) => execCommand(cmd, id),
}));
vi.mock('../../services/backup.js', () => ({
  flushWorldsIfRunning: async () => ({}),
  withBackupLock: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../services/audit.js', () => ({ audit: () => undefined }));

// The system tar (Git for Windows' tar cannot take drive letters).
const hasTar =
  process.platform !== 'win32' &&
  spawnSync('sh', ['-c', 'command -v tar'], { stdio: 'ignore' }).status === 0;

const { default: worldsRoutes } = await import('./worlds.js');
const { cancelPregen } = await import('../../services/worldManager.js');

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

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-worlds-scope-'));
  a = serverContextIn(path.join(base, 'a'), 'default');
  b = serverContextIn(path.join(base, 'b'), 'srv-b');
  for (const [ctx, world] of [
    [a, 'spawn'],
    [b, 'arena'],
  ] as const) {
    contexts.set(ctx.id, ctx);
    const dir = path.join(ctx.paths.server, 'universe', 'worlds', world);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ Seed: ctx.id === 'srv-b' ? 2 : 1 }),
    );
    fs.mkdirSync(ctx.paths.backups, { recursive: true });
  }

  const app = express();
  app.use(express.json());
  app.use('/api/management', scope('default'), worldsRoutes);
  app.use('/api/servers/:serverId/management', scope(null), worldsRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  legacy = `${origin}/api/management`;
  scoped = `${origin}/api/servers/srv-b/management`;
});

afterAll(async () => {
  await cancelPregen('srv-b');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  execCommand.mockReset();
  execCommand.mockResolvedValue({ success: true, message: 'Pregen: 10% (1/10 chunks)' });
});

describe('worlds per server', () => {
  it("lists each server's own worlds", async () => {
    const onB = await get(`${scoped}/worlds`);
    expect(onB.json.worlds.map((w: { name: string }) => w.name)).toEqual(['arena']);
    expect(onB.json.checkedPaths.every((p: string) => p.startsWith(path.join(base, 'b')))).toBe(
      true,
    );
    const onA = await get(`${legacy}/worlds`);
    expect(onA.json.worlds.map((w: { name: string }) => w.name)).toEqual(['spawn']);
  });

  it('finds a world only on its own server', async () => {
    const details = await get(`${scoped}/worlds/arena/details`);
    expect(details.json).toMatchObject({ name: 'arena', seed: '2' });
    expect((await get(`${scoped}/worlds/spawn/details`)).status).toBe(404);
    expect((await get(`${legacy}/worlds/arena/details`)).status).toBe(404);
  });

  it.skipIf(!hasTar)("backs a world of B up into B's backups", async () => {
    const res = await fetch(`${scoped}/worlds/arena/backup`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(fs.readdirSync(b.paths.backups)).toEqual([
      expect.stringMatching(/^world_arena_\d{8}-\d{6}\.tar\.gz$/),
    ]);
    expect(fs.readdirSync(a.paths.backups)).toEqual([]);
    const backups = await get(`${scoped}/worlds/backups`);
    expect(backups.json.backups.map((x: { world: string }) => x.world)).toEqual(['arena']);
    expect((await get(`${legacy}/worlds/backups`)).json.backups).toEqual([]);
  });

  it('starts the pre-generation of a world of B on B', async () => {
    const res = await fetch(`${scoped}/worlds/arena/pregen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ radius: 4 }),
    });
    expect(res.status).toBe(200);
    expect(execCommand).toHaveBeenCalledWith('/pregen start arena 4', 'srv-b');
    expect((await get(`${scoped}/worlds/pregen/status`)).json.state).toBe('running');
    expect((await get(`${legacy}/worlds/pregen/status`)).json.state).toBe('idle');
  });
});
