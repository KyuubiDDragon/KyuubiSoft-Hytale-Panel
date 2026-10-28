/**
 * The access files of a Hytale 0.7 server as the server reads them, and the
 * edits the panel makes on them (everything it does not change stays).
 */
import { describe, it, expect } from 'vitest';
import {
  CONSOLE_UUID,
  NO_REASON,
  banStorageFile,
  canonicalUuid,
  effectiveGroupPermissions,
  groupDecides,
  isGroupNameInput,
  isPermissionNodeInput,
  isValidGroupName,
  isValidPermissionNode,
  nodesDecide,
  normalizeLegacyWhitelist,
  readBans,
  readLegacyWhitelist,
  readPermissions,
  readRequireJoinPermission,
  repairPermissions,
  withBan,
  withGroup,
  withoutBan,
  withoutGroup,
  withRequireJoinPermission,
  withUserAccess,
} from './accessFormats.js';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';

describe('canonicalUuid', () => {
  it('reads the canonical form in lower case', () => {
    expect(canonicalUuid(A.toUpperCase())).toBe(A);
  });

  it('pads short groups like the server does', () => {
    expect(canonicalUuid('1-2-3-4-5')).toBe('00000001-0002-0003-0004-000000000005');
    expect(canonicalUuid('+1-2-3-4-5')).toBe('00000001-0002-0003-0004-000000000005');
  });

  it('cuts the high digits of a group longer than usual', () => {
    expect(canonicalUuid('123456789-1-1-1-1')).toBe('23456789-0001-0001-0001-000000000001');
  });

  it('refuses what the server cannot read', () => {
    for (const value of ['name:Bob', '1-2-3-4', '1-2-3-4-5-6', '1--3-4-5', 'g-2-3-4-5', 7, null]) {
      expect(canonicalUuid(value)).toBeNull();
    }
    expect(canonicalUuid(`${'0'.repeat(30)}-1-2-3-4`)).toBeNull(); // longer than 36 characters
  });
});

describe('names and nodes', () => {
  it('reads group names and nodes by the server rules, without a length limit', () => {
    expect(isValidGroupName('hytale:Admin')).toBe(true);
    expect(isValidGroupName('_x')).toBe(false);
    expect(isValidGroupName('a'.repeat(100))).toBe(true);
    expect(isValidPermissionNode('hytale.server.join')).toBe(true);
    expect(isValidPermissionNode('-hytale.*')).toBe(true);
    expect(isValidPermissionNode('*')).toBe(false);
    expect(isValidPermissionNode('a b')).toBe(false);
  });

  it('limits what an admin can type', () => {
    expect(isGroupNameInput('a'.repeat(64))).toBe(true);
    expect(isGroupNameInput('a'.repeat(65))).toBe(false);
    expect(isPermissionNodeInput('a'.repeat(128))).toBe(true);
    expect(isPermissionNodeInput('a'.repeat(129))).toBe(false);
  });
});

describe('readPermissions', () => {
  it('reads users, groups and the built-in groups', () => {
    const data = readPermissions({
      users: { [A.toUpperCase()]: { permissions: ['hytale.server.join'], groups: ['op'] } },
      groups: { Mods: { parent: 'hytale:Builder', permissions: ['kick'] }, Old: ['a.b'] },
    });
    expect(data.problems).toEqual([]);
    expect(data.users).toEqual([
      { uuid: A, permissions: ['hytale.server.join'], groups: ['hytale:Admin'] },
    ]);
    const byName = Object.fromEntries(data.groups.map((g) => [g.name, g]));
    expect(byName.Mods).toMatchObject({
      parent: 'hytale:Builder',
      permissions: ['kick'],
      builtin: false,
    });
    expect(byName.Old).toMatchObject({ parent: null, permissions: ['a.b'] });
    expect(byName['hytale:Admin']).toMatchObject({
      parent: 'hytale:ServerEditor',
      permissions: ['*'],
      builtin: true,
    });
  });

  it('tells a missing group list (default group) from an empty one (no group)', () => {
    const data = readPermissions({ users: { [A]: { permissions: [] }, [B]: { groups: [] } } });
    expect(data.users.find((u) => u.uuid === A)?.groups).toBeNull();
    expect(data.users.find((u) => u.uuid === B)?.groups).toEqual([]);
  });

  it('merges two keys for the same UUID like the server', () => {
    const data = readPermissions({
      users: {
        [A]: { permissions: ['a'] },
        [A.toUpperCase()]: { permissions: ['b'], groups: ['x'] },
      },
    });
    expect(data.users).toEqual([{ uuid: A, permissions: ['a', 'b'], groups: ['x'] }]);
  });

  it('marks what makes the server refuse the file as fatal', () => {
    const data = readPermissions({
      users: { 'name:Bob': { groups: ['x'] }, [A]: 'admin', [B]: { permissions: 'a' } },
    });
    expect(data.problems.filter((p) => p.fatal).map((p) => p.where)).toEqual([
      'users.name:Bob',
      `users.${A}`,
      `users.${B}.permissions`,
    ]);
    expect(readPermissions([]).problems[0]).toMatchObject({ fatal: true });
  });

  it('skips invalid nodes and group names without failing the file', () => {
    const data = readPermissions({
      users: { [A]: { permissions: ['ok', 'not ok'] } },
      groups: { _bad: ['a'] },
    });
    expect(data.problems.every((p) => !p.fatal)).toBe(true);
    expect(data.users[0].permissions).toEqual(['ok']);
  });

  it('treats no file as empty', () => {
    expect(readPermissions(null)).toMatchObject({ users: [], problems: [] });
  });
});

describe('nodesDecide (as the server checks one set)', () => {
  const join = 'hytale.server.join';

  it('grants exact nodes, wildcards and the root wildcard', () => {
    expect(nodesDecide([join], join)).toBe(true);
    expect(nodesDecide(['hytale.*'], join)).toBe(true);
    expect(nodesDecide(['hytale.server.join.*'], join)).toBe(true);
    expect(nodesDecide(['*'], join)).toBe(true);
  });

  it('lets a deny win over a grant in the same set', () => {
    expect(nodesDecide([join, '-*'], join)).toBe(false);
    expect(nodesDecide(['hytale.server.*', '-hytale.*'], join)).toBe(false);
    expect(nodesDecide(['*', `-${join}`], join)).toBe(false);
  });

  it('does not decide on an empty or unrelated set', () => {
    expect(nodesDecide([], join)).toBeUndefined();
    expect(nodesDecide(undefined, join)).toBeUndefined();
    expect(nodesDecide(['other.node'], join)).toBeUndefined();
  });
});

describe('groupDecides (layer by layer)', () => {
  const join = 'hytale.server.join';

  it('lets the child decide before its parent', () => {
    const groups = [
      { name: 'child', parent: 'parent', permissions: ['hytale.*'] },
      { name: 'parent', parent: null, permissions: [`-${join}`] },
    ];
    expect(groupDecides(groups, 'child', join)).toBe(true);
    expect(groupDecides(groups, 'parent', join)).toBe(false);
  });

  it('follows the parents and the virtual nodes', () => {
    const groups = [
      { name: 'a', parent: 'b', permissions: [] },
      { name: 'b', parent: null, permissions: [] },
    ];
    expect(groupDecides(groups, 'a', join)).toBeUndefined();
    expect(groupDecides(groups, 'a', join, { b: [join] })).toBe(true);
  });

  it('stops on a parent loop', () => {
    const groups = [
      { name: 'a', parent: 'b', permissions: [] },
      { name: 'b', parent: 'a', permissions: [] },
    ];
    expect(groupDecides(groups, 'a', join)).toBeUndefined();
  });

  it('agrees with the built-in admin group of a file', () => {
    const { groups } = readPermissions({});
    expect(groupDecides(groups, 'hytale:Admin', join)).toBe(true);
    expect(groupDecides(groups, 'hytale:Adventurer', join)).toBeUndefined();
  });
});

describe('effectiveGroupPermissions', () => {
  it('lets the most specific group decide a node', () => {
    const groups = [
      { name: 'child', parent: 'parent', permissions: ['-a'], builtin: false },
      { name: 'parent', parent: null, permissions: ['a', 'b'], builtin: false },
    ];
    expect(effectiveGroupPermissions(groups, 'child')).toEqual(['-a', 'b']);
  });
});

describe('repairPermissions', () => {
  it('moves name: keys to the known UUID and removes the rest', () => {
    const raw = {
      users: {
        'name:Bob': { groups: ['Mods'], permissions: ['hytale.server.join', 3] },
        'name:Nobody': { groups: ['x'] },
        [A]: { permissions: ['kept'] },
      },
      groups: { Mods: { permissions: ['kick'] } },
      Other: { untouched: true },
    };
    const repair = repairPermissions(raw, (name) =>
      name === 'Bob' ? B.toUpperCase() : undefined,
    )!;
    expect(repair.data.users).toEqual({
      [A]: { permissions: ['kept'] },
      // The server reads a number as text; what it reads stays as it is.
      [B]: { groups: ['Mods'], permissions: ['hytale.server.join', 3] },
    });
    expect(repair.removed).toEqual([{ key: 'name:Nobody', value: { groups: ['x'] } }]);
    expect(repair.data.Other).toEqual({ untouched: true });
    expect(readPermissions(repair.data).problems.filter((p) => p.fatal)).toEqual([]);
    // Idempotent: a repaired file needs nothing more.
    expect(repairPermissions(repair.data, () => undefined)).toBeNull();
  });

  it('merges a moved entry into an existing one of the same UUID', () => {
    const raw = {
      users: { 'name:Bob': { groups: ['x'] }, [B]: { groups: ['y'], permissions: ['p'] } },
    };
    const repair = repairPermissions(raw, () => B)!;
    expect(repair.data.users).toEqual({ [B]: { groups: ['y', 'x'], permissions: ['p'] } });
  });

  it('keeps lenient UUID keys the server reads', () => {
    expect(
      repairPermissions({ users: { '1-2-3-4-5': { permissions: ['a'] } } }, () => undefined),
    ).toBeNull();
  });

  it('removes values of the wrong type and leaves a non-object root to a person', () => {
    const repair = repairPermissions({ users: [], groups: 'x' }, () => undefined)!;
    expect(repair.data).toEqual({});
    expect(repairPermissions('broken', () => undefined)).toBeNull();
  });

  it('does not mutate its input', () => {
    const raw = { users: { 'name:Bob': { groups: ['x'] } } };
    const copy = JSON.parse(JSON.stringify(raw));
    repairPermissions(raw, () => A);
    expect(raw).toEqual(copy);
  });
});

describe('withUserAccess', () => {
  it('changes one user and keeps everything else', () => {
    const raw = {
      users: { [A.toUpperCase()]: { permissions: ['a'], extra: 1 } },
      groups: { g: ['x'] },
      Other: 1,
    };
    const next = withUserAccess(raw, A, {
      groups: ['op', 'Mods'],
      addPermissions: ['b'],
      removePermissions: ['a'],
    });
    expect(next).toEqual({
      users: {
        [A.toUpperCase()]: { permissions: ['b'], extra: 1, groups: ['hytale:Admin', 'Mods'] },
      },
      groups: { g: ['x'] },
      Other: 1,
    });
    expect(raw.users[A.toUpperCase()].permissions).toEqual(['a']);
  });

  it('drops the group list for the default group and an empty user', () => {
    const raw = { users: { [A]: { groups: ['x'], permissions: ['p'] } } };
    expect(withUserAccess(raw, A, { groups: [] })).toEqual({
      users: { [A]: { permissions: ['p'] } },
    });
    expect(withUserAccess(raw, A, { groups: null, removePermissions: ['p'] })).toEqual({});
  });
});

describe('withGroup / withoutGroup', () => {
  it('writes the object form and replaces an alias key', () => {
    const raw = {
      groups: { op: ['old'], Mods: { parent: 'hytale:Builder', permissions: ['a'], note: 'x' } },
    };
    expect(withGroup(raw, 'Mods', { permissions: ['b'] }).groups).toMatchObject({
      Mods: { parent: 'hytale:Builder', permissions: ['b'], note: 'x' },
    });
    expect(withGroup(raw, 'Mods', { permissions: ['b'], parent: null }).groups).toMatchObject({
      Mods: { permissions: ['b'], note: 'x' },
    });
    const admin = withGroup(raw, 'hytale:Admin', { permissions: ['*', 'extra'], parent: 'Mods' })
      .groups as Record<string, unknown>;
    expect(admin.op).toBeUndefined();
    expect(admin['hytale:Admin']).toEqual({
      parent: 'hytale:ServerEditor',
      permissions: ['extra'],
    });
  });

  it('deletes a group under any of its keys', () => {
    expect(withoutGroup({ groups: { op: ['a'] }, users: {} }, 'hytale:Admin')).toEqual({
      users: {},
    });
    expect(withoutGroup({ groups: { a: [], b: [] } }, 'a')).toEqual({ groups: { b: [] } });
  });
});

describe('readBans', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');

  it('reads the current form', () => {
    const data = readBans(
      {
        Version: 1,
        Bans: [
          { Target: A, By: CONSOLE_UUID, Timestamp: '2026-10-01T00:00:00Z', Reason: 'grief' },
          {
            Target: B,
            By: A,
            Timestamp: '2026-10-01T00:00:00Z',
            ExpiresOn: '2026-10-02T00:00:00+02:00',
            Reason: NO_REASON,
          },
        ],
      },
      now,
    );
    expect(data.format).toBe('current');
    expect(data.problems).toEqual([]);
    expect(data.bans[0]).toMatchObject({
      target: A,
      by: CONSOLE_UUID,
      reason: 'grief',
      inEffect: true,
      readable: true,
    });
    expect(data.bans[1]).toMatchObject({ target: B, inEffect: false });
  });

  it('reads the form from before 0.7', () => {
    const data = readBans(
      [
        {
          type: 'infinite',
          target: A,
          by: B,
          timestamp: Date.parse('2026-01-01T00:00:00Z'),
          reason: 'x',
        },
      ],
      now,
    );
    expect(data.format).toBe('legacy');
    expect(data.bans[0]).toMatchObject({
      target: A,
      by: B,
      timestamp: '2026-01-01T00:00:00.000Z',
      reason: 'x',
      inEffect: true,
    });
  });

  it('keeps unreadable entries as bans in effect', () => {
    const data = readBans({
      Version: 1,
      Bans: [
        { Target: A, By: B, Timestamp: '2026-10-01' },
        { Target: B, By: A, Timestamp: '2026-10-01T00:00:00Z', Metadata: 'x' },
        { type: 'infinite', target: A, by: B, timestamp: 1, reason: 5 },
      ],
    });
    expect(data.bans.map((b) => [b.target, b.readable, b.inEffect])).toEqual([
      [A, false, true],
      [B, false, true],
      [A, false, true],
    ]);
    expect(data.problems).toHaveLength(3);
  });

  it('flags a file the server cannot read', () => {
    expect(readBans({ Version: 2, Bans: [] }).problems[0]).toMatchObject({
      fatal: true,
      where: 'Version',
    });
    expect(readBans({ Version: 1 }).problems[0]).toMatchObject({ fatal: true, where: 'Bans' });
    expect(readBans(null)).toEqual({ format: 'none', bans: [], problems: [] });
  });
});

describe('withBan / withoutBan', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');

  it('adds a ban in the current form and converts older entries', () => {
    const legacy = [{ type: 'infinite', target: B, by: A, timestamp: 0, reason: 'old' }];
    const { data, added } = withBan(legacy, { target: A.toUpperCase(), reason: '  ' }, now);
    expect(added).toBe(true);
    expect(data).toEqual({
      Version: 1,
      Bans: [
        { Target: B, By: A, Timestamp: '1970-01-01T00:00:00.000Z', Reason: 'old' },
        { Target: A, By: CONSOLE_UUID, Timestamp: '2026-10-28T12:00:00.000Z', Reason: NO_REASON },
      ],
    });
  });

  it('refuses a second ban in effect and replaces an expired one', () => {
    const active = { Version: 1, Bans: [{ Target: A, By: B, Timestamp: '2026-10-01T00:00:00Z' }] };
    expect(withBan(active, { target: A }, now).added).toBe(false);
    const expired = {
      Version: 1,
      Bans: [
        { Target: A, By: B, Timestamp: '2026-10-01T00:00:00Z', ExpiresOn: '2026-10-02T00:00:00Z' },
      ],
    };
    const next = withBan(expired, { target: A, reason: 'again' }, now);
    expect(next.added).toBe(true);
    expect((next.data.Bans as unknown[]).length).toBe(1);
  });

  it('removes every entry for the target, readable or not', () => {
    const raw = {
      Version: 1,
      Extra: 'kept',
      Bans: [
        { Target: A, By: B, Timestamp: 'bad' },
        { Target: B, By: A, Timestamp: '2026-10-01T00:00:00Z' },
      ],
    };
    const { data, removed } = withoutBan(raw, A);
    expect(removed).toBe(true);
    expect(data).toEqual({
      Version: 1,
      Extra: 'kept',
      Bans: [{ Target: B, By: A, Timestamp: '2026-10-01T00:00:00Z' }],
    });
    expect(withoutBan(data, A).removed).toBe(false);
  });

  it('will not rewrite a file it cannot read', () => {
    expect(() => withBan({ Version: 9, Bans: [] }, { target: A })).toThrow(/cannot be changed/);
  });
});

describe('whitelist.json from before 0.7', () => {
  it('reads it as the server does', () => {
    expect(readLegacyWhitelist({ list: ['Bob'] })).toEqual({
      enabled: true,
      entries: [{ value: 'Bob', uuid: null }],
    });
    expect(readLegacyWhitelist({ enabled: false, list: [A.toUpperCase(), 3] })).toEqual({
      enabled: false,
      entries: [{ value: A.toUpperCase(), uuid: A }],
    });
    expect(readLegacyWhitelist({ list: 'Bob' })).toBeNull();
    expect(readLegacyWhitelist([])).toBeNull();
  });

  it('replaces known names by UUIDs and keeps the rest', () => {
    const result = normalizeLegacyWhitelist(
      { enabled: true, list: ['Bob', 'Ann', A], note: 1 },
      (n) => (n === 'Bob' ? B : undefined),
    )!;
    expect(result.data).toEqual({ enabled: true, list: [B, 'Ann', A], note: 1 });
    expect(result.resolved).toEqual([{ name: 'Bob', uuid: B }]);
    expect(result.unresolved).toEqual(['Ann']);
    expect(normalizeLegacyWhitelist(result.data, () => undefined)).toBeNull();
  });
});

describe('config.json', () => {
  it('reads and sets RequireJoinPermission', () => {
    expect(readRequireJoinPermission({ RequireJoinPermission: true })).toBe(true);
    expect(readRequireJoinPermission({})).toBe(false);
    expect(withRequireJoinPermission({ MaxPlayers: 5 }, true)).toEqual({
      MaxPlayers: 5,
      RequireJoinPermission: true,
    });
  });

  it('finds the ban file', () => {
    expect(banStorageFile({})).toEqual({ file: 'bans.json' });
    expect(banStorageFile({ BanStorage: { Type: 'Disk', Path: 'data/bans.json' } })).toEqual({
      file: 'data/bans.json',
    });
    expect(banStorageFile({ BanStorage: { Type: 'Remote' } })).toHaveProperty('unsupported');
    expect(banStorageFile({ BanStorage: { Path: '/srv/bans.json' } })).toHaveProperty(
      'unsupported',
    );
    expect(banStorageFile({ BanStorage: { Path: '' } })).toHaveProperty('unsupported');
    expect(banStorageFile({ BanStorage: 'x' })).toHaveProperty('unsupported');
  });
});
