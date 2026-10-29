/**
 * Which changes on the access pages can give out or take away the server's
 * own command rights, decided on the groups and players as the server has
 * them. Pure, like accessFormats.
 *
 * The server's own permissions all live under `hytale.` (its commands and
 * those of its built-in plugins). A node counts when it lies in that
 * namespace, granted or denied, or is a wildcard that covers it (`*`,
 * `hytale.*`, `hytale.command.*`, ...). Every built-in group gets command
 * rights from the server itself, the default group (which every player
 * without a group of their own is in) included. When in doubt a change
 * counts; the routes then also ask for players.op.
 */
import {
  BUILTIN_GROUPS,
  DEFAULT_GROUP,
  JOIN_PERMISSION,
  isGroupNameInput,
  resolveGroupName,
} from './accessFormats.js';

const CORE_NAMESPACE = 'hytale';
/** Built-in groups that give no more than every player has: none, and the default group. */
const BASELINE_GROUPS: ReadonlySet<string> = new Set(['hytale:None', DEFAULT_GROUP]);

/** A change the access routes check before they make it. */
export type AccessChange =
  | { kind: 'user'; player: string; groups?: unknown; permissions?: unknown }
  | { kind: 'removeUser'; player: string }
  | { kind: 'group'; name: unknown; permissions?: unknown; parent?: unknown }
  | { kind: 'deleteGroup'; name: unknown };

/** A player's groups (the default group when none are stored) and own permissions. */
export interface UserAccessState {
  groups: readonly string[];
  permissions: readonly string[];
}

/** The same change, with the player's current state in place of the name. */
export type OperatorChange =
  | { kind: 'user'; current: UserAccessState; groups?: unknown; permissions?: unknown }
  | { kind: 'group'; name: unknown; permissions?: unknown; parent?: unknown }
  | { kind: 'deleteGroup'; name: unknown };

/** What needsOperatorRight looks at: the groups (and players) as the server has them. */
export interface OperatorView {
  operatorGroup: string;
  defaultGroup: string;
  groups: readonly { name: string; parent?: string | null; permissions: readonly string[] }[];
  /** The players' groups; with these missing or not complete every group counts as named by someone. */
  users?: readonly { groups: readonly string[] }[];
  usersComplete?: boolean;
}

/** A node that decides one of the server's own permissions (grant or deny, or a wildcard over them). */
export function isOperatorNode(node: unknown): boolean {
  if (typeof node !== 'string') return false;
  const base = node.trim().replace(/^-/, '').toLowerCase();
  return base === '*' || base === CORE_NAMESPACE || base.startsWith(`${CORE_NAMESPACE}.`);
}

const textItems = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').map((v) => v.trim())
    : [];

/** What is in one list and not the other, either way. */
const changedItems = (a: readonly string[], b: readonly string[]) => [
  ...a.filter((x) => !b.includes(x)),
  ...b.filter((x) => !a.includes(x)),
];

/** A parent as saveGroup reads it: undefined keeps it, null removes it. */
function parentOf(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return typeof value === 'string' ? resolveGroupName(value.trim()) : undefined;
}

function groupRules(view: OperatorView) {
  const byName = new Map(view.groups.map((g) => [g.name, g]));
  // The whole chain, past the server's own limit too: a group counts once anything in it does.
  const chainOf = (name: string | null | undefined) => {
    const chain: string[] = [];
    for (let at = name; at && !chain.includes(at);) {
      chain.push(at);
      at = byName.get(at)?.parent;
    }
    return chain;
  };
  const ownNodes = (name: string) => (byName.get(name)?.permissions ?? []).some(isOperatorNode);
  /** Gives such rights itself: the operator group, a built-in group, or own nodes of that kind. */
  const hasRights = (name: string) =>
    name === view.operatorGroup || BUILTIN_GROUPS.has(name) || ownNodes(name);
  /** Gives more than every player has, through itself or a parent. */
  const carries = (name: string) =>
    chainOf(resolveGroupName(name)).some(
      (g) =>
        g === view.operatorGroup ||
        (BUILTIN_GROUPS.has(g) && !BASELINE_GROUPS.has(g) && g !== view.defaultGroup) ||
        ownNodes(g),
    );
  const inheritors = (name: string) =>
    view.groups.map((g) => g.name).filter((g) => g !== name && chainOf(g).includes(name));
  /** Every group a player in `groups` takes rights from. */
  const closure = (groups: readonly string[]) => [...new Set(groups.flatMap((g) => chainOf(g)))];
  /**
   * A player or a group names it already, though it may not exist (neither the
   * panel nor the server checks that). Unknown players: assume someone does.
   */
  const named = (name: string) =>
    !view.users ||
    view.usersComplete !== true ||
    view.users.some((u) => u.groups.some((g) => resolveGroupName(g) === name)) ||
    view.groups.some((g) => g.parent === name);
  return {
    byName,
    chainOf,
    hasRights,
    carries,
    closure,
    named,
    // The groups every player has a share in: the default group and its parents.
    everyone: new Set(chainOf(view.defaultGroup)),
    /** The group, or a group that inherits from it, carries such rights. */
    reaches: (name: string) => carries(name) || inheritors(name).some(carries),
  };
}

function userNeeds(view: OperatorView, change: Extract<OperatorChange, { kind: 'user' }>): boolean {
  // The join permission is the whitelist's; this change keeps it as it is.
  const own = (nodes: readonly string[]) => nodes.filter((p) => p !== JOIN_PERMISSION);
  if (change.permissions !== undefined) {
    const changed = changedItems(
      own(change.current.permissions),
      own(textItems(change.permissions)),
    );
    if (changed.some(isOperatorNode)) return true;
  }
  if (change.groups === undefined) return false;
  const { carries, closure, hasRights } = groupRules(view);
  const wanted = [...new Set(textItems(change.groups).map(resolveGroupName))];
  // With no group stored the server uses the default group.
  const then = wanted.length > 0 ? wanted : [view.defaultGroup];
  const now = [...new Set(change.current.groups.map(resolveGroupName))];
  if (changedItems(now, then).length === 0) return false;
  // A player with more than every player has: any change to their groups (the
  // server reads the groups one after another, so even the order can matter).
  if ([...now, ...then].some(carries)) return true;
  // Otherwise whatever the player gains or loses along the parents: the
  // default group's rights too, e.g. moved to a group that does not inherit it.
  return changedItems(closure(now), closure(then)).some(hasRights);
}

function groupNeeds(
  view: OperatorView,
  change: Extract<OperatorChange, { kind: 'group' }>,
): boolean {
  const name = typeof change.name === 'string' ? resolveGroupName(change.name.trim()) : '';
  // The routes refuse such a name first; a name of another form counts.
  if (!isGroupNameInput(name)) return true;
  const { byName, carries, chainOf, everyone, hasRights, named, reaches } = groupRules(view);
  if (everyone.has(name) || carries(name)) return true;
  const current = byName.get(name);
  if (changedItems(current?.permissions ?? [], textItems(change.permissions)).some(isOperatorNode))
    return true;
  // The server forces the parent of a built-in group.
  const parent = BUILTIN_GROUPS.has(name) ? undefined : parentOf(change.parent);
  if (parent === undefined || parent === (current?.parent ?? null)) return false;
  // A new group that nobody names yet has no members: only a parent with more than every player has counts.
  if (!current && !named(name)) return parent !== null && carries(parent);
  // Its members and those of inheriting groups swap one parent chain for another
  // (for a new group: from none, so a player put into it beforehand gains nothing unchecked).
  return reaches(name) || changedItems(chainOf(current?.parent), chainOf(parent)).some(hasRights);
}

function deleteNeeds(view: OperatorView, rawName: unknown): boolean {
  const name = typeof rawName === 'string' ? resolveGroupName(rawName.trim()) : '';
  // deleteGroup refuses a built-in group; the routes refuse a name of another form first, it counts.
  if (BUILTIN_GROUPS.has(name)) return false;
  if (!isGroupNameInput(name)) return true;
  const { chainOf, everyone, hasRights, reaches } = groupRules(view);
  // Its members keep the name, which then gives nothing: they lose the whole chain.
  return everyone.has(name) || reaches(name) || chainOf(name).some(hasRights);
}

/**
 * Whether a change can give out or take away the server's own rights:
 *  - a player: an own permission of that kind set or removed; any change to
 *    the groups of a player in a group that carries more than every player
 *    has (itself, through a parent, as a built-in group above the default
 *    one, or as the operator group); otherwise a group change that adds or
 *    removes such rights along the parents, the default group's included;
 *  - a group: one that carries them, the default group (or a parent of it),
 *    a permission of that kind set or removed, or a parent change that adds or
 *    removes such rights for its members, or on a group an inheriting group
 *    with such rights depends on;
 *  - deleting a group whose members or inheritors lose such rights with it.
 * The routes then also ask for players.op, the right of the op commands.
 */
export function needsOperatorRight(view: OperatorView, change: OperatorChange): boolean {
  if (change.kind === 'user') return userNeeds(view, change);
  if (change.kind === 'group') return groupNeeds(view, change);
  return deleteNeeds(view, change.name);
}

/** An access change with the player's current state filled in (removing = no groups, no permissions). */
export function operatorChangeOf(change: AccessChange, current: UserAccessState): OperatorChange {
  if (change.kind === 'removeUser') return { kind: 'user', current, groups: [], permissions: [] };
  if (change.kind === 'user') {
    return { kind: 'user', current, groups: change.groups, permissions: change.permissions };
  }
  return change;
}
