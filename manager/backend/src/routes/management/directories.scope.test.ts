/**
 * Mods and plugins routes act on the folders of the request's server: the
 * legacy mount on the default server, /api/servers/:id/management on the
 * named one. Two servers with their own temp folders; auth, permissions and
 * the external mod registry are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { ServerContext } from '../../services/serverContext.js';
import { serverContextIn } from '../../test/serverContextStub.js';

const { contexts, logActivity } = vi.hoisted(() => ({
  contexts: new Map<string, ServerContext>(),
  logActivity: vi.fn(),
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
vi.mock('../../services/activityLog.js', () => ({
  logActivity,
  getActivityLog: () => ({ entries: [] }),
  clearActivityLog: async () => {},
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
// The registry lookup would go to the network.
vi.mock('../../services/modStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/modStore.js')>()),
  getModRegistry: async () => [],
}));

const { default: directoriesRoutes } = await import('./directories.js');

const JAR = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

let base: string;
let a: ServerContext;
let b: ServerContext;
let server: Server;
let legacy: string;
let scoped: string;

function resetFolders(): void {
  for (const ctx of [a, b]) {
    for (const dir of ['mods', 'plugins', 'server', 'data'] as const) {
      fs.rmSync(ctx.paths[dir], { recursive: true, force: true });
      fs.mkdirSync(ctx.paths[dir], { recursive: true });
    }
  }
}

const list = (dir: string) => fs.readdirSync(dir).sort();

interface ModList {
  mods: { filename: string }[];
  plugins: { filename: string }[];
  path: string;
}
const listing = async (url: string) => (await (await fetch(url)).json()) as ModList;

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-dirs-scope-'));
  a = serverContextIn(path.join(base, 'a'), 'default');
  b = serverContextIn(path.join(base, 'b'), 'srv-b');
  contexts.set(a.id, a);
  contexts.set(b.id, b);

  const app = express();
  app.use(express.json());
  // What legacyServerScope / serverScopeMiddleware do in index.ts.
  app.use(
    '/api/management',
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.serverId = 'default';
      next();
    },
    directoriesRoutes,
  );
  app.use(
    '/api/servers/:serverId/management',
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.serverId = req.params.serverId;
      next();
    },
    directoriesRoutes,
  );
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

beforeEach(() => {
  resetFolders();
  logActivity.mockReset();
});

describe('mods and plugins routes per server', () => {
  it('lists the mods and plugins of the requested server', async () => {
    fs.writeFileSync(path.join(a.paths.mods, 'OnA.jar'), JAR);
    fs.writeFileSync(path.join(b.paths.mods, 'OnB.jar'), JAR);
    fs.writeFileSync(path.join(b.paths.plugins, 'PluginB.jar'), JAR);

    const legacyMods = await listing(`${legacy}/mods`);
    const scopedMods = await listing(`${scoped}/mods`);
    const scopedPlugins = await listing(`${scoped}/plugins`);

    expect(legacyMods.mods.map((m) => m.filename)).toEqual(['OnA.jar']);
    expect(legacyMods.path).toBe(a.paths.mods);
    expect(scopedMods.mods.map((m) => m.filename)).toEqual(['OnB.jar']);
    expect(scopedMods.path).toBe(b.paths.mods);
    expect(scopedPlugins.path).toBe(b.paths.plugins);
  });

  it('stores an upload in the requested server only', async () => {
    const form = new FormData();
    form.append('file', new Blob([JAR]), 'Uploaded.jar');
    const res = await fetch(`${scoped}/mods/upload`, { method: 'POST', body: form });

    expect(res.status).toBe(200);
    expect(list(b.paths.mods)).toEqual([((await res.json()) as { filename: string }).filename]);
    expect(list(a.paths.mods)).toEqual([]);
    expect(logActivity.mock.calls[0][5]).toMatch(/\(server srv-b\)$/);

    const pluginForm = new FormData();
    pluginForm.append('file', new Blob([JAR]), 'Plugin.jar');
    expect(
      (await fetch(`${scoped}/plugins/upload`, { method: 'POST', body: pluginForm })).status,
    ).toBe(200);
    expect(list(b.paths.plugins)).toHaveLength(1);
    expect(list(a.paths.plugins)).toEqual([]);
  });

  it('deletes the file and the install-list entry of the requested server only', async () => {
    const entry = (filename: string) => ({
      mods: { p1: { projectId: 'p1', filename, classification: 'PLUGIN', version: '1' } },
    });
    for (const ctx of [a, b]) {
      fs.writeFileSync(path.join(ctx.paths.mods, 'Same.jar'), JAR);
      fs.writeFileSync(
        path.join(ctx.paths.data, 'modtale-installed.json'),
        JSON.stringify(entry('Same.jar')),
      );
    }

    expect((await fetch(`${scoped}/mods/Same.jar`, { method: 'DELETE' })).status).toBe(200);

    expect(list(b.paths.mods)).toEqual([]);
    expect(
      JSON.parse(fs.readFileSync(path.join(b.paths.data, 'modtale-installed.json'), 'utf-8')).mods,
    ).toEqual({});
    expect(list(a.paths.mods)).toEqual(['Same.jar']);
    expect(
      JSON.parse(fs.readFileSync(path.join(a.paths.data, 'modtale-installed.json'), 'utf-8')).mods,
    ).toHaveProperty('p1');
  });

  it('stores nothing when the server is gone', async () => {
    const form = new FormData();
    form.append('file', new Blob([JAR]), 'Lost.jar');
    const res = await fetch(`${scoped.replace('srv-b', 'gone')}/mods/upload`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(500);
    expect(list(a.paths.mods)).toEqual([]);
    expect(list(b.paths.mods)).toEqual([]);
  });

  it('toggles a mod of the requested server', async () => {
    for (const ctx of [a, b]) fs.writeFileSync(path.join(ctx.paths.mods, 'Toggle.jar'), JAR);

    expect((await fetch(`${scoped}/mods/Toggle.jar/toggle`, { method: 'PUT' })).status).toBe(200);

    expect(list(b.paths.mods)).toEqual(['Toggle.jar.disabled']);
    expect(list(a.paths.mods)).toEqual(['Toggle.jar']);
  });

  it('keeps the activity log of the default server as before', async () => {
    fs.writeFileSync(path.join(a.paths.mods, 'Gone.jar'), JAR);
    expect((await fetch(`${legacy}/mods/Gone.jar`, { method: 'DELETE' })).status).toBe(200);
    expect(list(a.paths.mods)).toEqual([]);
    expect(logActivity.mock.calls[0][5]).toBe('Deleted mod: Gone.jar');
  });
});

describe('mod and plugin uploads', () => {
  const upload = async (content: Buffer | string, name: string, kind = 'mods') => {
    const form = new FormData();
    form.append('file', new Blob([content]), name);
    return fetch(`${scoped}/${kind}/upload`, { method: 'POST', body: form });
  };

  it('checks the content before anything lands in the mods folder', async () => {
    const res = await upload('#!/bin/sh\necho not a jar\n', 'Fake.jar');
    expect(res.status).toBe(400);
    // no rejected file, no temporary file
    expect(list(b.paths.mods)).toEqual([]);
  });

  it('takes a short script', async () => {
    expect((await upload('print("hi")\n', 'small.lua')).status).toBe(200);
    expect(list(b.paths.mods)).toHaveLength(1);
  });

  it('refuses a script with binary content', async () => {
    expect((await upload(Buffer.from([0x2d, 0x2d, 0x00, 0x41]), 'bad.lua', 'plugins')).status).toBe(
      400,
    );
    expect(list(b.paths.plugins)).toEqual([]);
  });

  // Uploads wait in the manager volume (not in memory, not where a server
  // could see them) until they are checked.
  it('leaves nothing in the staging folder, stored or refused', async () => {
    const staging = path.join(process.env.MANAGER_DATA_PATH!, 'staging');
    const big = Buffer.concat([JAR, Buffer.alloc(256 * 1024, 0x61)]);

    const stored = await upload(big, 'Big.jar');
    expect(stored.status).toBe(200);
    const { filename } = (await stored.json()) as { filename: string };
    expect(fs.readFileSync(path.join(b.paths.mods, filename))).toEqual(big);
    expect(await upload('not a jar', 'Fake.jar')).toHaveProperty('status', 400);
    const gone = await fetch(`${scoped.replace('srv-b', 'gone')}/mods/upload`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('file', new Blob([JAR]), 'Lost.jar');
        return form;
      })(),
    });
    expect(gone.status).toBe(500);

    // Removed right after the answer is sent.
    await vi.waitFor(() => expect(fs.readdirSync(staging)).toEqual([]));
  });
});
