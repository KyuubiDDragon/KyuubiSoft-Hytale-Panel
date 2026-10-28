/**
 * The whitelist of a Hytale 0.7 server: the RequireJoinPermission switch plus
 * the players that hold the join permission themselves. Members of a group
 * that grants it (a wildcard, as hytale:Admin has) may join without an entry.
 * See accessContext for where it is read from and written to.
 */
import * as kyuubiApi from './kyuubiApi.js';
import {
  loadPlayerDirectory,
  resolvePlayer,
  type PlayerDirectory,
  type ResolvedPlayer,
} from './accessDirectory.js';
import { accessFiles, readServerJson, regularFileExists, updateServerJson } from './accessFiles.js';
import {
  JOIN_PERMISSION,
  groupDecides,
  isUuid,
  readLegacyWhitelist,
  readPermissions,
  readRequireJoinPermission,
  withRequireJoinPermission,
  withUserAccess,
  type PermissionsData,
} from './accessFormats.js';
import { accessCommand, answered, runAccessCommand } from './accessCommands.js';
import {
  AccessError,
  commandFailure,
  commandTarget,
  describeAccessError,
  requireUuid,
  serverRunningOrNull,
  waitFor,
  writeFilesOrCommand,
  type AccessViewBase,
  type WriteOutcome,
} from './accessContext.js';
import { migrateAccessFiles } from './accessMigration.js';

export interface WhitelistEntryView {
  uuid: string;
  name?: string;
  online?: boolean;
}

export interface WhitelistView extends AccessViewBase {
  enabled: boolean;
  entries: WhitelistEntryView[];
  /** Names (the UUID where no name is known), as clients from before 0.7 read it. */
  list: string[];
  /** Groups whose members may join without an entry. */
  openGroups: string[];
  /** A whitelist.json from before 0.7 the server has not applied yet. */
  legacy?: { enabled: boolean; entries: number; unresolved: string[] };
}

type WriteResult = Omit<WriteOutcome<WhitelistView>, 'view'>;

/** Groups whose members may join (the group or a parent decides the join permission). */
export function openGroupsOf(
  groups: PermissionsData['groups'] | kyuubiApi.LivePermissionGroup[],
  virtualGroups?: Record<string, string[]>,
): string[] {
  return groups
    .filter((g) => groupDecides(groups, g.name, JOIN_PERMISSION, virtualGroups) === true)
    .map((g) => g.name);
}

function namedEntries(
  entries: WhitelistEntryView[],
  directory: PlayerDirectory,
): WhitelistEntryView[] {
  return entries
    .map((e) => {
      const uuid = e.uuid.toLowerCase();
      return { ...e, uuid, name: e.name ?? directory.nameOf(uuid) };
    })
    .sort((a, b) => (a.name ?? `~${a.uuid}`).localeCompare(b.name ?? `~${b.uuid}`));
}

async function legacyInfo(
  serverId: string | undefined,
  directory: PlayerDirectory,
): Promise<WhitelistView['legacy']> {
  const files = await accessFiles(serverId);
  if (!(await regularFileExists(files.legacyWhitelist))) return undefined;
  const legacy = readLegacyWhitelist(await readServerJson(files.legacyWhitelist, files.serverPath));
  if (!legacy) return { enabled: true, entries: 0, unresolved: [] };
  return {
    enabled: legacy.enabled,
    entries: legacy.entries.length,
    unresolved: legacy.entries
      .filter((e) => !e.uuid && !directory.uuidOf(e.value))
      .map((e) => e.value),
  };
}

async function fileWhitelist(serverId?: string) {
  const files = await accessFiles(serverId);
  const [config, permissionsRaw] = await Promise.all([
    readServerJson(files.config, files.serverPath),
    readServerJson(files.permissions, files.serverPath),
  ]);
  const permissions = readPermissions(permissionsRaw);
  return {
    enabled: readRequireJoinPermission(config),
    uuids: permissions.users
      .filter((u) => u.permissions.includes(JOIN_PERMISSION))
      .map((u) => u.uuid),
    permissions,
  };
}

/** The plugin's whitelist, or null when it does not answer (or answers something else). */
async function liveWhitelist(serverId?: string) {
  const live = await kyuubiApi.getWhitelistFromPlugin(serverId);
  const data = live.success ? live.data : undefined;
  if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.entries)) return null;
  const entries = data.entries
    .filter((e) => isUuid(e?.uuid))
    .map((e) => ({
      uuid: e.uuid.toLowerCase(),
      ...(typeof e.name === 'string' ? { name: e.name } : {}),
      online: e.online === true,
    }));
  return { enabled: data.enabled, entries };
}

export async function getWhitelist(serverId?: string): Promise<WhitelistView> {
  const serverRunning = await serverRunningOrNull(serverId);
  const live = serverRunning ? await liveWhitelist(serverId) : null;
  // With the live answer at hand, a file the panel cannot read is reported, not fatal.
  let fileError: string | undefined;
  const [directory, file] = await Promise.all([
    loadPlayerDirectory(serverId, { askPlugin: live !== null }),
    fileWhitelist(serverId).catch((error: unknown) => {
      if (!live) throw error;
      fileError = describeAccessError(error).error;
      return null;
    }),
  ]);
  const legacy = await legacyInfo(serverId, directory).catch(() => undefined);

  let openGroups = openGroupsOf(file?.permissions.groups ?? []);
  if (live) {
    const groups = await kyuubiApi.getPermissionGroupsFromPlugin(serverId);
    if (groups.success && Array.isArray(groups.data?.groups)) {
      openGroups = openGroupsOf(groups.data.groups, groups.data.virtualGroups ?? {});
    }
  }
  const entries = namedEntries(
    live ? live.entries : (file?.uuids ?? []).map((uuid) => ({ uuid })),
    directory,
  );
  return {
    enabled: live ? live.enabled : (file?.enabled ?? false),
    entries,
    list: entries.map((e) => e.name ?? e.uuid),
    openGroups,
    source: live ? 'live' : 'file',
    serverRunning,
    problems: fileError
      ? [{ fatal: true, where: 'files', detail: fileError }]
      : (file?.permissions.problems ?? []),
    ...(legacy ? { legacy } : {}),
  };
}

async function switchInFile(serverId: string | undefined, enabled: boolean): Promise<WriteResult> {
  await migrateAccessFiles(serverId, { serverStopped: true });
  const files = await accessFiles(serverId);
  if (!(await regularFileExists(files.config))) {
    throw new AccessError(
      409,
      'The server has not written config.json yet. Start it once, then change the whitelist.',
      'file_missing',
    );
  }
  let changed = false;
  await updateServerJson(files.config, files.serverPath, (current) => {
    if (readRequireJoinPermission(current) === enabled) return undefined;
    changed = true;
    return withRequireJoinPermission(current, enabled);
  });
  return { via: 'file', verified: true, changed };
}

async function switchByCommand(
  serverId: string | undefined,
  enabled: boolean,
): Promise<WriteResult> {
  const result = await runAccessCommand(accessCommand.whitelistSwitch(enabled), serverId);
  if (result.kind === 'rejected' || result.kind === 'failed') throw commandFailure(result);
  if (answered(result, '.saveFailed')) {
    throw new AccessError(500, 'The server could not save config.json', 'rejected');
  }
  const viaPlugin = result.kind === 'done' || result.via === 'plugin';
  const verified = await waitFor(async () =>
    viaPlugin
      ? (await liveWhitelist(serverId))?.enabled === enabled
      : (await fileWhitelist(serverId)).enabled === enabled,
  );
  return {
    via: viaPlugin ? 'plugin' : 'stdin',
    verified,
    changed: !answered(result, '.alreadyEnabled', '.alreadyDisabled'),
  };
}

/** Turns the whitelist (RequireJoinPermission) on or off. */
export async function setWhitelistEnabled(
  serverId: string | undefined,
  enabled: boolean,
): Promise<WriteOutcome<WhitelistView>> {
  const outcome = await writeFilesOrCommand(
    serverId,
    () => switchInFile(serverId, enabled),
    () => switchByCommand(serverId, enabled),
  );
  return { ...outcome, view: await getWhitelist(serverId) };
}

async function entryInFile(
  serverId: string | undefined,
  input: string,
  add: boolean,
): Promise<WriteResult> {
  const uuid = requireUuid(await resolvePlayer(serverId, input));
  await migrateAccessFiles(serverId, { serverStopped: true });
  const files = await accessFiles(serverId);
  let changed = false;
  await updateServerJson(files.permissions, files.serverPath, (current) => {
    const user = readPermissions(current).users.find((u) => u.uuid === uuid);
    if ((user?.permissions.includes(JOIN_PERMISSION) ?? false) === add) return undefined;
    changed = true;
    return withUserAccess(
      current,
      uuid,
      add ? { addPermissions: [JOIN_PERMISSION] } : { removePermissions: [JOIN_PERMISSION] },
    );
  });
  return { via: 'file', verified: true, changed };
}

async function entryByCommand(
  serverId: string | undefined,
  target: ResolvedPlayer,
  add: boolean,
): Promise<WriteResult> {
  // A known UUID goes through /perm, which needs no profile lookup; a name the
  // panel does not know is left to the server to resolve.
  const player = commandTarget(target);
  const uuid = target.uuid;
  const granted = async (viaPlugin: boolean) => {
    const entries = viaPlugin
      ? (await liveWhitelist(serverId))?.entries.map((e) => e.uuid)
      : (await fileWhitelist(serverId)).uuids;
    return entries === undefined ? undefined : entries.includes(uuid!);
  };
  if (uuid) {
    // /perm answers the same whether or not the grant was there, so look first.
    const live = await liveWhitelist(serverId);
    const before = live ? live.entries.some((e) => e.uuid === uuid) : await granted(false);
    if (before === add) return { via: live ? 'plugin' : 'stdin', verified: true, changed: false };
  }
  const command = uuid
    ? add
      ? accessCommand.grantJoin(uuid)
      : accessCommand.revokeJoin(uuid)
    : add
      ? accessCommand.whitelistAdd(player)
      : accessCommand.whitelistRemove(player);
  const result = await runAccessCommand(command, serverId);
  if (result.kind === 'rejected' || result.kind === 'failed') {
    throw commandFailure(
      result,
      uuid
        ? undefined
        : 'A player who is not online can only be found by a signed-in server; or use the UUID.',
    );
  }
  const viaPlugin = result.kind === 'done' || result.via === 'plugin';
  let verified = result.kind === 'done';
  if (uuid) verified = await waitFor(async () => (await granted(viaPlugin)) === add);
  return {
    via: viaPlugin ? 'plugin' : 'stdin',
    verified,
    changed: !answered(result, '.alreadyWhitelisted', '.uuidNotWhitelisted'),
    message: result.message || undefined,
  };
}

async function changeEntry(
  serverId: string | undefined,
  input: string,
  add: boolean,
): Promise<WriteOutcome<WhitelistView>> {
  const outcome = await writeFilesOrCommand(
    serverId,
    () => entryInFile(serverId, input, add),
    async () =>
      entryByCommand(serverId, await resolvePlayer(serverId, input, { askPlugin: true }), add),
  );
  return { ...outcome, view: await getWhitelist(serverId) };
}

/** Gives a player (name or UUID) the join permission. */
export function addToWhitelist(serverId: string | undefined, player: string) {
  return changeEntry(serverId, player, true);
}

/** Takes the player's own join permission back (a group may still let them in). */
export function removeFromWhitelist(serverId: string | undefined, player: string) {
  return changeEntry(serverId, player, false);
}
