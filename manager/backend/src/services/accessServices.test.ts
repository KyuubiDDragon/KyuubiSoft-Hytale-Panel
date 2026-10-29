/**
 * Whitelist, bans and permissions end to end on real files in a temporary
 * server folder: with the server stopped the panel edits the files (link-safe,
 * atomically, old files migrated first); with it running every change goes
 * through the server's commands and is read back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'fs/promises';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  serverPath: '',
  running: false as boolean | 'error',
  lock: 'run' as 'run' | 'started' | 'busy' | 'docker',
  sendAccessCommand: vi.fn(),
  playerFiles: [] as { uuid: string; name: string }[],
  history: [] as { uuid?: string; name: string }[],
  plugin: {
    whitelist: null as unknown,
    bans: null as unknown,
    groups: null as unknown,
    users: null as unknown,
    user: null as unknown,
    sessions: null as unknown,
  },
}));

const live = (data: unknown) =>
  data ? { success: true, data } : { success: false, error: 'not installed', status: 0 };

vi.mock('./docker.js', () => ({
  getStatus: async () =>
    h.running === 'error'
      ? { status: 'error', running: false }
      : { status: h.running ? 'running' : 'exited', running: h.running },
  getContainerState: async () => {
    if (h.running === 'error') throw new Error('docker down');
    return { running: h.running };
  },
  sendAccessCommand: h.sendAccessCommand,
}));
vi.mock('./serverLifecycle.js', () => {
  class LifecycleBusyError extends Error {}
  return {
    LifecycleBusyError,
    // h.lock: how the lifecycle lock answers (the server came up meanwhile, busy, Docker failed).
    runWhileServerStopped: async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) => {
      if (h.lock === 'started') return { ran: false };
      if (h.lock === 'busy') throw new LifecycleBusyError('busy');
      if (h.lock === 'docker') throw new Error('connect ENOENT /var/run/docker.sock');
      return { ran: true, value: await fn() };
    },
    registerBeforeStartHook: vi.fn(),
    toConsoleText: (text: string) => text.replace(/\s+/g, ' ').trim(),
  };
});
vi.mock('./serverInstall.js', () => ({
  resolveInstallPaths: async () => ({ serverPath: h.serverPath }),
}));
vi.mock('./players.js', () => ({
  getAllPlayerFiles: async () => h.playerFiles,
  getPlayerHistory: async () => h.history,
}));
vi.mock('./kyuubiApi.js', () => ({
  getWhitelistFromPlugin: async () => live(h.plugin.whitelist),
  getBansFromPlugin: async () => live(h.plugin.bans),
  getPermissionGroupsFromPlugin: async () => live(h.plugin.groups),
  getPermissionUsersFromPlugin: async () => live(h.plugin.users),
  getPermissionUserFromPlugin: async () => live(h.plugin.user),
  getSessionsFromPlugin: async () => live(h.plugin.sessions),
}));
vi.mock('./activityLog.js', () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock('./demoData.js', () => ({ isDemoMode: () => false }));
// The registry: the default server is called "default".
vi.mock('./servers.js', () => ({ resolveServerId: async (id?: string) => id ?? 'default' }));

const whitelist = await import('./accessWhitelist.js');
const bans = await import('./accessBans.js');
const permissions = await import('./accessPermissions.js');
const migration = await import('./accessMigration.js');
const { clearPlayerDirectoryCache } = await import('./accessDirectory.js');
const { describeAccessError } = await import('./accessContext.js');

const BOB = '0a1b2c3d-0000-4000-8000-00000000000b';
const ANN = '0a1b2c3d-0000-4000-8000-00000000000a';

const file = (name: string) => path.join(h.serverPath, name);
const writeJson = (name: string, data: unknown) =>
  writeFile(file(name), JSON.stringify(data, null, 2));
const readJson = async (name: string) => JSON.parse(await readFile(file(name), 'utf-8'));

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return describeAccessError(error);
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  h.serverPath = await mkdtemp(path.join(os.tmpdir(), 'access-'));
  h.running = false;
  h.lock = 'run';
  h.sendAccessCommand.mockReset();
  h.playerFiles = [
    { uuid: BOB, name: 'Bob' },
    { uuid: ANN, name: 'Ann' },
  ];
  h.history = [];
  h.plugin = { whitelist: null, bans: null, groups: null, users: null, user: null, sessions: null };
  clearPlayerDirectoryCache();
});

afterEach(async () => {
  await rm(h.serverPath, { recursive: true, force: true });
});

describe('with the server stopped (files)', () => {
  it('reads the whitelist from config.json and permissions.json', async () => {
    await writeJson('config.json', { RequireJoinPermission: true, MaxPlayers: 10 });
    await writeJson('permissions.json', {
      users: {
        [BOB]: { permissions: ['hytale.server.join'] },
        [ANN]: { groups: ['hytale:Admin'] },
      },
    });
    const view = await whitelist.getWhitelist();
    expect(view).toMatchObject({
      enabled: true,
      source: 'file',
      serverRunning: false,
      entries: [{ uuid: BOB, name: 'Bob' }],
      list: ['Bob'],
      problems: [],
    });
    expect(view.openGroups).toContain('hytale:Admin');
    expect(view.legacy).toBeUndefined();
  });

  it('switches the whitelist in config.json and keeps the rest of the file', async () => {
    await writeJson('config.json', { MaxPlayers: 10, Seed: 1 });
    const on = await whitelist.setWhitelistEnabled(undefined, true);
    expect(on).toMatchObject({ via: 'file', verified: true, changed: true });
    expect(await readJson('config.json')).toEqual({
      MaxPlayers: 10,
      Seed: 1,
      RequireJoinPermission: true,
    });
    expect(await readJson('config.json.bak')).toEqual({ MaxPlayers: 10, Seed: 1 });
    expect((await whitelist.setWhitelistEnabled(undefined, true)).changed).toBe(false);
  });

  it('refuses to switch before the server wrote config.json', async () => {
    expect(await errorOf(whitelist.setWhitelistEnabled(undefined, true))).toMatchObject({
      status: 409,
      code: 'file_missing',
    });
  });

  it('adds and removes players by name or UUID; unknown names are refused', async () => {
    await writeJson('config.json', {});
    const added = await whitelist.addToWhitelist(undefined, 'bob');
    expect(added.view.entries).toEqual([{ uuid: BOB, name: 'Bob' }]);
    expect(await readJson('permissions.json')).toEqual({
      users: { [BOB]: { permissions: ['hytale.server.join'] } },
    });
    expect((await whitelist.addToWhitelist(undefined, BOB)).changed).toBe(false);
    expect(await errorOf(whitelist.addToWhitelist(undefined, 'Nobody'))).toMatchObject({
      status: 404,
      code: 'unknown_player',
    });
    await whitelist.removeFromWhitelist(undefined, 'Bob');
    expect(await readJson('permissions.json')).toEqual({});
  });

  it('bans and unbans in bans.json in the current form', async () => {
    await writeJson('bans.json', [
      {
        type: 'infinite',
        target: ANN,
        by: BOB,
        timestamp: Date.parse('2026-01-01T00:00:00Z'),
        reason: 'old',
      },
    ]);
    const banned = await bans.banPlayer(undefined, 'Bob', 'griefing');
    expect(banned.changed).toBe(true);
    const stored = await readJson('bans.json');
    expect(stored.Version).toBe(1);
    expect(
      stored.Bans.map((b: { Target: string; Reason: string }) => [b.Target, b.Reason]),
    ).toEqual([
      [ANN, 'old'],
      [BOB, 'griefing'],
    ]);
    expect(banned.view.bans.map((b) => [b.player, b.bannedBy, b.permanent])).toEqual([
      ['Ann', 'Bob', true],
      ['Bob', 'Console', true],
    ]);
    expect((await bans.banPlayer(undefined, 'Bob')).changed).toBe(false);
    const unbanned = await bans.unbanPlayer(undefined, BOB);
    expect(unbanned.view.bans.map((b) => b.player)).toEqual(['Ann']);
  });

  it('reads the ban file config.json names and reports one it cannot use', async () => {
    await writeJson('config.json', { BanStorage: { Type: 'Disk', Path: 'other-bans.json' } });
    await writeJson('other-bans.json', {
      Version: 1,
      Bans: [{ Target: BOB, By: ANN, Timestamp: '2026-10-01T00:00:00Z' }],
    });
    expect((await bans.getBans()).bans.map((b) => b.player)).toEqual(['Bob']);
    await writeJson('config.json', { BanStorage: { Type: 'Disk', Path: '../outside.json' } });
    expect((await bans.getBans()).unsupported).toMatch(/outside/);
    expect(await errorOf(bans.banPlayer(undefined, 'Bob'))).toMatchObject({ code: 'unsupported' });
  });

  it('sets groups and own permissions without touching other users', async () => {
    await writeJson('permissions.json', {
      users: { [ANN]: { groups: ['Mods'] }, [BOB]: { permissions: ['hytale.server.join'] } },
      groups: { Mods: { permissions: ['kick'] } },
    });
    const view = (
      await permissions.setUserPermissions(undefined, {
        player: 'Bob',
        groups: ['Mods'],
        permissions: ['hytale.server.join', 'fly'],
      })
    ).view;
    expect(await readJson('permissions.json')).toEqual({
      users: {
        [ANN]: { groups: ['Mods'] },
        [BOB]: { permissions: ['hytale.server.join', 'fly'], groups: ['Mods'] },
      },
      groups: { Mods: { permissions: ['kick'] } },
    });
    expect(view.users.find((u) => u.uuid === BOB)).toMatchObject({
      name: 'Bob',
      groups: ['Mods'],
      joinGrant: true,
      defaultGroup: false,
    });

    await permissions.removeUserPermissions(undefined, 'Bob');
    expect((await readJson('permissions.json')).users[BOB]).toEqual({
      permissions: ['hytale.server.join'],
    });
  });

  it('keeps the join permission when own permissions are set (it is the whitelist entry)', async () => {
    await writeJson('permissions.json', {
      users: {
        [BOB]: { permissions: ['hytale.server.join', 'old'] },
        [ANN]: { permissions: ['x'] },
      },
    });
    await permissions.setUserPermissions(undefined, { player: 'Bob', permissions: ['fly'] });
    await permissions.setUserPermissions(undefined, {
      player: 'Ann',
      permissions: ['hytale.server.join'],
    });
    expect((await readJson('permissions.json')).users).toEqual({
      [BOB]: { permissions: ['hytale.server.join', 'fly'] },
    });
  });

  it('refuses invalid permissions, groups and parent loops', async () => {
    await writeJson('permissions.json', {
      groups: { A: { parent: 'B', permissions: [] }, B: { permissions: [] } },
    });
    expect(
      await errorOf(
        permissions.setUserPermissions(undefined, { player: 'Bob', permissions: ['a b'] }),
      ),
    ).toMatchObject({ status: 400, code: 'invalid_input' });
    expect(
      await errorOf(permissions.saveGroup(undefined, { name: 'B', permissions: [], parent: 'A' })),
    ).toMatchObject({ status: 400 });
    expect(await errorOf(permissions.deleteGroup(undefined, 'hytale:Admin'))).toMatchObject({
      status: 400,
    });
  });

  it('saves and deletes groups in the object form', async () => {
    await writeJson('permissions.json', { groups: { Old: ['x'] } });
    await permissions.saveGroup(undefined, {
      name: 'Mods',
      permissions: ['kick'],
      parent: 'hytale:Builder',
    });
    expect((await readJson('permissions.json')).groups.Mods).toEqual({
      parent: 'hytale:Builder',
      permissions: ['kick'],
    });
    const view = (await permissions.deleteGroup(undefined, 'Mods')).view;
    expect(view.groups.map((g) => g.name)).not.toContain('Mods');
    expect(await readJson('permissions.json')).toEqual({ groups: { Old: ['x'] } });
  });

  it('will not rewrite a file that is not valid JSON', async () => {
    await writeFile(file('permissions.json'), '{ broken');
    expect(await errorOf(whitelist.addToWhitelist(undefined, 'Bob'))).toMatchObject({
      status: 409,
      code: 'file_broken',
    });
    expect(await readFile(file('permissions.json'), 'utf-8')).toBe('{ broken');
  });
});

describe('the lifecycle lock around file edits', () => {
  it('answers busy while the server is being started or stopped', async () => {
    await writeJson('config.json', {});
    h.lock = 'busy';
    expect(await errorOf(whitelist.setWhitelistEnabled(undefined, true))).toMatchObject({
      status: 409,
      code: 'busy',
    });
    expect((await readJson('config.json')).RequireJoinPermission).toBeUndefined();
  });

  it('turns a Docker failure under the lock into docker_unavailable', async () => {
    await writeJson('config.json', {});
    h.lock = 'docker';
    const error = await errorOf(whitelist.setWhitelistEnabled(undefined, true));
    expect(error).toMatchObject({ status: 503, code: 'docker_unavailable' });
    expect(error.error).not.toContain('docker.sock');
  });

  it('uses the command when the server came up meanwhile, and keeps its errors', async () => {
    h.lock = 'started';
    h.sendAccessCommand.mockResolvedValueOnce({ success: false, error: 'Container not running' });
    expect(await errorOf(whitelist.setWhitelistEnabled(undefined, true))).toMatchObject({
      status: 503,
      code: 'unreachable',
    });
    expect(h.sendAccessCommand).toHaveBeenCalledWith('/whitelist enable', undefined);
  });
});

describe('the ban file config.json names', () => {
  it.each([
    ['permissions.json', /separate/],
    ['config.json', /separate/],
    ['bans.txt', /separate/],
    ['../x.json', /outside/],
    ['sub/../../x.json', /outside/],
  ])('refuses %s', async (banPath, reason) => {
    await writeJson('config.json', { BanStorage: { Type: 'Disk', Path: banPath } });
    expect((await bans.getBans()).unsupported).toMatch(reason);
    expect(await errorOf(bans.banPlayer(undefined, 'Bob'))).toMatchObject({ code: 'unsupported' });
  });

  it('accepts a file name that only starts with two dots', async () => {
    await writeJson('config.json', { BanStorage: { Type: 'Disk', Path: '..bans.json' } });
    expect((await bans.getBans()).unsupported).toBeUndefined();
  });
});

describe('migration of files from before 0.7', () => {
  it('repairs name: keys and applies an old whitelist once, with backups', async () => {
    await writeJson('config.json', { MaxPlayers: 10 });
    await writeJson('permissions.json', {
      users: { 'name:Bob': { groups: ['Mods'] }, 'name:Ghost': { groups: ['x'] } },
    });
    await writeJson('whitelist.json', { enabled: true, list: ['Ann', 'Ghost', BOB] });

    const report = await migration.migrateAccessFiles(undefined, { serverStopped: true });
    expect(report.errors).toEqual([]);
    expect(report.removed).toEqual([{ key: 'name:Ghost', value: { groups: ['x'] } }]);
    expect(report.unresolved).toEqual(['Ghost']);
    expect(report.backups.length).toBeGreaterThanOrEqual(2);

    expect(await readJson('permissions.json')).toEqual({
      users: {
        [BOB]: { groups: ['Mods'], permissions: ['hytale.server.join'] },
        [ANN]: { permissions: ['hytale.server.join'] },
      },
    });
    expect((await readJson('config.json')).RequireJoinPermission).toBe(true);
    const names = await readdir(h.serverPath);
    expect(names).toContain('whitelist.json.migrated');
    expect(names).not.toContain('whitelist.json');
    expect(names.filter((n) => n.includes('.pre-panel-migration-')).length).toBe(
      report.backups.length,
    );

    // Idempotent: nothing left to do, no new copies.
    const again = await migration.migrateAccessFiles(undefined, { serverStopped: true });
    expect(again.changes).toEqual([]);
    expect(again.backups).toEqual([]);
    expect((await readdir(h.serverPath)).length).toBe(names.length);
  });

  it('applies a disabled old whitelist without turning the switch on', async () => {
    await writeJson('config.json', {});
    await writeJson('whitelist.json', { enabled: false, list: ['Ann'] });
    await migration.migrateAccessFiles(undefined, { serverStopped: true });
    expect((await readJson('config.json')).RequireJoinPermission).toBeUndefined();
    expect((await readJson('permissions.json')).users[ANN]).toEqual({
      permissions: ['hytale.server.join'],
    });
  });

  it('only replaces names in the old whitelist while the server runs', async () => {
    await writeJson('permissions.json', { users: { 'name:Bob': {} } });
    await writeJson('whitelist.json', { enabled: true, list: ['Ann'] });
    const report = await migration.migrateAccessFiles(undefined, { serverStopped: false });
    expect(await readJson('whitelist.json')).toEqual({ enabled: true, list: [ANN] });
    expect(await readJson('permissions.json')).toEqual({ users: { 'name:Bob': {} } });
    expect(report.pending.length).toBe(2);
  });

  it('runs before a change in the files and reports what needs a person', async () => {
    await writeJson('config.json', {});
    await writeJson('permissions.json', { users: { 'name:Bob': { groups: ['Mods'] } } });
    await whitelist.addToWhitelist(undefined, 'Ann');
    expect(Object.keys((await readJson('permissions.json')).users).sort()).toEqual(
      [ANN, BOB].sort(),
    );

    await writeFile(file('whitelist.json'), '[]');
    const preview = await migration.previewAccessMigration();
    expect(preview).toMatchObject({ needed: true, items: ['whitelist.json cannot be read'] });
    const report = await migration.migrateAccessFiles(undefined, { serverStopped: true });
    expect(report.errors[0]).toMatch(/cannot be read/);
  });

  it('shows the report of the start hook on the pages of the default server', async () => {
    await writeJson('config.json', {});
    await writeJson('whitelist.json', { enabled: true, list: ['Ann', 'Ghost'] });
    // The hook runs with the registry id; the pages ask without one (legacy routes).
    await migration.migrateAccessFiles('default', { serverStopped: true });
    expect((await migration.getLastMigrationReport(undefined))?.unresolved).toEqual(['Ghost']);
    expect((await migration.getLastMigrationReport('default'))?.unresolved).toEqual(['Ghost']);
    expect(await migration.getLastMigrationReport('other')).toBeNull();
    // A clean run clears it for both.
    await migration.migrateAccessFiles(undefined, { serverStopped: true });
    expect(await migration.getLastMigrationReport('default')).toBeNull();
  });
});

describe('what the operator check starts from', () => {
  it('resolves the player like the change and decides on the stored permissions', async () => {
    await writeJson('permissions.json', {
      users: {
        [BOB]: { permissions: ['hytale.command.op.add'] },
        [ANN]: { permissions: ['ks.pets.user.x'], groups: ['VIP'] },
      },
      groups: {
        VIP: { parent: 'hytale:Adventurer', permissions: ['ks.pets.user.x'] },
        Loose: { permissions: ['ks.notes'] },
      },
    });
    // Taking the node of /op add away from Bob, by name.
    expect(
      await permissions.operatorRightNeeded(undefined, { kind: 'removeUser', player: 'bob' }),
    ).toEqual({ needed: true, uuid: BOB });
    expect(
      await permissions.operatorRightNeeded(undefined, {
        kind: 'user',
        player: BOB,
        permissions: ['hytale.command.op.add', 'ks.more'],
      }),
    ).toEqual({ needed: false, uuid: BOB });
    expect(
      await permissions.operatorRightNeeded(undefined, { kind: 'removeUser', player: 'Ann' }),
    ).toEqual({ needed: false, uuid: ANN });
    // VIP's members would lose the default group's rights with it; Loose gives nothing of the server.
    expect(
      await permissions.operatorRightNeeded(undefined, { kind: 'deleteGroup', name: 'VIP' }),
    ).toEqual({ needed: true });
    expect(
      await permissions.operatorRightNeeded(undefined, { kind: 'deleteGroup', name: 'Loose' }),
    ).toEqual({ needed: false });
    expect(
      await errorOf(
        permissions.operatorRightNeeded(undefined, { kind: 'removeUser', player: 'Nobody' }),
      ),
    ).toMatchObject({ code: 'unknown_player' });
  });

  it('uses what the running server reports for the player', async () => {
    h.running = true;
    await writeJson('permissions.json', {});
    h.plugin.groups = { groups: [{ name: 'hytale:Admin', permissions: ['*'] }] };
    h.plugin.user = { uuid: BOB, groups: ['hytale:Adventurer'], permissions: ['-hytale.*'] };
    expect(
      await permissions.operatorRightNeeded(undefined, {
        kind: 'user',
        player: 'Bob',
        permissions: [],
      }),
    ).toEqual({ needed: true, uuid: BOB });
  });
});

describe('the ban the server has right now', () => {
  it('reads it with its time, and knows when a ban changed nothing', async () => {
    await writeJson('bans.json', {
      Version: 1,
      Bans: [{ Target: BOB, By: ANN, Timestamp: '2026-10-01T00:00:00Z' }],
    });
    expect(await bans.currentBan(undefined, 'Bob')).toEqual({
      target: BOB,
      bannedAt: '2026-10-01T00:00:00Z',
    });
    expect(await bans.currentBan(undefined, ANN)).toBeNull();
    expect(await bans.banPlayer(undefined, 'Bob', 'again')).toMatchObject({
      changed: false,
      uuid: BOB,
      name: 'Bob',
    });
  });

  it('over the console, tells an unchanged ban by the state before', async () => {
    h.running = true;
    await writeJson('bans.json', {
      Version: 1,
      Bans: [{ Target: BOB, By: ANN, Timestamp: '2026-10-01T00:00:00Z' }],
    });
    h.sendAccessCommand.mockResolvedValue({ success: true, via: 'stdin', message: 'sent' });
    expect(await bans.banPlayer(undefined, 'Bob')).toMatchObject({
      via: 'stdin',
      changed: false,
      uuid: BOB,
    });
    expect((await bans.currentBan(undefined, BOB))?.bannedAt).toBe('2026-10-01T00:00:00Z');
    expect(await errorOf(bans.currentBan(undefined, 'Nobody'))).toMatchObject({
      code: 'unknown_player',
    });
  });

  it('cannot tell without Docker', async () => {
    h.running = 'error';
    expect(await errorOf(bans.currentBan(undefined, BOB))).toMatchObject({
      code: 'docker_unavailable',
    });
  });
});

describe('with the server running (commands)', () => {
  beforeEach(() => {
    h.running = true;
  });

  const done = (messageIds: string[] = [], lines: string[] = []) => ({
    success: true,
    via: 'plugin',
    status: 'DONE',
    lines,
    messageIds,
  });

  it('reads the whitelist live from the plugin', async () => {
    await writeJson('permissions.json', {});
    h.plugin.whitelist = {
      enabled: true,
      count: 1,
      entries: [{ uuid: BOB.toUpperCase(), online: true }],
    };
    h.plugin.groups = {
      groups: [{ name: 'VIP', permissions: ['hytale.server.*'], effectivePermissions: [] }],
      virtualGroups: {},
    };
    const view = await whitelist.getWhitelist();
    expect(view).toMatchObject({
      source: 'live',
      enabled: true,
      entries: [{ uuid: BOB, name: 'Bob', online: true }],
      openGroups: ['VIP'],
    });
  });

  it('grants the join permission by UUID and reads it back', async () => {
    h.plugin.whitelist = { enabled: true, count: 0, entries: [] };
    h.sendAccessCommand.mockImplementation(async (command: string) => {
      h.plugin.whitelist = { enabled: true, count: 1, entries: [{ uuid: BOB, online: false }] };
      return done(['server.commands.perm.permAddedToUser'], [command]);
    });
    const outcome = await whitelist.addToWhitelist(undefined, 'Bob');
    expect(h.sendAccessCommand).toHaveBeenCalledWith(
      `/perm user add ${BOB} hytale.server.join`,
      undefined,
    );
    expect(outcome).toMatchObject({ via: 'plugin', verified: true, changed: true });

    h.sendAccessCommand.mockClear();
    expect((await whitelist.addToWhitelist(undefined, BOB)).changed).toBe(false);
    expect(h.sendAccessCommand).not.toHaveBeenCalled();
  });

  it('switches the whitelist with /whitelist and verifies it', async () => {
    h.plugin.whitelist = { enabled: false, count: 0, entries: [] };
    h.sendAccessCommand.mockImplementation(async () => {
      h.plugin.whitelist = { enabled: true, count: 0, entries: [] };
      return done(['server.modules.whitelist.enabled']);
    });
    const outcome = await whitelist.setWhitelistEnabled(undefined, true);
    expect(h.sendAccessCommand).toHaveBeenCalledWith('/whitelist enable', undefined);
    expect(outcome).toMatchObject({ via: 'plugin', verified: true, changed: true });
  });

  it('never sends a name the server could take for another player', async () => {
    const error = await errorOf(bans.banPlayer(undefined, 'Bo'));
    expect(error).toMatchObject({ status: 409, code: 'ambiguous_player' });
    expect(error.error).toMatch(/Bob/);
    expect(h.sendAccessCommand).not.toHaveBeenCalled();
  });

  it('bans by UUID and reports a refusal of the server', async () => {
    h.plugin.bans = { count: 0, activeCount: 0, entries: [] };
    h.sendAccessCommand.mockResolvedValueOnce({
      success: false,
      via: 'plugin',
      status: 'FAILED',
      error: 'Command failed',
      lines: ['This server is not signed in'],
      messageIds: ['server.commands.parsing.argtype.playerUuidLookup.noAuth'],
    });
    const error = await errorOf(bans.banPlayer(undefined, 'Ann', 'x'));
    expect(h.sendAccessCommand).toHaveBeenCalledWith(`/ban ${ANN} x`, undefined);
    expect(error).toMatchObject({ status: 400, code: 'rejected' });
    expect(error.error).toMatch(/not signed in/);
  });

  it('keeps the default group when another group is added', async () => {
    await writeJson('permissions.json', {});
    h.plugin.groups = {
      groups: [{ name: 'Mods', permissions: ['kick'], effectivePermissions: ['kick'] }],
    };
    h.plugin.user = {
      uuid: BOB,
      online: false,
      groups: ['hytale:Adventurer'],
      permissions: [],
      operator: false,
    };
    h.sendAccessCommand.mockResolvedValue(done());
    await permissions.setUserPermissions(undefined, {
      player: 'Bob',
      groups: ['hytale:Adventurer', 'Mods'],
    });
    expect(h.sendAccessCommand.mock.calls.map((c) => c[0])).toEqual([
      `/perm user group add ${BOB} hytale:Adventurer`,
      `/perm user group add ${BOB} Mods`,
    ]);
  });

  it('refuses a parent change and a group the running server would drop', async () => {
    await writeJson('permissions.json', { groups: { Mods: { permissions: ['kick'] } } });
    h.plugin.groups = {
      groups: [{ name: 'Mods', permissions: ['kick'], effectivePermissions: ['kick'] }],
    };
    expect(
      await errorOf(
        permissions.saveGroup(undefined, {
          name: 'Mods',
          permissions: ['kick'],
          parent: 'hytale:Builder',
        }),
      ),
    ).toMatchObject({ code: 'needs_stopped_server' });
    expect(
      await errorOf(permissions.saveGroup(undefined, { name: 'Mods', permissions: [] })),
    ).toMatchObject({ code: 'needs_stopped_server' });
    expect(h.sendAccessCommand).not.toHaveBeenCalled();
  });

  it('falls back to the files and the console without the plugin', async () => {
    await writeJson('permissions.json', {});
    h.sendAccessCommand.mockImplementation(async () => {
      await writeJson('permissions.json', {
        users: { [ANN]: { permissions: ['hytale.server.join'] } },
      });
      return { success: true, via: 'stdin', message: 'Command executed' };
    });
    const outcome = await whitelist.addToWhitelist(undefined, ANN);
    expect(outcome).toMatchObject({ via: 'stdin', verified: true });
    expect(outcome.view).toMatchObject({ source: 'file', entries: [{ uuid: ANN, name: 'Ann' }] });
  });

  it('changes nothing when Docker cannot tell whether the server runs', async () => {
    h.running = 'error';
    expect(await errorOf(whitelist.setWhitelistEnabled(undefined, true))).toMatchObject({
      status: 503,
      code: 'docker_unavailable',
    });
    expect(h.sendAccessCommand).not.toHaveBeenCalled();
  });
});
