/**
 * The Update Center reads the patchline and the auto-update switch from the
 * requested server's panel-config.json and asks that server's downloader for
 * the latest version: server B on its own patchline, in its own container.
 * Docker and the lifecycle module are stubbed; both servers have temp folders.
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

const { contexts, execInContainer } = vi.hoisted(() => ({
  contexts: new Map<string, ServerContext>(),
  execInContainer: vi.fn(),
}));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  mayAccessServer: async () => true,
  SERVER_NOT_ALLOWED: 'SERVER_NOT_ALLOWED',
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
vi.mock('../../services/servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/servers.js')>()),
  resolveServerId: async (id?: string | null) => id || 'default',
}));
vi.mock('../../services/docker.js', () => ({
  getContainerState: async () => ({ running: false, status: 'exited' }),
  execInContainer: (cmd: string, id: string) => execInContainer(cmd, id),
}));
vi.mock('../../services/serverLifecycle.js', () => ({
  withServerStopped: async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  startServer: async () => ({ ok: true, method: 'docker' }),
  isLifecycleBusy: () => false,
  LifecycleError: class LifecycleError extends Error {},
  LifecycleBusyError: class LifecycleBusyError extends Error {},
}));

const { default: updatesRoutes } = await import('./updates.js');

let base: string;
let server: Server;
let scoped: string;

const scope = (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = req.params.serverId;
  next();
};

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-updates-scope-'));
  for (const [id, patchline] of [
    ['default', 'release'],
    ['srv-b', 'pre-release'],
  ]) {
    const ctx = serverContextIn(path.join(base, id), id);
    fs.mkdirSync(ctx.paths.server, { recursive: true });
    fs.mkdirSync(ctx.paths.data, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.paths.data, 'panel-config.json'),
      JSON.stringify({ patchline, autoUpdate: id === 'srv-b' }),
    );
    // The downloader token of the additional server, in its instance folder.
    fs.mkdirSync(path.join(base, id, 'downloader'), { recursive: true });
    fs.writeFileSync(
      path.join(base, id, 'downloader', '.hytale-downloader-credentials.json'),
      '{}',
    );
    contexts.set(id, ctx);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId/server', scope, updatesRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  scoped = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/servers/srv-b/server`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  execInContainer.mockReset();
  execInContainer.mockImplementation(async (cmd: string) => ({
    success: true,
    output: cmd.includes("-patchline 'pre-release'") ? 'version: 0.7.5-pre' : 'version: 0.7.4',
  }));
});

describe('Update Center per server', () => {
  it("checks B's patchline with B's downloader", async () => {
    const res = await fetch(`${scoped}/check-update`);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      patchline: 'pre-release',
      latestVersion: '0.7.5-pre',
      versions: { release: '0.7.4', preRelease: '0.7.5-pre' },
    });
    expect(new Set(execInContainer.mock.calls.map((c) => c[1]))).toEqual(new Set(['srv-b']));
  });

  it("records the latest version of B's patchline", async () => {
    const res = await fetch(`${scoped}/update-check`, { method: 'POST' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { lastCheck: Record<string, unknown> } };
    expect(json.data.lastCheck).toMatchObject({
      patchline: 'pre-release',
      latestVersion: '0.7.5-pre',
    });
    expect(new Set(execInContainer.mock.calls.map((c) => c[1]))).toEqual(new Set(['srv-b']));
  });

  it("shows B's patchline in its update settings", async () => {
    const res = await fetch(`${scoped}/update-config`);
    expect(((await res.json()) as { patchline: string }).patchline).toBe('pre-release');
  });
});
