/**
 * Every server has its own wiki: a scan on /api/servers/:id/wiki reads that
 * server's mods and plugins and is stored in its manager-side folder; the
 * legacy /api/wiki keeps the default server's wiki where it always was.
 * Public reading stays limited to the default server's wiki. Auth (a request
 * header stands for a signed-in user) and permissions are stubbed.
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
  authMiddleware: (
    req: { user?: string; headers: Record<string, unknown> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!req.headers['x-test-user']) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
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
vi.mock('../services/activityLog.js', () => ({ logActivity: vi.fn() }));
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

const { default: wikiRoutes } = await import('./wiki.js');
const { managerDataDir } = await import('../services/perServerData.js');
const { setWikiConfig } = await import('../services/wiki.js');

let base: string;
let a: ServerContext;
let b: ServerContext;
let missing: ServerContext;
let server: Server;
let origin: string;

const scope = (id: string | null) => (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = id ?? req.params.serverId;
  next();
};

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-wiki-scope-'));
  a = serverContextIn(path.join(base, 'a'), 'default');
  b = serverContextIn(path.join(base, 'b'), 'srv-b');
  // Registered, but its folders are not there (e.g. the instances mount is missing).
  missing = serverContextIn(path.join(base, 'nowhere'), 'srv-c');
  for (const ctx of [a, b, missing]) contexts.set(ctx.id, ctx);
  for (const [ctx, jar] of [
    [a, 'ModOfA.jar'],
    [b, 'ModOfB.jar'],
  ] as const) {
    fs.mkdirSync(ctx.paths.mods, { recursive: true });
    fs.mkdirSync(ctx.paths.server, { recursive: true });
    fs.writeFileSync(path.join(ctx.paths.mods, jar), 'not a real jar');
  }

  const app = express();
  app.use(express.json());
  app.use('/api/wiki', scope('default'), wikiRoutes);
  app.use('/api/servers/:serverId/wiki', scope(null), wikiRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

interface WikiIndexBody {
  entries: { fileName: string }[];
}
const signedIn = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { 'x-test-user': 'alice' } });
const index = async (url: string) => (await (await signedIn(url)).json()) as WikiIndexBody;
const names = (body: WikiIndexBody) => body.entries.map((e) => e.fileName);

describe('wiki per server', () => {
  it("scans and stores each server's wiki on its own", async () => {
    const regen = await signedIn(`${origin}/api/servers/srv-b/wiki/regenerate`, {
      method: 'POST',
    });
    expect(regen.status).toBe(200);

    expect(names(await index(`${origin}/api/servers/srv-b/wiki`))).toEqual(['ModOfB.jar']);
    expect(names(await index(`${origin}/api/wiki`))).toEqual(['ModOfA.jar']);

    expect(fs.existsSync(path.join(managerDataDir('srv-b'), 'wiki', 'index.json'))).toBe(true);
    // The default server keeps the folder single-server panels used.
    expect(path.join(managerDataDir('default'), 'wiki')).toBe(
      path.join(process.env.MANAGER_DATA_PATH!, 'wiki'),
    );

    const page = await signedIn(`${origin}/api/servers/srv-b/wiki/mod-modofb`);
    expect(page.status).toBe(200);
    expect((await signedIn(`${origin}/api/wiki/mod-modofb`)).status).toBe(404);
  });

  it('refuses a scan while the server files are not visible, and stores no empty wiki', async () => {
    const regen = await signedIn(`${origin}/api/servers/srv-c/wiki/regenerate`, {
      method: 'POST',
    });
    expect(regen.status).toBe(409);
    expect(((await regen.json()) as { code: string }).code).toBe('server_files_unavailable');

    expect((await index(`${origin}/api/servers/srv-c/wiki`)).entries).toEqual([]);
    expect(fs.existsSync(path.join(managerDataDir('srv-c'), 'wiki', 'index.json'))).toBe(false);
  });

  it("opens only the default server's wiki to the public", async () => {
    await setWikiConfig({ publicAccess: true });
    try {
      expect((await fetch(`${origin}/api/wiki?public=true`)).status).toBe(200);
      expect((await fetch(`${origin}/api/servers/default/wiki?public=true`)).status).toBe(200);
      expect((await fetch(`${origin}/api/servers/srv-b/wiki?public=true`)).status).toBe(401);
      expect((await fetch(`${origin}/api/servers/srv-b/wiki/mod-modofb?public=true`)).status).toBe(
        401,
      );
    } finally {
      await setWikiConfig({ publicAccess: false });
    }
    expect((await fetch(`${origin}/api/wiki?public=true`)).status).toBe(401);
  });
});
