/**
 * Lifecycle, plugin and crash routes per server: on the scoped mount of
 * server B every console command, plugin call, player file read and crash
 * lookup is for B, and the audit names B. The services are stubbed and
 * record which server they were asked about.
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

const { contexts, calls, audit } = vi.hoisted(() => ({
  contexts: new Map<string, ServerContext>(),
  /** [function, server id] of every stubbed service call. */
  calls: [] as Array<[string, unknown]>,
  audit: vi.fn(),
}));
const recordSync =
  (name: string, idArg: number, result: unknown = { success: true, data: {} }) =>
  (...args: unknown[]) => {
    calls.push([name, args[idArg]]);
    return result;
  };
const record =
  (name: string, idArg: number, result: unknown = { success: true, data: {} }) =>
  async (...args: unknown[]) =>
    recordSync(name, idArg, result)(...args);

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
  getStatus: record('getStatus', 0, { running: true }),
  getStats: record('getStats', 0, {}),
  execCommand: record('execCommand', 1, { success: true, output: 'Used: 1.0 GiB' }),
}));
vi.mock('../../services/kyuubiApi.js', () => ({
  PLUGIN_VERSION: '2.1.1',
  getPluginStatus: record('getPluginStatus', 0, {}),
  isUpdateAvailable: record('isUpdateAvailable', 0, {}),
  installPlugin: record('installPlugin', 0),
  uninstallPlugin: record('uninstallPlugin', 0),
  getPlayersFromPlugin: record('getPlayersFromPlugin', 0),
  getServerInfoFromPlugin: record('getServerInfoFromPlugin', 0),
  getMemoryFromPlugin: record('getMemoryFromPlugin', 0),
  getPrometheusMetrics: record('getPrometheusMetrics', 0, { success: true, data: '' }),
  getTpsFromPlugin: record('getTpsFromPlugin', 0, { success: false }),
  getPlayerDetailsFromPlugin: record('getPlayerDetailsFromPlugin', 1),
  getPlayerInventoryFromPlugin: record('getPlayerInventoryFromPlugin', 1),
  getPlayerAppearanceFromPlugin: record('getPlayerAppearanceFromPlugin', 1),
}));
vi.mock('../../services/players.js', () => ({
  getPlayerDetailsFromFile: record('getPlayerDetailsFromFile', 1, { name: 'p' }),
  getPlayerInventoryFromFile: record('getPlayerInventoryFromFile', 1, { items: [] }),
}));
vi.mock('../../services/serverLifecycle.js', () => ({
  startServer: record('startServer', 0, { ok: true, method: 'docker' }),
  stopServerGracefully: record('stopServerGracefully', 0, { ok: true, method: 'command' }),
  restartServerGracefully: record('restartServerGracefully', 0, { ok: true, method: 'command' }),
}));
vi.mock('../../services/crashReports.js', () => ({
  getCrashReports: recordSync('getCrashReports', 0, []),
  getCrashReport: recordSync('getCrashReport', 1, null),
}));
vi.mock('../../services/audit.js', () => ({ audit }));

const { default: lifecycleRoutes } = await import('./lifecycle.js');
const { default: crashesRoutes } = await import('./crashes.js');

let base: string;
let server: Server;
let scoped: string;

const scope = (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = req.params.serverId;
  next();
};

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-lifecycle-scope-'));
  for (const id of ['default', 'srv-b']) {
    const ctx = serverContextIn(path.join(base, id), id);
    fs.mkdirSync(ctx.paths.server, { recursive: true });
    contexts.set(id, ctx);
  }
  // Registered, but its files are not visible to the panel.
  contexts.set('srv-c', serverContextIn(path.join(base, 'srv-c'), 'srv-c'));

  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId/server', scope, lifecycleRoutes, crashesRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  scoped = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/servers/srv-b/server`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  audit.mockReset();
});

describe('server routes per server', () => {
  it('asks every service about server B', async () => {
    const requests: Array<[string, string]> = [
      ['GET', '/status'],
      ['GET', '/stats'],
      ['GET', '/memory'],
      ['GET', '/plugin/status'],
      ['GET', '/plugin/update-check'],
      ['POST', '/plugin/install'],
      ['DELETE', '/plugin/uninstall'],
      ['GET', '/plugin/players'],
      ['GET', '/plugin/info'],
      ['GET', '/plugin/memory'],
      ['GET', '/plugin/metrics'],
      ['GET', '/plugin/tps'],
      ['GET', '/plugin/players/Steve/details'],
      ['GET', '/plugin/players/Steve/inventory'],
      ['GET', '/plugin/players/Steve/appearance'],
      ['GET', '/players/Steve/file/details'],
      ['GET', '/players/Steve/file/inventory'],
      ['POST', '/start'],
      ['POST', '/stop'],
      ['POST', '/restart'],
      ['GET', '/crashes'],
      ['GET', '/crashes/7'],
    ];
    for (const [method, url] of requests) {
      const res = await fetch(`${scoped}${url}`, { method });
      expect(res.status, `${method} ${url}`).toBeLessThan(500);
    }
    const asked = calls.filter(([, id]) => id !== 'srv-b');
    expect(asked, 'calls for another server').toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(requests.length);
  });

  it('only shows a crash report of the requested server', async () => {
    const res = await fetch(`${scoped}/crashes/7`);
    expect(res.status).toBe(404);
    expect(calls).toEqual([['getCrashReport', 'srv-b']]);
  });

  it('names the resolved server in the audit log', async () => {
    await fetch(`${scoped}/stop`, { method: 'POST' });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'server.stopped', {
      target: 'server:srv-b',
      metadata: { method: 'command' },
    });
  });

  it('refuses plugin installs and player files of a server whose files it cannot see', async () => {
    const other = scoped.replace('srv-b', 'srv-c');
    for (const [method, url] of [
      ['POST', '/plugin/install'],
      ['DELETE', '/plugin/uninstall'],
      ['GET', '/players/Steve/file/details'],
    ]) {
      const res = await fetch(`${other}${url}`, { method });
      expect(res.status, url).toBe(409);
    }
    expect(calls).toEqual([]);
  });
});
