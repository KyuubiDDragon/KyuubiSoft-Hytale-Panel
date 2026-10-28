/**
 * Groups and per-player permissions of a Hytale 0.7 server (permissions.json).
 * See accessContext for where they are read from and written to.
 *
 * The running server cannot list every user (only online players, players on
 * the whitelist and wildcard holders), so the user list comes from
 * permissions.json, which the server rewrites on every change, with the
 * server's live answer laid over it. A group's parent cannot be changed by a
 * command; that needs a stopped server.
 */
import * as kyuubiApi from './kyuubiApi.js';
import { loadPlayerDirectory, resolvePlayer } from './accessDirectory.js';
import { accessFiles, readServerJson, updateServerJson } from './accessFiles.js';
import {
  BUILTIN_GROUPS,
  DEFAULT_GROUP,
  JOIN_PERMISSION,
  OPERATOR_GROUP,
  canonicalUuid,
  effectiveGroupPermissions,
  isGroupNameInput,
  isPermissionNodeInput,
  readPermissions,
  resolveGroupName,
  withGroup,
  withoutGroup,
  withUserAccess,
  type PermissionsData,
} from './accessFormats.js';
import { needsOperatorRight, operatorChangeOf, type AccessChange } from './accessOperator.js';
import { AccessInputError, accessCommand, runAccessCommand } from './accessCommands.js';
import {
  AccessError,
  commandFailure,
  describeAccessError,
  requireUuid,
  serverRunningOrNull,
  waitFor,
  writeFilesOrCommand,
  type AccessViewBase,
  type WriteOutcome,
} from './accessContext.js';
import { migrateAccessFiles } from './accessMigration.js';

export interface PermissionUserView {
  uuid: string;
  name?: string;
  groups: string[];
  /** The player's own permissions (the join permission among them). */
  permissions: string[];
  /** No groups are stored: the server uses the default group. */
  defaultGroup: boolean;
  joinGrant: boolean;
  online?: boolean;
  operator?: boolean;
}

export interface PermissionGroupView {
  name: string;
  parent?: string;
  /** Own permissions, the built-in ones included. */
  permissions: string[];
  /** Permissions the server always gives a built-in group (cannot be removed). */
  builtinPermissions: string[];
  effectivePermissions: string[];
  builtin: boolean;
}

export interface PermissionsView extends AccessViewBase {
  users: PermissionUserView[];
  groups: PermissionGroupView[];
  defaultGroup: string;
  operatorGroup: string;
}

type WriteResult = Omit<WriteOutcome<PermissionsView>, 'view'>;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;
const difference = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

async function filePermissions(serverId?: string): Promise<PermissionsData> {
  const files = await accessFiles(serverId);
  return readPermissions(await readServerJson(files.permissions, files.serverPath));
}

function fileGroupViews(data: PermissionsData): PermissionGroupView[] {
  return data.groups.map((g) => ({
    name: g.name,
    parent: g.parent ?? undefined,
    permissions: [...g.permissions].sort(),
    builtinPermissions: [...(BUILTIN_GROUPS.get(g.name)?.permissions ?? [])],
    effectivePermissions: effectiveGroupPermissions(data.groups, g.name),
    builtin: g.builtin,
  }));
}

const textList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** The plugin's groups, or null when it does not answer (or answers something else). */
function liveGroupsOf(
  response: Awaited<ReturnType<typeof kyuubiApi.getPermissionGroupsFromPlugin>> | null,
) {
  const data = response?.success ? response.data : undefined;
  if (!data || !Array.isArray(data.groups)) return null;
  const virtualGroups: Record<string, string[]> = {};
  if (data.virtualGroups && typeof data.virtualGroups === 'object') {
    for (const [name, nodes] of Object.entries(data.virtualGroups))
      virtualGroups[name] = textList(nodes);
  }
  return {
    defaultGroup: typeof data.defaultGroup === 'string' ? data.defaultGroup : DEFAULT_GROUP,
    operatorGroup: typeof data.operatorGroup === 'string' ? data.operatorGroup : OPERATOR_GROUP,
    groups: data.groups
      .filter((g) => g && typeof g.name === 'string')
      .map((g) => ({
        name: g.name,
        parent: typeof g.parent === 'string' ? g.parent : undefined,
        permissions: textList(g.permissions),
        effectivePermissions: textList(g.effectivePermissions),
      })),
    virtualGroups,
  };
}

/** One user as the plugin reports it, or null when the answer is not one. */
function liveUserOf(
  user: kyuubiApi.LivePermissionUser | undefined,
): kyuubiApi.LivePermissionUser | null {
  const uuid = canonicalUuid(user?.uuid);
  if (!user || !uuid) return null;
  const permissions = textList(user.permissions);
  return {
    uuid,
    name: typeof user.name === 'string' ? user.name : undefined,
    online: user.online === true,
    groups: textList(user.groups),
    permissions,
    operator: user.operator === true,
    joinGrant:
      typeof user.joinGrant === 'boolean' ? user.joinGrant : permissions.includes(JOIN_PERMISSION),
  };
}

export async function getPermissions(serverId?: string): Promise<PermissionsView> {
  const serverRunning = await serverRunningOrNull(serverId);
  const [fileRead, liveGroups, liveUsers] = await Promise.all([
    filePermissions(serverId).then(
      (data) => ({ data }),
      (error: unknown) => ({ error }),
    ),
    serverRunning ? kyuubiApi.getPermissionGroupsFromPlugin(serverId) : null,
    serverRunning ? kyuubiApi.getPermissionUsersFromPlugin(serverId) : null,
  ]);
  const live = liveGroupsOf(liveGroups);
  // With the live answer at hand, a file the panel cannot read is reported, not fatal.
  if ('error' in fileRead && !live) throw fileRead.error;
  const file: PermissionsData =
    'data' in fileRead
      ? fileRead.data
      : {
          users: [],
          groups: [],
          problems: [
            {
              fatal: true,
              where: 'permissions.json',
              detail: describeAccessError(fileRead.error).error,
            },
          ],
        };
  const directory = await loadPlayerDirectory(serverId, { askPlugin: live !== null });

  const users = new Map<string, PermissionUserView>();
  for (const u of file.users) {
    users.set(u.uuid, {
      uuid: u.uuid,
      // Stored as an empty list, the player has no group at all; not stored, the default one.
      groups: u.groups ?? [DEFAULT_GROUP],
      permissions: [...u.permissions].sort(),
      defaultGroup: u.groups === null,
      joinGrant: u.permissions.includes(JOIN_PERMISSION),
    });
  }
  const liveUserList =
    liveUsers?.success && Array.isArray(liveUsers.data?.users) ? liveUsers.data.users : [];
  if (live) {
    for (const u of liveUserList.map(liveUserOf)) {
      if (!u) continue;
      const stored = users.get(u.uuid);
      users.set(u.uuid, {
        uuid: u.uuid,
        name: u.name,
        groups: u.groups,
        permissions: [...u.permissions].sort(),
        defaultGroup: stored?.defaultGroup ?? true,
        joinGrant: u.joinGrant === true,
        online: u.online,
        operator: u.operator,
      });
    }
  }
  const named = [...users.values()]
    .map((u) => ({ ...u, name: u.name ?? directory.nameOf(u.uuid) }))
    .sort((a, b) => (a.name ?? `~${a.uuid}`).localeCompare(b.name ?? `~${b.uuid}`));

  const groups: PermissionGroupView[] = live
    ? live.groups.map((g) => ({
        name: g.name,
        parent: g.parent,
        permissions: [...g.permissions].sort(),
        builtinPermissions: [...(BUILTIN_GROUPS.get(g.name)?.permissions ?? [])],
        effectivePermissions: [...g.effectivePermissions].sort(),
        builtin: BUILTIN_GROUPS.has(g.name),
      }))
    : fileGroupViews(file);

  return {
    users: named,
    groups,
    defaultGroup: live?.defaultGroup ?? DEFAULT_GROUP,
    operatorGroup: live?.operatorGroup ?? OPERATOR_GROUP,
    source: live ? 'live' : 'file',
    serverRunning,
    problems: file.problems,
  };
}

// ------------------------------------------------------------
// Input
// ------------------------------------------------------------

function nodeList(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new AccessInputError(`${what} must be a list`);
  const nodes = [...new Set(value.map((n) => (typeof n === 'string' ? n.trim() : n)))];
  for (const node of nodes) {
    if (!isPermissionNodeInput(node)) {
      throw new AccessInputError(
        `"${String(node).slice(0, 80)}" is not a permission the server reads (letters, digits, _ and -, parts separated by dots, * only after a dot)`,
      );
    }
  }
  return nodes as string[];
}

function groupList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new AccessInputError('groups must be a list');
  const groups = [
    ...new Set(value.map((g) => (typeof g === 'string' ? resolveGroupName(g.trim()) : ''))),
  ];
  for (const group of groups) {
    if (!isGroupNameInput(group))
      throw new AccessInputError(`"${group}" is not a valid group name`);
  }
  // Only the default group, or none: the player falls back to the default group.
  return groups.length === 1 && groups[0] === DEFAULT_GROUP ? [] : groups;
}

export interface UserEdit {
  player: string;
  groups?: unknown;
  permissions?: unknown;
}

interface UserState {
  /** The groups that apply (the default group when none are stored). */
  groups: string[];
  permissions: string[];
}

async function currentUser(
  serverId: string | undefined,
  uuid: string,
  live: boolean,
): Promise<UserState | null> {
  if (live) {
    const user = liveUserOf((await kyuubiApi.getPermissionUserFromPlugin(uuid, serverId)).data);
    if (!user) return null;
    return { groups: user.groups, permissions: user.permissions };
  }
  const stored = (await filePermissions(serverId)).users.find((u) => u.uuid === uuid);
  return {
    groups: stored?.groups ?? [DEFAULT_GROUP],
    permissions: stored?.permissions ?? [],
  };
}

/** The groups the server has stored for a player: null when none are (the default group applies). */
async function storedGroups(serverId: string | undefined, uuid: string): Promise<string[] | null> {
  const stored = (await filePermissions(serverId)).users.find((u) => u.uuid === uuid);
  return stored?.groups ?? null;
}

/**
 * Group commands that turn the stored groups into `wanted` ([] = the default
 * group). The server adds to and removes from the stored list only, and drops
 * it once it is empty (the default group then applies again).
 */
function groupCommands(uuid: string, stored: string[] | null, wanted: string[]): string[] {
  const add = (g: string) => accessCommand.userGroup('add', uuid, g);
  const remove = (g: string) => accessCommand.userGroup('remove', uuid, g);
  if (wanted.length === 0) {
    if (stored === null) return [];
    // An empty stored list means no group at all; storing the default group fixes that.
    if (stored.length === 0) return [add(DEFAULT_GROUP)];
    return stored.map(remove);
  }
  const current = stored ?? [];
  // Adds first, so the list is never empty in between (that would mean the default group).
  return [...difference(wanted, current).map(add), ...difference(current, wanted).map(remove)];
}

function matches(
  state: UserState | null,
  groups: string[] | undefined,
  permissions: string[] | undefined,
) {
  if (!state) return false;
  const wantedGroups = groups && groups.length > 0 ? groups : [DEFAULT_GROUP];
  return (
    (groups === undefined || sameSet(state.groups, wantedGroups)) &&
    (permissions === undefined || sameSet(state.permissions, permissions))
  );
}

/**
 * The own permissions to set, with the join permission as it is now: that one
 * is the whitelist's (players.whitelist), so it is changed there only.
 */
const keepingJoin = (wanted: string[], current: string[]) => [
  ...wanted.filter((p) => p !== JOIN_PERMISSION),
  ...(current.includes(JOIN_PERMISSION) ? [JOIN_PERMISSION] : []),
];

async function userInFile(
  serverId: string | undefined,
  uuid: string,
  groups: string[] | undefined,
  permissions: string[] | undefined,
): Promise<WriteResult> {
  await migrateAccessFiles(serverId, { serverStopped: true });
  const files = await accessFiles(serverId);
  let changed = false;
  await updateServerJson(files.permissions, files.serverPath, (current) => {
    const stored = readPermissions(current).users.find((u) => u.uuid === uuid);
    const own = stored?.permissions ?? [];
    const target = permissions && keepingJoin(permissions, own);
    const next = withUserAccess(current, uuid, {
      ...(groups !== undefined ? { groups } : {}),
      ...(target !== undefined
        ? {
            addPermissions: difference(target, own),
            removePermissions: difference(own, target),
          }
        : {}),
    });
    changed = JSON.stringify(next) !== JSON.stringify(current ?? {});
    return changed ? next : undefined;
  });
  return { via: 'file', verified: true, changed };
}

async function runAll(serverId: string | undefined, commands: string[]) {
  let via: 'plugin' | 'stdin' = 'plugin';
  for (const [index, command] of commands.entries()) {
    const result = await runAccessCommand(command, serverId);
    if (result.kind === 'rejected' || result.kind === 'failed') {
      const error = commandFailure(result);
      if (index === 0) throw error;
      throw new AccessError(
        error.status,
        `${error.message} (${index} of ${commands.length} changes were applied)`,
        error.code,
      );
    }
    if (result.kind === 'sent' && result.via === 'stdin') via = 'stdin';
  }
  return via;
}

async function userByCommand(
  serverId: string | undefined,
  uuid: string,
  groups: string[] | undefined,
  permissions: string[] | undefined,
): Promise<WriteResult> {
  const liveState = await currentUser(serverId, uuid, true);
  const state = liveState ?? (await currentUser(serverId, uuid, false))!;
  // The server rewrites permissions.json on every change, so the file tells
  // what is stored (the live answer shows the default group in its place).
  const commands =
    groups === undefined ? [] : groupCommands(uuid, await storedGroups(serverId, uuid), groups);
  const target = permissions && keepingJoin(permissions, state.permissions);
  if (target !== undefined) {
    for (const p of difference(target, state.permissions))
      commands.push(accessCommand.userPermission('add', uuid, p));
    for (const p of difference(state.permissions, target))
      commands.push(accessCommand.userPermission('remove', uuid, p));
  }
  if (commands.length === 0)
    return { via: liveState ? 'plugin' : 'stdin', verified: true, changed: false };
  const via = await runAll(serverId, commands);
  const verified = await waitFor(async () =>
    matches(await currentUser(serverId, uuid, via === 'plugin'), groups, target),
  );
  return { via, verified, changed: true };
}

/**
 * Sets a player's groups and/or own permissions (what is not given stays;
 * the join permission always stays as it is, see keepingJoin).
 */
export async function setUserPermissions(
  serverId: string | undefined,
  edit: UserEdit,
): Promise<WriteOutcome<PermissionsView>> {
  const groups = edit.groups === undefined ? undefined : groupList(edit.groups);
  const permissions =
    edit.permissions === undefined ? undefined : nodeList(edit.permissions, 'permissions');
  const uuid = requireUuid(await resolvePlayer(serverId, edit.player, { askPlugin: true }));
  const outcome = await writeFilesOrCommand(
    serverId,
    () => userInFile(serverId, uuid, groups, permissions),
    () => userByCommand(serverId, uuid, groups, permissions),
  );
  return { ...outcome, view: await getPermissions(serverId) };
}

/**
 * Takes a player's groups and own permissions away, except the join
 * permission (that is the whitelist's; remove it there).
 */
export async function removeUserPermissions(
  serverId: string | undefined,
  player: string,
): Promise<WriteOutcome<PermissionsView>> {
  const uuid = requireUuid(await resolvePlayer(serverId, player, { askPlugin: true }));
  const outcome = await writeFilesOrCommand(
    serverId,
    () => userInFile(serverId, uuid, [], []),
    () => userByCommand(serverId, uuid, [], []),
  );
  return { ...outcome, view: await getPermissions(serverId) };
}

// ------------------------------------------------------------
// Groups
// ------------------------------------------------------------

export interface GroupEdit {
  name: unknown;
  permissions: unknown;
  /** Absent: keep the parent; null or '': no parent. */
  parent?: unknown;
}

function checkParent(data: PermissionsData, name: string, parent: string | null) {
  if (parent === null) return;
  if (!isGroupNameInput(parent))
    throw new AccessInputError(`"${parent}" is not a valid group name`);
  if (parent === name) throw new AccessInputError('A group cannot inherit from itself');
  const byName = new Map(data.groups.map((g) => [g.name, g]));
  if (!byName.has(parent)) throw new AccessInputError(`There is no group "${parent}"`);
  const seen = new Set<string>();
  for (let at: string | null = parent; at; at = byName.get(at)?.parent ?? null) {
    if (at === name) throw new AccessInputError(`"${parent}" already inherits from "${name}"`);
    if (seen.has(at)) break;
    seen.add(at);
  }
}

async function groupInFile(
  serverId: string | undefined,
  name: string,
  permissions: string[],
  parent: string | null | undefined,
): Promise<WriteResult> {
  await migrateAccessFiles(serverId, { serverStopped: true });
  const files = await accessFiles(serverId);
  let changed = false;
  await updateServerJson(files.permissions, files.serverPath, (current) => {
    if (parent !== undefined) checkParent(readPermissions(current), name, parent);
    const next = withGroup(current, name, { permissions, parent });
    changed = JSON.stringify(next) !== JSON.stringify(current ?? {});
    return changed ? next : undefined;
  });
  return { via: 'file', verified: true, changed };
}

/** undefined: the plugin does not answer; null: the server has no such group. */
async function liveGroup(serverId: string | undefined, name: string) {
  const live = liveGroupsOf(await kyuubiApi.getPermissionGroupsFromPlugin(serverId));
  if (!live) return undefined;
  return live.groups.find((g) => g.name === name) ?? null;
}

async function groupState(serverId: string | undefined, name: string, viaPlugin: boolean) {
  if (viaPlugin) {
    const live = await liveGroup(serverId, name);
    if (live !== undefined)
      return live && { parent: live.parent ?? null, permissions: live.permissions };
  }
  const group = (await filePermissions(serverId)).groups.find((g) => g.name === name);
  return group ? { parent: group.parent, permissions: group.permissions } : null;
}

async function groupByCommand(
  serverId: string | undefined,
  name: string,
  permissions: string[],
  parent: string | null | undefined,
): Promise<WriteResult> {
  const live = await liveGroup(serverId, name);
  const viaPlugin = live !== undefined;
  const state = await groupState(serverId, name, viaPlugin);
  if (parent !== undefined && parent !== (state?.parent ?? null)) {
    throw new AccessError(
      409,
      'The server has no command to change which group a group inherits from; stop the server to change it.',
      'needs_stopped_server',
    );
  }
  const builtin = [...(BUILTIN_GROUPS.get(name)?.permissions ?? [])];
  const wanted = [...new Set([...builtin, ...permissions])];
  const current = state?.permissions ?? [];
  if (!state && permissions.length === 0) {
    throw new AccessError(
      409,
      'While the server runs, a new group needs at least one permission.',
      'needs_stopped_server',
    );
  }
  // The running server drops a group that is left without permissions and parent.
  if (state && !state.parent && wanted.length === 0 && !BUILTIN_GROUPS.has(name)) {
    throw new AccessError(
      409,
      'Without permissions the running server deletes the group. Delete it, or stop the server to keep it empty.',
      'needs_stopped_server',
    );
  }
  const commands = [
    ...difference(wanted, current).map((p) => accessCommand.groupPermission('add', name, p)),
    ...difference(current, wanted)
      .filter((p) => !builtin.includes(p))
      .map((p) => accessCommand.groupPermission('remove', name, p)),
  ];
  if (commands.length === 0)
    return { via: viaPlugin ? 'plugin' : 'stdin', verified: true, changed: false };
  const via = await runAll(serverId, commands);
  const verified = await waitFor(async () => {
    const after = await groupState(serverId, name, via === 'plugin');
    return after !== null && sameSet(after.permissions, wanted);
  });
  return { via, verified, changed: true };
}

/** Creates or changes a group: its own permissions and (with the server stopped) its parent. */
export async function saveGroup(
  serverId: string | undefined,
  edit: GroupEdit,
): Promise<WriteOutcome<PermissionsView>> {
  const name = typeof edit.name === 'string' ? resolveGroupName(edit.name.trim()) : '';
  if (!isGroupNameInput(name)) {
    throw new AccessInputError(
      'A group name needs letters or digits first, then letters, digits, _, - or :',
    );
  }
  const permissions = nodeList(edit.permissions, 'permissions');
  const parent =
    edit.parent === undefined
      ? undefined
      : edit.parent === null || edit.parent === ''
        ? null
        : typeof edit.parent === 'string'
          ? resolveGroupName(edit.parent.trim())
          : '';
  if (parent === '') throw new AccessInputError('parent must be a group name');
  const outcome = await writeFilesOrCommand(
    serverId,
    () => groupInFile(serverId, name, permissions, BUILTIN_GROUPS.has(name) ? undefined : parent),
    () =>
      groupByCommand(serverId, name, permissions, BUILTIN_GROUPS.has(name) ? undefined : parent),
  );
  return { ...outcome, view: await getPermissions(serverId) };
}

/** Deletes a group; players that name it keep the name (it then grants nothing). */
export async function deleteGroup(
  serverId: string | undefined,
  rawName: string,
): Promise<WriteOutcome<PermissionsView>> {
  const name = resolveGroupName(rawName.trim());
  // The same check as saveGroup and the operator check: a name of another form is refused.
  if (!isGroupNameInput(name)) throw new AccessInputError('A group name is required');
  if (BUILTIN_GROUPS.has(name)) {
    throw new AccessInputError(`${name} is built into the server and cannot be deleted`);
  }
  const outcome = await writeFilesOrCommand(
    serverId,
    async (): Promise<WriteResult> => {
      await migrateAccessFiles(serverId, { serverStopped: true });
      const files = await accessFiles(serverId);
      let changed = false;
      await updateServerJson(files.permissions, files.serverPath, (current) => {
        const next = withoutGroup(current, name);
        changed = JSON.stringify(next) !== JSON.stringify(current ?? {});
        return changed ? next : undefined;
      });
      return { via: 'file', verified: true, changed };
    },
    async (): Promise<WriteResult> => {
      const viaPlugin = (await liveGroup(serverId, name)) !== undefined;
      const state = await groupState(serverId, name, viaPlugin);
      if (!state) return { via: viaPlugin ? 'plugin' : 'stdin', verified: true, changed: false };
      // The server drops a group once it has neither permissions nor a parent;
      // a parent (or a group that is already empty) only a stopped server can remove.
      if (state.parent || state.permissions.length === 0) {
        throw new AccessError(
          409,
          'The server has no command to delete this group (it inherits from another group or has no permissions); stop the server to delete it.',
          'needs_stopped_server',
        );
      }
      const via = await runAll(
        serverId,
        state.permissions.map((p) => accessCommand.groupPermission('remove', name, p)),
      );
      const verified = await waitFor(
        async () => (await groupState(serverId, name, via === 'plugin')) === null,
      );
      return { via, verified, changed: true };
    },
  );
  return { ...outcome, view: await getPermissions(serverId) };
}

// ------------------------------------------------------------
// Operator rights
// ------------------------------------------------------------

export interface OperatorDecision {
  needed: boolean;
  /** The player a user change was decided for; the change must go to the same one. */
  uuid?: string;
}

/**
 * needsOperatorRight (accessOperator) against the server's current groups,
 * and for a player against what the change itself will start from: the same
 * UUID the change resolves to, and its state as the write reads it (the
 * plugin's answer while the server runs, else permissions.json).
 */
export async function operatorRightNeeded(
  serverId: string | undefined,
  change: AccessChange,
): Promise<OperatorDecision> {
  const permissions = await getPermissions(serverId);
  // The players come from permissions.json; one the server cannot read may leave some out.
  const view = { ...permissions, usersComplete: !permissions.problems.some((p) => p.fatal) };
  if (change.kind === 'group' || change.kind === 'deleteGroup') {
    return { needed: needsOperatorRight(view, change) };
  }
  const uuid = requireUuid(await resolvePlayer(serverId, change.player, { askPlugin: true }));
  // Like userByCommand: the plugin's answer first while the server may run.
  const live = view.serverRunning !== false ? await currentUser(serverId, uuid, true) : null;
  const current = live ?? (await currentUser(serverId, uuid, false))!;
  return { needed: needsOperatorRight(view, operatorChangeOf(change, current)), uuid };
}
