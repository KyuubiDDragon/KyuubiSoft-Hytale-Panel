/**
 * Which access changes count as operator changes (and then also need
 * players.op): anything that can give out or take away the server's own
 * rights, directly or through a group. Mod permissions stay free.
 */
import { describe, it, expect } from 'vitest';
import {
  isOperatorNode,
  needsOperatorRight,
  operatorChangeOf,
  type OperatorView,
  type UserAccessState,
} from './accessOperator.js';

const VIEW: OperatorView = {
  operatorGroup: 'hytale:Admin',
  defaultGroup: 'hytale:Adventurer',
  groups: [
    { name: 'hytale:None', parent: null, permissions: [] },
    { name: 'hytale:Adventurer', parent: 'hytale:None', permissions: [] },
    { name: 'hytale:Builder', parent: 'hytale:Adventurer', permissions: [] },
    { name: 'hytale:WorldEditor', parent: 'hytale:Builder', permissions: [] },
    { name: 'hytale:ServerEditor', parent: 'hytale:WorldEditor', permissions: [] },
    { name: 'hytale:Admin', parent: 'hytale:ServerEditor', permissions: ['*'] },
    { name: 'Staff', parent: 'hytale:Admin', permissions: [] },
    { name: 'Wild', permissions: ['hytale.command.*'] },
    { name: 'Sneaky', permissions: ['hytale.command.op.add'] },
    { name: 'Denied', permissions: ['-hytale.*'] },
    { name: 'Mods', permissions: ['kick.use'] },
    { name: 'VIP', parent: 'hytale:Adventurer', permissions: ['ks.pets.user.x'] },
    { name: 'Base', permissions: ['ks.base'] },
    { name: 'Moderator', parent: 'Base', permissions: ['hytale.command.kick'] },
  ],
  // Nobody names a group that does not exist yet (see the cases below).
  users: [{ groups: ['hytale:Adventurer'] }, { groups: ['VIP', 'Mods'] }],
  usersComplete: true,
};

const PLAYER: UserAccessState = { groups: ['hytale:Adventurer'], permissions: [] };
const OPERATOR: UserAccessState = { groups: ['hytale:Admin'], permissions: [] };
const WHITELISTED: UserAccessState = {
  groups: ['VIP'],
  permissions: ['hytale.server.join', 'ks.pets.user.x'],
};

const user = (current: UserAccessState, edit: { groups?: unknown; permissions?: unknown }) =>
  needsOperatorRight(VIEW, { kind: 'user', current, ...edit });
const group = (name: string, permissions: string[], parent?: string | null) =>
  needsOperatorRight(VIEW, { kind: 'group', name, permissions, parent });
const deleting = (name: string) => needsOperatorRight(VIEW, { kind: 'deleteGroup', name });

describe('nodes of the server itself', () => {
  it('counts the hytale namespace, granted or denied, and every wildcard over it', () => {
    for (const node of [
      'hytale.command.op.add',
      '-hytale.command.op.add',
      'hytale.*',
      '-hytale.*',
      'hytale.command.*',
      'hytale.command.perm.user.add',
      '*',
      '-*',
      ' Hytale.Command.Op.Add ',
    ]) {
      expect(isOperatorNode(node), node).toBe(true);
    }
  });

  it('leaves mod nodes alone', () => {
    for (const node of [
      'ks.pets.user.x',
      '-ks.pets.user.x',
      'ks.*',
      'hytalex.foo',
      'my.hytale.x',
    ]) {
      expect(isOperatorNode(node), node).toBe(false);
    }
  });
});

describe('the review cases', () => {
  it('a player given the node of /op add', () => {
    expect(user(PLAYER, { permissions: ['hytale.command.op.add'] })).toBe(true);
  });

  it('the default group given any permission', () => {
    expect(group('hytale:Adventurer', ['hytale.command.op.add'])).toBe(true);
    expect(group('hytale:Adventurer', ['ks.pets.user.x'])).toBe(true);
    expect(group('adventurer', ['ks.pets.user.x'])).toBe(true); // older alias
    expect(group('hytale:None', ['ks.pets.user.x'])).toBe(true); // a parent of it
  });

  it('a group with the node, and a player put into such a group', () => {
    expect(group('Sneaky2', ['hytale.command.op.add'])).toBe(true);
    expect(user(PLAYER, { groups: ['Sneaky'] })).toBe(true);
  });

  it('a deny over the namespace for an operator, and deleting a group that carries such rights', () => {
    expect(user(OPERATOR, { permissions: ['-hytale.*'] })).toBe(true);
    expect(group('Lockout', ['-hytale.*'])).toBe(true);
    expect(deleting('Wild')).toBe(true);
    expect(deleting('Staff')).toBe(true);
    expect(deleting('Denied')).toBe(true);
  });
});

describe('players', () => {
  it('taking a node of the server away needs it too', () => {
    const holder = { groups: ['hytale:Adventurer'], permissions: ['hytale.command.op.add'] };
    expect(user(holder, { permissions: [] })).toBe(true);
    expect(
      needsOperatorRight(VIEW, operatorChangeOf({ kind: 'removeUser', player: 'x' }, holder)),
    ).toBe(true);
  });

  it('built-in groups above the default one, and the operator group, count', () => {
    expect(user(PLAYER, { groups: ['hytale:Builder'] })).toBe(true);
    expect(user(PLAYER, { groups: ['op'] })).toBe(true);
    expect(user(PLAYER, { groups: ['Staff'] })).toBe(true);
    expect(user(OPERATOR, { groups: [] })).toBe(true);
    expect(
      needsOperatorRight(VIEW, operatorChangeOf({ kind: 'removeUser', player: 'x' }, OPERATOR)),
    ).toBe(true);
  });

  it('the default rights count too: a player moved to a group that does not inherit them', () => {
    expect(user(PLAYER, { groups: ['Mods'] })).toBe(true);
    expect(user({ groups: ['Mods'], permissions: [] }, { groups: [] })).toBe(true);
    expect(user(PLAYER, { groups: ['hytale:None'] })).toBe(true);
    expect(user({ groups: [], permissions: [] }, { groups: ['VIP'] })).toBe(true); // had no group at all
    // A group that does not exist gives nothing, the default rights are gone.
    expect(user(PLAYER, { groups: ['Nowhere'] })).toBe(true);
  });

  it('mod permissions and harmless groups stay free', () => {
    expect(user(PLAYER, { permissions: ['ks.pets.user.x'] })).toBe(false);
    expect(user(PLAYER, { groups: ['VIP'] })).toBe(false);
    expect(user(PLAYER, { groups: ['adventurer'] })).toBe(false); // the default group by its old name
    expect(user({ groups: ['VIP'], permissions: [] }, { groups: [] })).toBe(false);
    expect(user(PLAYER, { groups: ['hytale:Adventurer', 'Mods'] })).toBe(false);
    expect(user({ groups: ['VIP', 'Mods'], permissions: [] }, { groups: ['VIP'] })).toBe(false);
    // An operator's own mod permissions, with the groups left as they are.
    expect(user(OPERATOR, { permissions: ['fly.use'], groups: ['hytale:Admin'] })).toBe(false);
    expect(
      needsOperatorRight(VIEW, operatorChangeOf({ kind: 'removeUser', player: 'x' }, WHITELISTED)),
    ).toBe(false);
  });

  it('ignores the join permission, which the change keeps as it is', () => {
    expect(user(WHITELISTED, { permissions: ['ks.pets.user.x', 'ks.more'] })).toBe(false);
    expect(user(PLAYER, { permissions: ['hytale.server.join'] })).toBe(false);
    // A deny of it is a node like any other.
    expect(user(PLAYER, { permissions: ['-hytale.server.join'] })).toBe(true);
  });

  it('only counts what changes', () => {
    const holder = { groups: ['Wild'], permissions: ['hytale.command.kick'] };
    expect(user(holder, { permissions: ['hytale.command.kick', 'ks.x'], groups: ['Wild'] })).toBe(
      false,
    );
  });

  it('any group change of a player with more than every player has counts', () => {
    // Even a harmless extra group: the server reads the groups one after another.
    expect(
      user({ groups: ['Wild', 'VIP'], permissions: [] }, { groups: ['Wild', 'VIP', 'Mods'] }),
    ).toBe(true);
  });
});

describe('a new group that players or groups already name', () => {
  // An operator moved Eve to hytale:None: she has no default rights any more.
  const eve = { groups: ['hytale:None'], permissions: [] as string[] };
  const withEve = (groups: string[]): OperatorView => ({ ...VIEW, users: [{ groups }] });

  it('putting a player into a group that does not exist changes nothing yet', () => {
    expect(user(eve, { groups: ['hytale:Adventurer'] })).toBe(true); // the direct way
    expect(user(eve, { groups: ['hytale:None', 'Ghost'] })).toBe(false);
  });

  it('creating that group below the default group then counts like a parent change', () => {
    const create = { kind: 'group' as const, name: 'Ghost', permissions: ['ks.ghost'] };
    expect(
      needsOperatorRight(withEve(['hytale:None', 'Ghost']), {
        ...create,
        parent: 'hytale:Adventurer',
      }),
    ).toBe(true);
    // Also when a group names it as its parent, or a group was deleted and is made again.
    const inheriting: OperatorView = {
      ...VIEW,
      groups: [...VIEW.groups, { name: 'Child', parent: 'Ghost', permissions: [] }],
    };
    expect(needsOperatorRight(inheriting, { ...create, parent: 'hytale:Adventurer' })).toBe(true);
    // Without a parent the new group gives its members nothing of the server.
    expect(needsOperatorRight(withEve(['hytale:None', 'Ghost']), { ...create, parent: null })).toBe(
      false,
    );
    // Nobody names it: free, as before.
    expect(needsOperatorRight(VIEW, { ...create, parent: 'hytale:Adventurer' })).toBe(false);
  });

  it('assumes someone names it when the players are not all known', () => {
    const create = { kind: 'group' as const, name: 'Ghost', permissions: [], parent: 'VIP' };
    expect(needsOperatorRight({ ...VIEW, usersComplete: false }, create)).toBe(true);
    expect(needsOperatorRight({ ...VIEW, users: undefined }, create)).toBe(true);
  });
});

describe('groups', () => {
  it('changing a group that carries such rights counts, a harmless one does not', () => {
    expect(group('Wild', ['hytale.command.*', 'ks.x'])).toBe(true);
    expect(group('Staff', ['ks.x'])).toBe(true);
    expect(group('hytale:Builder', ['ks.x'])).toBe(true);
    expect(group('Mods', ['kick.use', 'mute.use'])).toBe(false);
    expect(group('VIP', ['ks.pets.user.x', 'ks.pets.user.y'], 'hytale:Adventurer')).toBe(false);
    expect(group('Fresh', ['ks.pets.user.x'])).toBe(false);
  });

  it('a parent that carries such rights counts', () => {
    expect(group('Mods', ['kick.use'], 'hytale:Builder')).toBe(true);
    expect(group('Sneaky3', ['a.b'], 'hytale:Admin')).toBe(true);
    expect(group('Sneaky3', [], 'Staff')).toBe(true);
  });

  it('a parent change that gives the members the default rights, or takes them, counts', () => {
    expect(group('Mods', ['kick.use'], 'VIP')).toBe(true);
    expect(group('VIP', ['ks.pets.user.x'], null)).toBe(true);
    // A new group has no members yet: it may start below the default group.
    expect(group('Fresh2', ['ks.x'], 'hytale:Adventurer')).toBe(false);
    expect(group('Fresh2', ['ks.x'], 'VIP')).toBe(false);
  });

  it('a parent change on a group another one with such rights inherits from counts', () => {
    expect(group('Base', ['ks.base'], 'Mods')).toBe(true);
    expect(group('Base', ['ks.base'], null)).toBe(false); // already none
    expect(group('Base', ['ks.base', 'ks.more'])).toBe(false); // parent kept
  });

  it('deleting a group counts when its members or inheritors lose such rights with it', () => {
    expect(deleting('Base')).toBe(true); // Moderator inherits from it
    expect(deleting('VIP')).toBe(true); // its members lose the default rights
    expect(deleting('Mods')).toBe(false);
    expect(deleting('Nowhere')).toBe(false);
  });

  it('a name of another form counts (the routes refuse it first)', () => {
    expect(group('', [])).toBe(true);
    const long = `Staff${'x'.repeat(60)}`; // 65 characters, the server reads it
    const withLong: OperatorView = {
      ...VIEW,
      groups: [...VIEW.groups, { name: long, parent: 'hytale:Admin', permissions: [] }],
    };
    expect(needsOperatorRight(withLong, { kind: 'deleteGroup', name: long })).toBe(true);
    expect(needsOperatorRight(withLong, { kind: 'group', name: long, permissions: [] })).toBe(true);
    expect(deleting('hytale:Admin')).toBe(false); // built in, deleteGroup refuses it
  });
});
