/**
 * Player names and UUIDs as far as the panel knows them, for the access
 * pages: the server's files hold UUIDs only, and while it is stopped (or the
 * plugin is missing) the panel has to name them, and to turn a name an admin
 * typed into the UUID the server needs.
 *
 * Sources, most trusted first:
 *  1. players online right now (the plugin's sessions)
 *  2. the server's saved players (universe/players/<uuid>.json)
 *  3. the panel's player history (from the server log)
 *  4. the name files the panel kept next to the access files before 0.7
 *     (permissions-names.json, bans-names.json)
 * A name that more than one UUID carries in the same source is ambiguous and
 * never resolved; a more trusted source decides for the names it knows.
 */
import path from 'path';
import { getAllPlayerFiles, getPlayerHistory } from './players.js';
import { getSessionsFromPlugin } from './kyuubiApi.js';
import { readServerJson } from './accessFiles.js';
import { resolveInstallPaths } from './serverInstall.js';
import { isObject, isUuid } from './accessFormats.js';
import { AccessInputError } from './accessCommands.js';
import { isValidPlayerName } from '../utils/sanitize.js';

export interface DirectoryEntry {
  uuid: string;
  name: string;
}

export interface PlayerDirectory {
  nameOf(uuid: string): string | undefined;
  /** undefined: unknown; null: more than one UUID carries this name. */
  uuidOf(name: string): string | null | undefined;
  /** Known names that start with `name` and are longer (case-insensitive). */
  longerNamesOf(name: string): string[];
}

const LEGACY_NAME_FILES = ['permissions-names.json', 'bans-names.json'];
const CACHE_MS = 30_000;

/** A directory from sources ordered most trusted first. */
export function buildPlayerDirectory(sources: Iterable<DirectoryEntry>[]): PlayerDirectory {
  const names = new Map<string, string>();
  const uuids = new Map<string, string | null>();
  for (const source of sources) {
    const seen = new Map<string, Set<string>>();
    for (const { uuid, name } of source) {
      if (!isUuid(uuid) || !name) continue;
      const id = uuid.toLowerCase();
      if (!names.has(id)) names.set(id, name);
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key)!.add(id);
    }
    for (const [key, ids] of seen) {
      if (uuids.has(key)) continue;
      uuids.set(key, ids.size === 1 ? [...ids][0] : null);
    }
  }
  const allNames = [...new Set(names.values())];
  return {
    nameOf: (uuid) => names.get(uuid.toLowerCase()),
    uuidOf: (name) => uuids.get(name.toLowerCase()),
    longerNamesOf: (name) => {
      const prefix = name.toLowerCase();
      return allNames.filter((n) => n.length > prefix.length && n.toLowerCase().startsWith(prefix));
    },
  };
}

/** Entries of an old panel name file: `{ <uuid>: <name> }` (other keys are ignored). */
export function legacyNameEntries(raw: unknown): DirectoryEntry[] {
  if (!isObject(raw)) return [];
  return Object.entries(raw)
    .filter((e): e is [string, string] => isUuid(e[0]) && typeof e[1] === 'string')
    .map(([uuid, name]) => ({ uuid, name }));
}

interface CachedSources {
  at: number;
  sources: DirectoryEntry[][];
}
const cache = new Map<string, CachedSources>();

async function savedSources(serverId?: string): Promise<DirectoryEntry[][]> {
  const key = serverId ?? '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.sources;

  const { serverPath } = await resolveInstallPaths(serverId);
  const [files, history, ...legacy] = await Promise.all([
    getAllPlayerFiles(serverId).catch(() => []),
    getPlayerHistory(serverId).catch(() => []),
    ...LEGACY_NAME_FILES.map((name) =>
      readServerJson(path.join(serverPath, name), serverPath)
        .then(legacyNameEntries)
        .catch(() => [] as DirectoryEntry[]),
    ),
  ]);
  const fromHistory = history
    .filter((p) => p.uuid)
    .map((p) => ({ uuid: p.uuid as string, name: p.name }));
  const sources = [files, fromHistory, legacy.flat()];
  cache.set(key, { at: Date.now(), sources });
  return sources;
}

/**
 * The directory for a server. `online` adds the players online right now;
 * without it the plugin is asked when `askPlugin` is set.
 */
export async function loadPlayerDirectory(
  serverId?: string,
  options: { online?: DirectoryEntry[]; askPlugin?: boolean } = {},
): Promise<PlayerDirectory> {
  let online = options.online ?? [];
  if (!options.online && options.askPlugin) {
    const sessions = await getSessionsFromPlugin(serverId).catch(() => null);
    if (sessions?.success && sessions.data) {
      online = sessions.data.sessions.map((s) => ({ uuid: s.uuid, name: s.name }));
    }
  }
  return buildPlayerDirectory([online, ...(await savedSources(serverId))]);
}

export interface ResolvedPlayer {
  /** What was typed: a player name or a UUID. */
  input: string;
  uuid?: string;
  name?: string;
  /** The name belongs to more than one known UUID. */
  ambiguous?: boolean;
  /**
   * For a name without a known UUID: known players whose names start with it.
   * The server matches names by prefix, so it could pick one of them.
   */
  longerNames?: string[];
}

/** A name or UUID typed by an admin, with what the panel knows about it. */
export async function resolvePlayer(
  serverId: string | undefined,
  input: unknown,
  options: { askPlugin?: boolean } = {},
): Promise<ResolvedPlayer> {
  const text = typeof input === 'string' ? input.trim() : '';
  if (isUuid(text)) {
    const directory = await loadPlayerDirectory(serverId, options);
    const uuid = text.toLowerCase();
    return { input: uuid, uuid, name: directory.nameOf(uuid) };
  }
  if (!isValidPlayerName(text)) throw new AccessInputError('A player name or UUID is required');
  const directory = await loadPlayerDirectory(serverId, options);
  const uuid = directory.uuidOf(text);
  if (uuid === null) return { input: text, name: text, ambiguous: true };
  if (uuid) return { input: text, uuid, name: text };
  return { input: text, name: text, longerNames: directory.longerNamesOf(text) };
}

/** Forget cached names, e.g. after a test changed the sources. */
export function clearPlayerDirectoryCache(): void {
  cache.clear();
}
