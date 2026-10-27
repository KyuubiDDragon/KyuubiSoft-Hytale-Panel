/**
 * Panel routes for the plugin's live data: rights per route, the server id
 * passed through, the plugin's refusal status kept (404/409/501) or mapped
 * to 503, and the live inventory served in the saved-file shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const granted = new Set<string>();
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'tester';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission:
    (...perms: string[]) =>
    (
      _req: unknown,
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) => {
      if (perms.every((p) => granted.has(p))) next();
      else res.status(403).json({ error: 'Forbidden' });
    },
}));

const calls: { fn: string; args: unknown[] }[] = [];
const answers = new Map<string, unknown>();
function stub(fn: string) {
  return (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve(answers.get(fn) ?? { success: true, data: { fn } });
  };
}
vi.mock('../../services/kyuubiApi.js', () => ({
  getServerStatusFromPlugin: stub('getServerStatusFromPlugin'),
  getLoadedPluginsFromPlugin: stub('getLoadedPluginsFromPlugin'),
  getWhitelistFromPlugin: stub('getWhitelistFromPlugin'),
  getBansFromPlugin: stub('getBansFromPlugin'),
  getPermissionGroupsFromPlugin: stub('getPermissionGroupsFromPlugin'),
  getPermissionUsersFromPlugin: stub('getPermissionUsersFromPlugin'),
  getPermissionUserFromPlugin: stub('getPermissionUserFromPlugin'),
  getSessionsFromPlugin: stub('getSessionsFromPlugin'),
  getPlayerLiveFromPlugin: stub('getPlayerLiveFromPlugin'),
  getPlayerLiveInventoryFromPlugin: stub('getPlayerLiveInventoryFromPlugin'),
}));

const { default: router } = await import('./pluginLive.js');

const app = express();
// The scoped mount (/api/servers/:id/server) sets req.serverId before the router.
app.use(
  '/api/servers/:serverId/server',
  (req, _res, next) => {
    (req as { serverId?: string }).serverId = req.params.serverId;
    next();
  },
  router,
);
app.use('/api/server', router);
const server = http.createServer(app);
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  granted.clear();
});

async function get(p: string) {
  const res = await fetch(base + p);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('plugin live routes', () => {
  it('guards each route with its permission', async () => {
    const routes: [string, string][] = [
      ['/api/server/plugin/server-status', 'server.view_status'],
      ['/api/server/plugin/plugins', 'server.view_status'],
      ['/api/server/plugin/access/whitelist', 'players.whitelist'],
      ['/api/server/plugin/access/bans', 'players.ban'],
      ['/api/server/plugin/permissions/groups', 'players.permissions'],
      ['/api/server/plugin/permissions/users', 'players.permissions'],
      ['/api/server/plugin/permissions/users/abc', 'players.permissions'],
      ['/api/server/plugin/sessions', 'players.view'],
      ['/api/server/plugin/players/Steve/live', 'players.view'],
      ['/api/server/plugin/players/Steve/live/inventory', 'players.view'],
    ];
    // The inventory route only passes a real inventory (with sections) through.
    answers.set('getPlayerLiveInventoryFromPlugin', {
      success: true,
      data: {
        uuid: 'u',
        name: 'Steve',
        sections: { hotbar: { capacity: 9, items: [] } },
        items: [],
        totalSlots: 9,
        usedSlots: 0,
      },
    });
    for (const [route, permission] of routes) {
      granted.clear();
      expect((await get(route)).status, route).toBe(403);
      granted.add(permission);
      expect((await get(route)).status, route).toBe(200);
    }
  });

  it('passes the server id and parameters to the plugin client', async () => {
    granted.add('players.view');
    granted.add('players.permissions');
    await get('/api/servers/srv-2/server/plugin/players/Steve/live');
    await get('/api/server/plugin/permissions/users/11111111-2222-3333-4444-555555555555');
    expect(calls).toEqual([
      { fn: 'getPlayerLiveFromPlugin', args: ['Steve', 'srv-2'] },
      {
        fn: 'getPermissionUserFromPlugin',
        args: ['11111111-2222-3333-4444-555555555555', undefined],
      },
    ]);
  });

  it('keeps meaningful refusals and maps the rest to 503', async () => {
    granted.add('players.view');
    granted.add('server.view_status');
    answers.set('getPlayerLiveFromPlugin', {
      success: false,
      error: 'HTTP 404',
      status: 404,
    });
    expect(await get('/api/server/plugin/players/Steve/live')).toEqual({
      status: 404,
      body: { success: false, error: 'HTTP 404' },
    });
    answers.set('getLoadedPluginsFromPlugin', { success: false, error: 'HTTP 501', status: 501 });
    expect((await get('/api/server/plugin/plugins')).status).toBe(501);
    answers.set('getServerStatusFromPlugin', {
      success: false,
      error: 'fetch failed',
    });
    expect((await get('/api/server/plugin/server-status')).status).toBe(503);
  });

  it('serves the live inventory in the saved-file shape', async () => {
    granted.add('players.view');
    answers.set('getPlayerLiveInventoryFromPlugin', {
      success: true,
      data: {
        uuid: 'u',
        name: 'Steve',
        sections: {
          hotbar: {
            capacity: 9,
            activeSlot: 1,
            items: [{ slot: 1, itemId: 'Weapon_Sword_Iron', amount: 1 }],
          },
        },
        items: [],
        totalSlots: 9,
        usedSlots: 1,
      },
    });
    const { status, body } = await get('/api/server/plugin/players/Steve/live/inventory');
    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(data.source).toBe('live');
    expect(data.activeHotbarSlot).toBe(1);
    expect(data.hotbar).toEqual([
      {
        slot: 1,
        itemId: 'Weapon_Sword_Iron',
        displayName: 'Iron Sword',
        amount: 1,
        durability: 0,
        maxDurability: 0,
      },
    ]);
    expect(data.storage).toEqual([]);
  });

  it('answers 501 for the empty placeholder of plugin 2.0.0, so the modal keeps the file', async () => {
    granted.add('players.view');
    answers.set('getPlayerLiveInventoryFromPlugin', {
      success: true,
      data: { uuid: 'u', name: 'Steve', items: [], totalSlots: 36, usedSlots: 0 },
    });
    const { status, body } = await get('/api/server/plugin/players/Steve/live/inventory');
    expect(status).toBe(501);
    expect(body.success).toBe(false);
  });
});
