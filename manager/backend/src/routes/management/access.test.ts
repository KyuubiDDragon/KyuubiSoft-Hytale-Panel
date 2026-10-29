/**
 * The access routes: every route checks its right (API keys only get what
 * their scopes and their owner's role both allow), giving out operator rights
 * also needs players.op, and the services' refusals come back with a status
 * and a code the pages can act on. Real routers and requirePermission; the
 * services, roles and authentication are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const h = vi.hoisted(() => ({
  perms: new Map<string, string[]>(),
  setUserPermissions: vi.fn(),
  removeUserPermissions: vi.fn(),
  saveGroup: vi.fn(),
  deleteGroup: vi.fn(),
  setWhitelistEnabled: vi.fn(),
  banPlayer: vi.fn(),
  unbanPlayer: vi.fn(),
  getWhitelist: vi.fn(),
  closeBanRecords: vi.fn(async () => 0),
}));

vi.mock('../../services/roles.js', () => ({
  getUserPermissions: async (user: string) => h.perms.get(user) ?? [],
  getUserPermissionsForServer: async (user: string) => h.perms.get(user) ?? [],
}));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (
    req: Request & { user?: string; apiKey?: unknown },
    _res: Response,
    next: NextFunction,
  ) => {
    req.user = String(req.headers['x-test-user'] ?? '');
    const scopes = req.headers['x-test-scopes'];
    if (typeof scopes === 'string') req.apiKey = { id: 'k1', scopes: JSON.parse(scopes) };
    next();
  },
}));
vi.mock('../../services/activityLog.js', () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock('../../services/demoData.js', () => ({ isDemoMode: () => false }));
vi.mock('../../services/accessWhitelist.js', () => ({
  getWhitelist: h.getWhitelist,
  setWhitelistEnabled: h.setWhitelistEnabled,
  addToWhitelist: vi.fn(),
  removeFromWhitelist: vi.fn(),
}));
vi.mock('../../services/accessBans.js', () => ({
  getBans: vi.fn(),
  banPlayer: h.banPlayer,
  unbanPlayer: h.unbanPlayer,
}));
vi.mock('../../services/punishments.js', () => ({ closeBanRecords: h.closeBanRecords }));
// The groups and players the operator check sees: Staff inherits from the
// operator group, Wild holds a wildcard, Mods (below the default group) and
// Loose are harmless; Olga is an operator.
const USERS = [
  { uuid: '0a1b2c3d-0000-4000-8000-00000000000a', name: 'Olga', groups: ['hytale:Admin'] },
  { uuid: '0a1b2c3d-0000-4000-8000-00000000000b', name: 'Bob', groups: ['Mods'] },
  { uuid: '0a1b2c3d-0000-4000-8000-00000000000e', name: 'Eve', groups: ['hytale:Adventurer'] },
];
const OPERATOR_VIEW = {
  operatorGroup: 'hytale:Admin',
  defaultGroup: 'hytale:Adventurer',
  groups: [
    { name: 'hytale:Admin', parent: 'hytale:ServerEditor', permissions: ['*'] },
    { name: 'hytale:ServerEditor', permissions: [] },
    { name: 'hytale:Adventurer', permissions: [] },
    { name: 'Staff', parent: 'hytale:Admin', permissions: [] },
    { name: 'Wild', permissions: ['hytale.command.*'] },
    { name: 'Mods', parent: 'hytale:Adventurer', permissions: ['kick.use'] },
    { name: 'Loose', permissions: ['ks.notes'] },
  ],
  users: USERS,
  usersComplete: true,
};
vi.mock('../../services/accessPermissions.js', async () => {
  const { needsOperatorRight, operatorChangeOf } = await import('../../services/accessOperator.js');
  type Change = Parameters<typeof operatorChangeOf>[0];
  return {
    getPermissions: vi.fn(),
    setUserPermissions: h.setUserPermissions,
    removeUserPermissions: h.removeUserPermissions,
    saveGroup: h.saveGroup,
    deleteGroup: h.deleteGroup,
    // Like the service: the player is looked up, the change decided on their state.
    operatorRightNeeded: async (_serverId: unknown, change: Change) => {
      if (change.kind === 'group' || change.kind === 'deleteGroup')
        return { needed: needsOperatorRight(OPERATOR_VIEW, change) };
      const user = USERS.find((u) => u.name.toLowerCase() === change.player.toLowerCase());
      if (!user) throw new Error('unknown player in the test');
      const current = { groups: user.groups, permissions: [] };
      return {
        needed: needsOperatorRight(OPERATOR_VIEW, operatorChangeOf(change, current)),
        uuid: user.uuid,
      };
    },
  };
});
vi.mock('../../services/accessMigration.js', () => ({
  getLastMigrationReport: () => null,
  installAccessMigrationHook: vi.fn(),
  migrateAccessFiles: vi.fn(),
  previewAccessMigration: vi.fn(),
}));

const express = (await import('express')).default;
const { default: accessRouter } = await import('./access.js');
const { AccessError } = await import('../../services/accessContext.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/management', accessRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/management`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const written = { via: 'plugin', verified: true, changed: true, view: { source: 'live' } };

beforeEach(() => {
  h.perms.clear();
  h.perms.set('root', ['*']);
  h.perms.set('mod', ['players.whitelist', 'players.ban']);
  h.perms.set('perms', ['players.permissions']);
  h.perms.set('permsop', ['players.permissions', 'players.op']);
  for (const fn of [
    h.setUserPermissions,
    h.removeUserPermissions,
    h.saveGroup,
    h.deleteGroup,
    h.setWhitelistEnabled,
    h.banPlayer,
    h.unbanPlayer,
    h.getWhitelist,
  ]) {
    fn.mockReset();
    fn.mockResolvedValue(written);
  }
  h.getWhitelist.mockResolvedValue({ enabled: true, source: 'live' });
  h.closeBanRecords.mockClear();
});

async function call(method: string, url: string, user: string, body?: unknown, scopes?: string[]) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-test-user': user,
  };
  if (scopes) headers['x-test-scopes'] = JSON.stringify(scopes);
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

describe('rights', () => {
  it('needs the right of the page', async () => {
    expect((await call('GET', '/whitelist', '')).status).toBe(401);
    expect((await call('GET', '/whitelist', 'perms')).status).toBe(403);
    expect((await call('GET', '/whitelist', 'mod')).status).toBe(200);
    expect((await call('DELETE', '/bans/Bob', 'mod')).status).toBe(403); // players.unban
    expect(h.unbanPlayer).not.toHaveBeenCalled();
  });

  it('limits an API key to its scopes', async () => {
    expect((await call('GET', '/whitelist', 'root', undefined, ['players.ban'])).status).toBe(403);
    expect((await call('GET', '/whitelist', 'root', undefined, ['players.whitelist'])).status).toBe(
      200,
    );
    // A scope the owner does not hold counts for nothing.
    expect(
      (await call('GET', '/whitelist', 'perms', undefined, ['players.whitelist'])).status,
    ).toBe(403);
  });

  it('asks for players.op for groups that carry operator rights through a parent or a wildcard', async () => {
    const status = async (method: string, url: string, body?: unknown) =>
      (await call(method, url, 'perms', body)).status;
    // A new group made to inherit from the operator group, or from a group that does.
    expect(
      await status('POST', '/permissions/groups', {
        name: 'Sneaky',
        permissions: ['a.b'],
        parent: 'hytale:Admin',
      }),
    ).toBe(403);
    expect(
      await status('POST', '/permissions/groups', {
        name: 'Sneaky',
        permissions: [],
        inherits: ['Staff'],
      }),
    ).toBe(403);
    // Changing a group that already carries them.
    expect(await status('POST', '/permissions/groups', { name: 'Wild', permissions: ['x'] })).toBe(
      403,
    );
    // Putting a player into such a group, or taking an operator out of theirs.
    expect(
      await status('POST', '/permissions/users', { player: 'Bob', groups: ['Mods', 'Staff'] }),
    ).toBe(403);
    expect(await status('POST', '/permissions/users', { player: 'Bob', groups: ['Wild'] })).toBe(
      403,
    );
    expect(await status('POST', '/permissions/users', { player: 'Olga', groups: [] })).toBe(403);
    expect(await status('DELETE', '/permissions/users/Olga')).toBe(403);
    expect(h.saveGroup).not.toHaveBeenCalled();
    expect(h.setUserPermissions).not.toHaveBeenCalled();
    expect(h.removeUserPermissions).not.toHaveBeenCalled();

    // Harmless changes, and an operator's own permissions with the groups left alone.
    expect(
      await status('POST', '/permissions/groups', {
        name: 'Mods',
        permissions: ['kick.use', 'mute.use'],
        parent: 'hytale:Adventurer',
      }),
    ).toBe(200);
    expect(
      await status('POST', '/permissions/users', { player: 'Olga', permissions: ['fly.use'] }),
    ).toBe(200);
    expect(await status('DELETE', '/permissions/users/Bob')).toBe(200);
  });

  it('asks for players.op before handing out operator rights', async () => {
    const admin = { player: 'Bob', groups: ['op'] };
    expect((await call('POST', '/permissions/users', 'perms', admin)).status).toBe(403);
    expect(
      (
        await call('POST', '/permissions/users', 'perms', {
          player: 'Bob',
          permissions: ['hytale.*'],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', '/permissions/groups', 'perms', {
          name: 'hytale:Admin',
          permissions: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('POST', '/permissions/groups', 'perms', { name: 'VIP', permissions: ['*'] }))
        .status,
    ).toBe(403);
    expect(h.setUserPermissions).not.toHaveBeenCalled();
    expect(h.saveGroup).not.toHaveBeenCalled();

    expect((await call('POST', '/permissions/users', 'permsop', admin)).status).toBe(200);
    expect(
      (await call('POST', '/permissions/users', 'perms', { player: 'Bob', groups: ['Mods'] }))
        .status,
    ).toBe(200);
    expect(
      (await call('POST', '/permissions/users', 'permsop', admin, ['players.permissions'])).status,
    ).toBe(403);
  });

  it('asks for players.op for every change to the server own rights', async () => {
    const status = async (user: string, method: string, url: string, body?: unknown) =>
      (await call(method, url, user, body)).status;
    // The node of /op add for a player, any change to the default group, a deny
    // over the namespace for an operator, deleting a group that carries such rights.
    const eveOp = { player: 'Eve', permissions: ['hytale.command.op.add'] };
    expect(await status('perms', 'POST', '/permissions/users', eveOp)).toBe(403);
    expect(
      await status('perms', 'POST', '/permissions/groups', {
        name: 'hytale:Adventurer',
        permissions: ['ks.pets.user.x'],
      }),
    ).toBe(403);
    expect(
      await status('perms', 'POST', '/permissions/users', {
        player: 'Olga',
        permissions: ['-hytale.*'],
      }),
    ).toBe(403);
    expect(await status('perms', 'DELETE', '/permissions/groups/Wild')).toBe(403);
    expect(await status('perms', 'DELETE', '/permissions/groups/Staff')).toBe(403);
    expect(h.setUserPermissions).not.toHaveBeenCalled();
    expect(h.saveGroup).not.toHaveBeenCalled();
    expect(h.deleteGroup).not.toHaveBeenCalled();

    // With players.op they go through; mod permissions and harmless groups never need it.
    expect(await status('permsop', 'POST', '/permissions/users', eveOp)).toBe(200);
    expect(await status('permsop', 'DELETE', '/permissions/groups/Wild')).toBe(200);
    expect(
      await status('perms', 'POST', '/permissions/users', {
        player: 'Eve',
        permissions: ['ks.pets.user.x'],
      }),
    ).toBe(200);
    expect(await status('perms', 'DELETE', '/permissions/groups/Loose')).toBe(200);
    // Members of Mods would lose the default group's rights with it.
    expect(await status('perms', 'DELETE', '/permissions/groups/Mods')).toBe(403);
  });

  it('changes the player the check was made for', async () => {
    await call('POST', '/permissions/users', 'perms', { player: 'eve', permissions: ['ks.a'] });
    expect(h.setUserPermissions).toHaveBeenCalledWith(undefined, {
      player: '0a1b2c3d-0000-4000-8000-00000000000e',
      groups: undefined,
      permissions: ['ks.a'],
    });
    await call('DELETE', '/permissions/users/Bob', 'perms');
    expect(h.removeUserPermissions).toHaveBeenCalledWith(
      undefined,
      '0a1b2c3d-0000-4000-8000-00000000000b',
    );
  });
});

describe('ban entries of the panel', () => {
  it('a permanent ban closes the temp-bans of the player, an unban all of their bans', async () => {
    const uuid = '0a1b2c3d-0000-4000-8000-00000000000b';
    h.banPlayer.mockResolvedValueOnce({ ...written, uuid, name: 'Bob' });
    expect((await call('POST', '/bans/add', 'mod', { player: 'bob' })).status).toBe(200);
    expect(h.closeBanRecords).toHaveBeenLastCalledWith(
      { serverId: undefined, names: ['bob', 'Bob'], uuid },
      ['tempban'],
      'mod',
    );
    h.perms.set('unbanner', ['players.unban']);
    h.unbanPlayer.mockResolvedValueOnce({ ...written, uuid, name: 'Bob' });
    expect((await call('DELETE', `/bans/${uuid}`, 'unbanner')).status).toBe(200);
    expect(h.closeBanRecords).toHaveBeenLastCalledWith(
      { serverId: undefined, names: [uuid, 'Bob'], uuid },
      ['ban', 'tempban'],
      'unbanner',
    );
  });

  it('answers the ban even when the entries cannot be closed, with a warning', async () => {
    h.closeBanRecords.mockRejectedValueOnce(new Error('database is locked'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await call('POST', '/bans/add', 'mod', { player: 'Bob' });
    errors.mockRestore();
    expect(r.status).toBe(200);
    expect(String((r.body as { warning?: string }).warning)).toMatch(/temporary bans/);
  });
});

describe('the parent and the name of a group', () => {
  const save = (user: string, body: unknown) =>
    call('POST', '/permissions/groups', user, body).then((r) => r.status);

  it('removing the parent with null is checked like any parent change', async () => {
    // Mods inherits from the default group: without its parent its members lose those rights.
    const remove = { name: 'Mods', permissions: ['kick.use'], parent: null };
    expect(await save('perms', remove)).toBe(403);
    expect(await save('perms', { ...remove, parent: '' })).toBe(403);
    // parent wins over inherits from older clients, as it does for the change.
    expect(await save('perms', { ...remove, inherits: ['hytale:Adventurer'] })).toBe(403);
    expect(await save('perms', { name: 'Mods', permissions: ['kick.use'], inherits: [] })).toBe(
      403,
    );
    expect(h.saveGroup).not.toHaveBeenCalled();

    expect(await save('permsop', remove)).toBe(200);
    expect(h.saveGroup).toHaveBeenLastCalledWith(undefined, {
      name: 'Mods',
      permissions: ['kick.use'],
      parent: null,
    });
    // A group that has no parent keeps having none: nothing to check.
    expect(await save('perms', { name: 'Loose', permissions: ['ks.notes'], parent: null })).toBe(
      200,
    );
  });

  it('refuses a name or parent the change would refuse, before the check', async () => {
    const long = `Staff${'x'.repeat(60)}`;
    for (const user of ['perms', 'permsop']) {
      expect((await call('DELETE', `/permissions/groups/${long}`, user)).status).toBe(400);
      expect(await save(user, { name: long, permissions: [] })).toBe(400);
      expect(await save(user, { name: 'Mods', permissions: [], parent: long })).toBe(400);
      expect(await save(user, { name: 'Mods', permissions: [], parent: 3 })).toBe(400);
    }
    const r = await call('DELETE', `/permissions/groups/${long}`, 'perms');
    expect(r.body).toMatchObject({ code: 'invalid_input' });
    expect(h.deleteGroup).not.toHaveBeenCalled();
    expect(h.saveGroup).not.toHaveBeenCalled();
  });
});

describe('answers', () => {
  it('answers 200 for a change read back and 202 for one only sent', async () => {
    const ok = await call('PUT', '/whitelist/enabled', 'mod', { enabled: true });
    expect(ok).toMatchObject({
      status: 200,
      body: { success: true, via: 'plugin', verified: true, source: 'live' },
    });
    h.setWhitelistEnabled.mockResolvedValueOnce({ ...written, via: 'stdin', verified: false });
    expect((await call('PUT', '/whitelist/enabled', 'mod', { enabled: false })).status).toBe(202);
  });

  it('checks the input before calling the service', async () => {
    expect((await call('PUT', '/whitelist/enabled', 'mod', { enabled: 'yes' })).status).toBe(400);
    expect((await call('POST', '/whitelist/add', 'mod', {})).status).toBe(400);
    expect(
      (
        await call('POST', '/permissions/groups', 'permsop', {
          name: 'A',
          permissions: [],
          inherits: ['B', 'C'],
        })
      ).status,
    ).toBe(400);
    expect(h.setWhitelistEnabled).not.toHaveBeenCalled();
  });

  it('passes a refusal on with its status and code', async () => {
    h.setWhitelistEnabled.mockRejectedValueOnce(new AccessError(409, 'Server is busy', 'busy'));
    expect(await call('PUT', '/whitelist/enabled', 'mod', { enabled: true })).toEqual({
      status: 409,
      body: { success: false, error: 'Server is busy', code: 'busy' },
    });
    h.getWhitelist.mockRejectedValueOnce(new Error('/srv/secret/path exploded'));
    const internal = await call('GET', '/whitelist', 'mod');
    expect(internal.status).toBe(500);
    expect(JSON.stringify(internal.body)).not.toContain('/srv/secret');
  });

  it('reads the parent of an older client from inherits', async () => {
    // A built-in group above the default one gives command rights: players.op.
    await call('POST', '/permissions/groups', 'permsop', {
      name: 'Mods',
      permissions: ['kick'],
      inherits: ['hytale:Builder'],
    });
    expect(h.saveGroup).toHaveBeenCalledWith(undefined, {
      name: 'Mods',
      permissions: ['kick'],
      parent: 'hytale:Builder',
    });
  });
});
