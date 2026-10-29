/**
 * Every mod-store route that installs, removes or lists installed mods hands
 * the store services the request's server: the default server on the legacy
 * mount, the named one on /api/servers/:id/management. The services are
 * stubbed (they would go to the network); auth and permissions too.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import type { ServerContext } from '../../services/serverContext.js';
import { serverContextIn } from '../../test/serverContextStub.js';

const { contexts, calls, stubs } = vi.hoisted(() => {
  const calls = vi.fn();
  /** Replaces `names` of a module with recorders that answer `result`. */
  const stubs = (names: string[], result: (name: string) => unknown) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        async (...args: unknown[]) => {
          calls(name, ...args);
          return result(name);
        },
      ]),
    );
  return { contexts: new Map<string, ServerContext>(), calls, stubs };
});
const ok = () => ({ success: true });

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
vi.mock('../../services/modStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/modStore.js')>()),
  ...stubs(['getAvailableMods', 'installMod', 'uninstallMod', 'updateMod'], (name) =>
    name === 'getAvailableMods' ? [] : { success: true },
  ),
  getModRegistry: async () => [{ id: 'store-mod', name: 'Store Mod' }],
}));
vi.mock('../../services/modCompat.js', () =>
  stubs(['checkRegistryMod', 'checkInstalledJar'], () => ({ declared: { source: 'jar' } })),
);
vi.mock('../../services/modtale.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/modtale.js')>()),
  ...stubs(['installModFromModtale', 'getInstalledModtaleInfo', 'uninstallModtale'], ok),
}));
vi.mock('../../services/stackmart.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/stackmart.js')>()),
  ...stubs(['installResourceFromStackMart', 'getInstalledStackMartInfo', 'uninstallStackMart'], ok),
}));
vi.mock('../../services/curseforge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/curseforge.js')>()),
  ...stubs(
    [
      'installModFromCurseForge',
      'updateMod',
      'checkForUpdates',
      'getInstalledCurseForgeInfo',
      'uninstallCurseForge',
    ],
    (name) => (name === 'checkForUpdates' ? [] : { success: true }),
  ),
}));
vi.mock('../../services/cfwidget.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/cfwidget.js')>()),
  ...stubs(
    [
      'trackMod',
      'untrackMod',
      'checkModUpdate',
      'checkAllUpdates',
      'getUpdateStatus',
      'updateInstalledVersion',
      'installTrackedMod',
      'uninstallTrackedMod',
    ],
    ok,
  ),
}));

const { default: cacheRoutes } = await import('./cache.js');

let a: ServerContext;
let b: ServerContext;
let server: Server;
let origin: string;

const scope = (id: string | null) => (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = id ?? req.params.serverId;
  next();
};

beforeAll(async () => {
  a = serverContextIn(path.join('/srv', 'a'), 'default');
  b = serverContextIn(path.join('/srv', 'b'), 'srv-b');
  contexts.set(a.id, a);
  contexts.set(b.id, b);
  const app = express();
  app.use(express.json());
  app.use('/api/management', scope('default'), cacheRoutes);
  app.use('/api/servers/:serverId/management', scope(null), cacheRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => calls.mockReset());

// [method, route, body, service function, the arguments after the server]
const ROUTES: [string, string, unknown, string, unknown[]][] = [
  ['GET', '/modstore', undefined, 'getAvailableMods', []],
  ['POST', '/modstore/store-mod/install', undefined, 'installMod', ['store-mod']],
  ['DELETE', '/modstore/store-mod/uninstall', undefined, 'uninstallMod', ['store-mod']],
  ['POST', '/modstore/store-mod/update', undefined, 'updateMod', ['store-mod']],
  [
    'POST',
    '/modtale/install',
    { projectId: 'proj-1' },
    'installModFromModtale',
    ['proj-1', undefined],
  ],
  ['GET', '/modtale/installed', undefined, 'getInstalledModtaleInfo', []],
  ['DELETE', '/modtale/uninstall/proj-1', undefined, 'uninstallModtale', ['proj-1']],
  [
    'POST',
    '/stackmart/install',
    { resourceId: 'res-1' },
    'installResourceFromStackMart',
    ['res-1'],
  ],
  ['GET', '/stackmart/installed', undefined, 'getInstalledStackMartInfo', []],
  ['DELETE', '/stackmart/uninstall/res-1', undefined, 'uninstallStackMart', ['res-1']],
  ['POST', '/curseforge/install', { modId: 123 }, 'installModFromCurseForge', [123, undefined]],
  ['POST', '/curseforge/update', { modId: 123 }, 'updateMod', [123, undefined]],
  ['GET', '/curseforge/updates', undefined, 'checkForUpdates', []],
  ['GET', '/curseforge/installed', undefined, 'getInstalledCurseForgeInfo', []],
  ['DELETE', '/curseforge/uninstall/123', undefined, 'uninstallCurseForge', [123]],
  ['GET', '/modupdates/status', undefined, 'getUpdateStatus', []],
  ['POST', '/modupdates/check', undefined, 'checkAllUpdates', []],
  [
    'POST',
    '/modupdates/track',
    { curseforgeInput: 'some-mod' },
    'trackMod',
    ['', 'some-mod', undefined],
  ],
  ['DELETE', '/modupdates/track/A.jar', undefined, 'untrackMod', ['A.jar']],
  ['GET', '/modupdates/check/A.jar', undefined, 'checkModUpdate', ['A.jar']],
  [
    'PUT',
    '/modupdates/version/A.jar',
    { version: '2' },
    'updateInstalledVersion',
    ['A.jar', '2', undefined],
  ],
  ['POST', '/modupdates/install/A.jar', undefined, 'installTrackedMod', ['A.jar']],
  ['DELETE', '/modupdates/uninstall/A.jar', undefined, 'uninstallTrackedMod', ['A.jar']],
];

async function call(prefix: string, method: string, route: string, body: unknown) {
  return fetch(`${origin}${prefix}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('mod store routes per server', () => {
  it.each(ROUTES)(
    '%s %s hands the service the requested server',
    async (method, route, body, fn, args) => {
      for (const [prefix, ctx] of [
        ['/api/servers/srv-b/management', b],
        ['/api/management', a],
      ] as const) {
        calls.mockReset();
        const res = await call(prefix, method, route, body);
        expect(res.status, `${prefix}${route}`).toBe(200);
        const made = calls.mock.calls.filter(([name]) => name === fn);
        expect(made, `${prefix}${route}`).toHaveLength(1);
        expect(made[0].slice(1)).toEqual([ctx, ...args]);
      }
    },
  );

  it('checks compatibility against the requested server', async () => {
    await call('/api/servers/srv-b/management', 'GET', '/modstore/store-mod/compat', undefined);
    await call('/api/servers/srv-b/management', 'GET', '/mods/Mod.jar/compat', undefined);
    expect(calls.mock.calls).toEqual([
      ['checkRegistryMod', expect.anything(), b],
      ['checkInstalledJar', path.join(b.paths.mods, 'Mod.jar'), b],
    ]);
  });

  it('answers 500 instead of acting on another server when the server is gone', async () => {
    const res = await call(
      '/api/servers/gone/management',
      'POST',
      '/modstore/store-mod/install',
      undefined,
    );
    expect(res.status).toBe(500);
    expect(calls).not.toHaveBeenCalled();
  });
});
