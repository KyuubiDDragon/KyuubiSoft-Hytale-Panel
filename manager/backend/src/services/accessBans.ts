/**
 * The ban list of a Hytale 0.7 server (bans.json, or the file config.json
 * names). See accessContext for where it is read from and written to.
 *
 * /ban and /unban resolve the player through the connected players or the
 * profile service, so a server that is not signed in can only ban players
 * who are online. With the server stopped the panel edits the file instead.
 */
import * as kyuubiApi from './kyuubiApi.js';
import { loadPlayerDirectory, resolvePlayer, type PlayerDirectory } from './accessDirectory.js';
import { accessFiles, readServerJson, updateServerJson } from './accessFiles.js';
import {
  CONSOLE_UUID,
  NO_REASON,
  canonicalUuid,
  readBans,
  withBan,
  withoutBan,
  type BanRecord,
} from './accessFormats.js';
import { accessCommand, answered, banReasonText, runAccessCommand } from './accessCommands.js';
import {
  AccessError,
  commandFailure,
  commandTarget,
  requireUuid,
  serverRunningOrNull,
  waitFor,
  writeFilesOrCommand,
  type AccessViewBase,
  type WriteOutcome,
} from './accessContext.js';
import { migrateAccessFiles } from './accessMigration.js';

export interface BanView {
  /** The name where it is known, else the UUID. */
  player: string;
  target?: string;
  name?: string;
  reason?: string;
  bannedAt?: string;
  /** "Console", a name or a UUID. */
  bannedBy?: string;
  expiresOn?: string;
  permanent: boolean;
  inEffect: boolean;
  /** false: the server cannot read the entry; it still keeps the player out. */
  readable: boolean;
}

export interface BansView extends AccessViewBase {
  bans: BanView[];
  /** Why the panel cannot read the bans itself (config.json keeps them elsewhere). */
  unsupported?: string;
}

/** A ban or unban, with the player it went to as far as the panel knows them. */
export interface BanOutcome extends WriteOutcome<BansView> {
  uuid?: string;
  name?: string;
}

type WriteResult = Omit<BanOutcome, 'view'>;

const SERVER_HINT =
  'A server that is not signed in can only find players who are online; stop the server to change the ban list in its file.';

function toView(
  ban: BanRecord & { targetName?: string; byName?: string },
  directory: PlayerDirectory,
): BanView {
  const name = ban.targetName ?? (ban.target ? directory.nameOf(ban.target) : undefined);
  const by =
    ban.by === CONSOLE_UUID
      ? 'Console'
      : (ban.byName ?? (ban.by ? (directory.nameOf(ban.by) ?? ban.by) : undefined));
  return {
    player: name ?? ban.target ?? '?',
    target: ban.target,
    name,
    reason: ban.reason && ban.reason !== NO_REASON ? ban.reason : undefined,
    bannedAt: ban.timestamp,
    bannedBy: by,
    expiresOn: ban.expiresOn,
    permanent: !ban.expiresOn,
    inEffect: ban.inEffect,
    readable: ban.readable,
  };
}

async function fileBans(serverId?: string) {
  const files = await accessFiles(serverId);
  if (!files.bans) return { files, data: null };
  return { files, data: readBans(await readServerJson(files.bans, files.serverPath)) };
}

/** The plugin's ban list, or null when it does not answer (or answers something else). */
async function liveBans(serverId?: string) {
  const live = await kyuubiApi.getBansFromPlugin(serverId);
  const data = live.success ? live.data : undefined;
  if (!data || !Array.isArray(data.entries)) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    entries: data.entries
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({
        target: canonicalUuid(b.target) ?? undefined,
        targetName: text(b.targetName),
        by: canonicalUuid(b.by) ?? undefined,
        byName: text(b.byName),
        timestamp: text(b.timestamp),
        expiresOn: text(b.expiresOn),
        reason: text(b.reason),
        inEffect: b.inEffect !== false,
      })),
  };
}

export async function getBans(serverId?: string): Promise<BansView> {
  const serverRunning = await serverRunningOrNull(serverId);
  const live = serverRunning ? await liveBans(serverId) : null;
  const directory = await loadPlayerDirectory(serverId, { askPlugin: live !== null });
  const base = { serverRunning, problems: [] as BansView['problems'] };

  if (live) {
    const bans = live.entries.map((b) => toView({ ...b, readable: true }, directory));
    return { ...base, source: 'live', bans };
  }
  const { files, data } = await fileBans(serverId);
  if (!data) return { ...base, source: 'file', bans: [], unsupported: files.bansUnsupported };
  return {
    ...base,
    source: 'file',
    problems: data.problems,
    bans: data.bans.map((b) => toView(b, directory)),
  };
}

async function bansFile(serverId?: string) {
  const files = await accessFiles(serverId);
  if (!files.bans) {
    throw new AccessError(
      409,
      `The panel cannot change the bans: ${files.bansUnsupported}`,
      'unsupported',
    );
  }
  return { files, bans: files.bans };
}

async function targetBanned(serverId: string | undefined, uuid: string, viaPlugin: boolean) {
  if (viaPlugin) {
    const live = await liveBans(serverId);
    if (!live) return null;
    return live.entries.some((b) => b.target === uuid && b.inEffect);
  }
  const { data } = await fileBans(serverId);
  return data ? data.bans.some((b) => b.target === uuid && b.inEffect) : null;
}

/** Whether the player is banned right now (live, else the file); null when the panel cannot tell. */
async function bannedNow(serverId: string | undefined, uuid: string): Promise<boolean | null> {
  try {
    return (
      (await targetBanned(serverId, uuid, true)) ?? (await targetBanned(serverId, uuid, false))
    );
  } catch {
    return null;
  }
}

async function banInFile(
  serverId: string | undefined,
  input: string,
  reason: string,
): Promise<WriteResult> {
  const target = await resolvePlayer(serverId, input);
  const uuid = requireUuid(target);
  await migrateAccessFiles(serverId, { serverStopped: true });
  const { files, bans } = await bansFile(serverId);
  let changed = false;
  await updateServerJson(bans, files.serverPath, (current) => {
    const next = withBan(current, { target: uuid, reason: reason || undefined });
    changed = next.added;
    return next.added ? next.data : undefined;
  });
  return { via: 'file', verified: true, changed, uuid, name: target.name };
}

async function unbanInFile(serverId: string | undefined, input: string): Promise<WriteResult> {
  const target = await resolvePlayer(serverId, input);
  const uuid = requireUuid(target);
  const { files, bans } = await bansFile(serverId);
  let changed = false;
  await updateServerJson(bans, files.serverPath, (current) => {
    if (current === null) return undefined;
    const next = withoutBan(current, uuid);
    changed = next.removed;
    return next.removed ? next.data : undefined;
  });
  return { via: 'file', verified: true, changed, uuid, name: target.name };
}

async function byCommand(
  serverId: string | undefined,
  input: string,
  ban: boolean,
  reason: string,
): Promise<WriteResult> {
  const target = await resolvePlayer(serverId, input, { askPlugin: true });
  // A UUID is the one thing the server resolves without doubt; a name it resolves itself.
  const player = commandTarget(target);
  // Over the console only the state before tells whether the command changed anything.
  const before = target.uuid ? await bannedNow(serverId, target.uuid) : null;
  const result = await runAccessCommand(
    ban ? accessCommand.ban(player, reason) : accessCommand.unban(player),
    serverId,
  );
  if (result.kind === 'rejected' || result.kind === 'failed')
    throw commandFailure(result, SERVER_HINT);
  const viaPlugin = result.kind === 'done' || result.via === 'plugin';
  let verified = result.kind === 'done';
  if (target.uuid) {
    const uuid = target.uuid;
    verified = await waitFor(async () => (await targetBanned(serverId, uuid, viaPlugin)) === ban);
  }
  return {
    via: viaPlugin ? 'plugin' : 'stdin',
    verified,
    changed: !answered(result, '.alreadyBanned', '.playerNotBanned') && before !== ban,
    message: result.message || undefined,
    uuid: target.uuid,
    name: target.name,
  };
}

/**
 * Bans a player (name or UUID); the server disconnects them if they are
 * online. `changed` is false when the player was banned already.
 */
export async function banPlayer(
  serverId: string | undefined,
  player: string,
  reason?: unknown,
): Promise<BanOutcome> {
  const text = banReasonText(reason);
  const outcome = await writeFilesOrCommand(
    serverId,
    () => banInFile(serverId, player, text),
    () => byCommand(serverId, player, true, text),
  );
  return { ...outcome, view: await getBans(serverId) };
}

export async function unbanPlayer(
  serverId: string | undefined,
  player: string,
): Promise<BanOutcome> {
  const outcome = await writeFilesOrCommand(
    serverId,
    () => unbanInFile(serverId, player),
    () => byCommand(serverId, player, false, ''),
  );
  return { ...outcome, view: await getBans(serverId) };
}

export interface CurrentBan {
  /** The banned player's UUID. */
  target: string;
  /** When the server recorded the ban (ISO); absent when it cannot read the entry. */
  bannedAt?: string;
}

/**
 * The ban in effect on a player right now, read where the server has it (live
 * from the plugin, else the ban file, which the server rewrites on every
 * change), or null when there is none.
 */
export async function currentBan(
  serverId: string | undefined,
  player: string,
): Promise<CurrentBan | null> {
  const uuid = requireUuid(await resolvePlayer(serverId, player, { askPlugin: true }));
  const running = await serverRunningOrNull(serverId);
  if (running === null) {
    throw new AccessError(
      503,
      'Docker cannot tell whether the server is running',
      'docker_unavailable',
    );
  }
  const live = running ? await liveBans(serverId) : null;
  let entries: { target?: string; timestamp?: string; inEffect: boolean }[];
  if (live) {
    entries = live.entries;
  } else {
    const { files, data } = await fileBans(serverId);
    if (!data)
      throw new AccessError(
        409,
        `The panel cannot read the bans: ${files.bansUnsupported}`,
        'unsupported',
      );
    entries = data.bans;
  }
  const ban = entries.find((b) => b.target === uuid && b.inEffect);
  return ban ? { target: uuid, bannedAt: ban.timestamp } : null;
}
