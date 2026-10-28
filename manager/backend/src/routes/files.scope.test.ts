/**
 * The file manager works on the folders of the request's server: legacy
 * /api/files on the default server, /api/servers/:id/files on the named one.
 * The access files of every server stay locked. Auth and permissions are
 * stubbed; both servers have their own temp folders.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { ServerContext } from '../services/serverContext.js';
import { serverContextIn } from '../test/serverContextStub.js';

const { contexts, logActivity } = vi.hoisted(() => ({
  contexts: new Map<string, ServerContext>(),
  logActivity: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../services/activityLog.js', () => ({ logActivity }));
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

const { default: filesRoutes } = await import('./files.js');

let base: string;
let a: ServerContext;
let b: ServerContext;
let server: Server;
let origin: string;
let legacy: string;
let scoped: string;

const scope = (id: string | null) => (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = id ?? req.params.serverId;
  next();
};

const content = async (url: string) => (await (await fetch(url)).json()) as { content: string };

const put = (url: string, body: unknown) =>
  fetch(`${url}/write`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-files-scope-'));
  a = serverContextIn(path.join(base, 'a'), 'default');
  b = serverContextIn(path.join(base, 'b'), 'srv-b');
  contexts.set(a.id, a);
  contexts.set(b.id, b);

  const app = express();
  app.use(express.json());
  app.use('/api/files', scope('default'), filesRoutes);
  app.use('/api/servers/:serverId/files', scope(null), filesRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  legacy = `${origin}/api/files`;
  scoped = `${origin}/api/servers/srv-b/files`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  for (const ctx of [a, b]) {
    fs.rmSync(path.dirname(ctx.paths.server), { recursive: true, force: true });
    for (const dir of ['mods', 'plugins', 'server', 'data'] as const) {
      fs.mkdirSync(ctx.paths[dir], { recursive: true });
    }
    fs.writeFileSync(path.join(ctx.paths.server, 'notes.txt'), `notes of ${ctx.id}`);
  }
  logActivity.mockReset();
});

describe('file manager per server', () => {
  it('offers the folders of the requested server as roots', async () => {
    const { roots } = (await (await fetch(`${scoped}/roots`)).json()) as {
      roots: { id: string; path: string }[];
    };
    expect(Object.fromEntries(roots.map((r) => [r.id, r.path]))).toEqual({
      mods: b.paths.mods,
      plugins: b.paths.plugins,
      server: b.paths.server,
      data: b.paths.data,
    });
  });

  it('reads and writes the files of the requested server only', async () => {
    const readB = await content(`${scoped}/read?rootId=server&path=notes.txt`);
    const readA = await content(`${legacy}/read?rootId=server&path=notes.txt`);
    expect(readB.content).toBe('notes of srv-b');
    expect(readA.content).toBe('notes of default');

    const res = await put(scoped, { rootId: 'server', path: 'notes.txt', content: 'changed on B' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(b.paths.server, 'notes.txt'), 'utf-8')).toBe('changed on B');
    expect(fs.readFileSync(path.join(a.paths.server, 'notes.txt'), 'utf-8')).toBe(
      'notes of default',
    );
    expect(logActivity.mock.calls[0][5]).toBe('(server srv-b)');
  });

  it('moves and deletes inside the requested server only', async () => {
    for (const ctx of [a, b]) fs.writeFileSync(path.join(ctx.paths.mods, 'x.cfg'), 'x');
    const move = await fetch(`${scoped}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootId: 'mods', from: 'x.cfg', to: 'y.cfg' }),
    });
    expect(move.status).toBe(200);
    const del = await fetch(scoped, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootId: 'server', path: 'notes.txt', confirmToken: 'yes' }),
    });
    expect(del.status).toBe(200);

    expect(fs.readdirSync(b.paths.mods)).toEqual(['y.cfg']);
    expect(fs.existsSync(path.join(b.paths.server, 'notes.txt'))).toBe(false);
    expect(fs.readdirSync(a.paths.mods)).toEqual(['x.cfg']);
    expect(fs.existsSync(path.join(a.paths.server, 'notes.txt'))).toBe(true);
  });

  it("keeps every server's access files locked", async () => {
    fs.writeFileSync(path.join(b.paths.server, 'permissions.json'), '{}');
    const read = await fetch(`${scoped}/read?rootId=server&path=permissions.json`);
    expect(read.status).toBe(403);
    expect(((await read.json()) as { code: string }).code).toBe('PATH_DENIED');
    const write = await put(scoped, { rootId: 'server', path: 'bans.json', content: '[]' });
    expect(write.status).toBe(403);
    expect(fs.existsSync(path.join(b.paths.server, 'bans.json'))).toBe(false);
  });

  it("does not reach another server's files through a link", async () => {
    // A junction needs no extra rights on Windows ('junction' is ignored on POSIX).
    const link = path.join(b.paths.mods, 'to-a');
    fs.symlinkSync(a.paths.server, link, 'junction');
    try {
      const read = await fetch(`${scoped}/read?rootId=mods&path=to-a/notes.txt`);
      expect(read.status).toBe(403);
      const write = await put(scoped, { rootId: 'mods', path: 'to-a/notes.txt', content: 'x' });
      expect(write.status).toBe(403);
      expect(fs.readFileSync(path.join(a.paths.server, 'notes.txt'), 'utf-8')).toBe(
        'notes of default',
      );
    } finally {
      // Remove the link itself before any recursive cleanup can follow it.
      fs.unlinkSync(link);
    }
  });

  it('answers 404 for a server that is gone', async () => {
    const res = await fetch(`${origin}/api/servers/gone/files/roots`);
    expect(res.status).toBe(404);
  });
});
