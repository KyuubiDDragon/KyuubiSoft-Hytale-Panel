/**
 * World configs of a server (universe/worlds/<name>/config.json) and the
 * other JSON files of a world folder, for the world editor.
 *
 * Files are found across the server's worlds roots and only used when they are
 * regular files inside that root (utils/serverFiles.ts). The server keeps the
 * config of a loaded world in memory and writes it back, so the editor only
 * writes while the server is stopped (services/serverConfigWrite.ts); PvP and
 * the time pause have world commands, which the panel runs through the
 * KyuubiSoft API plugin and checks against the server's answer.
 */
import path from 'path';
import { getServerContext, worldRoots } from './serverContext.js';
import { runCommandViaPlugin, type PluginCommandAttempt } from './pluginCommands.js';
import { readServerFile } from '../utils/serverFiles.js';
import { UnsafeFileError } from '../utils/noFollowFs.js';
import { resolveRealPath } from '../utils/pathSecurity.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// World names the server's world argument takes without quoting.
const COMMAND_SAFE_WORLD = /^[A-Za-z0-9_-]{1,64}$/;

/** A world folder name the routes accept. */
export function isValidWorldName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 128 &&
    name !== '.' &&
    !name.includes('..') &&
    !/[/\\]/.test(name) &&
    !CONTROL_CHARS.test(name)
  );
}

/**
 * A JSON file of a world the editor may open: the folder's own JSON files or
 * one level down in resources/. Returns the normalized relative path or null.
 */
export function worldJsonPath(relFile: unknown): string | null {
  if (typeof relFile !== 'string' || !relFile.toLowerCase().endsWith('.json')) return null;
  if (relFile.includes('..') || relFile.includes('\\') || CONTROL_CHARS.test(relFile)) return null;
  const parts = relFile.split('/');
  if (parts.some((p) => p.length === 0)) return null;
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== 'resources')) return null;
  return parts.join('/');
}

export interface WorldFileLocation {
  file: string;
  /** The worlds root the file must stay in (its real path when it was found). */
  root: string;
  content: string;
}

/**
 * The first worlds root of the server (`undefined` = the default server) that
 * holds `<world>/<relFile>` as a regular file. A candidate that is a link or
 * lies outside its root is skipped; when no root has a usable file, the first
 * such refusal is thrown so the user learns why.
 */
export async function locateWorldFile(
  worldName: string,
  relFile: string,
  serverId?: string,
): Promise<WorldFileLocation | null> {
  let refused: UnsafeFileError | null = null;
  for (const worldsRoot of worldRoots(await getServerContext(serverId))) {
    // The real path, fixed now: the root may lie behind a link the game server
    // controls (server/universe). Resolved again at write time, a link swapped
    // meanwhile would make it another server's worlds folder.
    const root = resolveRealPath(worldsRoot) ?? worldsRoot;
    const file = path.join(worldsRoot, worldName, relFile);
    try {
      const found = await readServerFile(file, [root]);
      if (found) return { file, root, content: found.content };
    } catch (error) {
      if (!(error instanceof UnsafeFileError)) throw error;
      console.warn(`[SECURITY] Ignoring world file ${file}: ${error.why}`);
      refused ??= error;
    }
  }
  if (refused) throw refused;
  return null;
}

// ---------------------------------------------------------------------------
// Live changes through the plugin
// ---------------------------------------------------------------------------

export interface WorldLiveResult {
  key: string;
  ok: boolean;
  message: string;
}

export type WorldLiveOutcome =
  | { kind: 'applied'; results: WorldLiveResult[] }
  /** Nothing was changed: the plugin is not reachable or the name needs quoting. */
  | { kind: 'unavailable'; reason: string };

function replyText(attempt: PluginCommandAttempt): string {
  if (attempt.kind === 'reply') {
    return attempt.reply.output.join(' ').trim() || attempt.reply.error || attempt.reply.status;
  }
  return attempt.kind === 'unavailable' ? attempt.reason : attempt.error;
}

const replyHas = (attempt: PluginCommandAttempt, id: string) =>
  attempt.kind === 'reply' && attempt.reply.ok && attempt.reply.messageIds.includes(id);

const PVP_APPLIED = 'server.universe.setpvp.info';
const TIME_PAUSED = 'server.commands.pausetime.timeInfo';
const TIME_RESUMED = 'server.commands.pausetime.timeInfoResumed';

type Run = (command: string) => Promise<PluginCommandAttempt>;

async function setPvp(run: Run, world: string, value: boolean): Promise<WorldLiveResult> {
  const attempt = await run(`/world config pvp ${value} --world ${world}`);
  return { key: 'IsPvpEnabled', ok: replyHas(attempt, PVP_APPLIED), message: replyText(attempt) };
}

/**
 * `/world config pausetime` only toggles; its answer says the new state. When
 * the server's state was already the wanted one, toggle back once.
 */
async function setTimePaused(run: Run, world: string, value: boolean): Promise<WorldLiveResult> {
  const wanted = value ? TIME_PAUSED : TIME_RESUMED;
  const other = value ? TIME_RESUMED : TIME_PAUSED;
  let attempt = await run(`/world config pausetime --world ${world}`);
  if (replyHas(attempt, other)) attempt = await run(`/world config pausetime --world ${world}`);
  return { key: 'IsGameTimePaused', ok: replyHas(attempt, wanted), message: replyText(attempt) };
}

const LIVE_SETTERS: Readonly<
  Record<string, (run: Run, world: string, value: boolean) => Promise<WorldLiveResult>>
> = {
  IsPvpEnabled: setPvp,
  IsGameTimePaused: setTimePaused,
};

// The server writes a changed world config back every 10 seconds; until then
// the file still shows the old value of a live change. Remembered well past
// that, so a quick second change is compared with what the server now uses.
const RECENT_LIVE_MS = 60_000;
// Per server and world: two servers may both have a world of the same name.
const recentLive = new Map<string, Map<string, { value: unknown; at: number }>>();
const liveKey = (serverId: string, worldName: string) => `${serverId}\0${worldName}`;

export function rememberLiveValues(
  serverId: string,
  worldName: string,
  values: Record<string, unknown>,
): void {
  const key = liveKey(serverId, worldName);
  const entries = new Map(recentLive.get(key));
  for (const [field, value] of Object.entries(values)) {
    entries.set(field, { value, at: Date.now() });
  }
  recentLive.set(key, entries);
}

/** The config with the live changes of the last minute laid over it. */
export function withRecentLiveValues(
  serverId: string,
  worldName: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const key = liveKey(serverId, worldName);
  const entries = recentLive.get(key);
  if (!entries) return config;
  const next = { ...config };
  for (const [field, entry] of entries) {
    if (Date.now() - entry.at > RECENT_LIVE_MS) entries.delete(field);
    else next[field] = entry.value;
  }
  if (entries.size === 0) recentLive.delete(key);
  return next;
}

/**
 * Forget remembered live values (the server stopped and wrote its state): of
 * one world, of every world of a server, or without arguments all of them.
 */
export function forgetLiveValues(serverId?: string, worldName?: string): void {
  if (serverId === undefined) {
    recentLive.clear();
  } else if (worldName !== undefined) {
    recentLive.delete(liveKey(serverId, worldName));
  } else {
    for (const key of [...recentLive.keys()]) {
      if (key.startsWith(`${serverId}\0`)) recentLive.delete(key);
    }
  }
}

/**
 * Applies the given keys of a world config on the running server and checks
 * each answer. A failure does not stop the rest.
 */
export async function applyLiveWorldSettings(
  worldName: string,
  values: Record<string, unknown>,
  serverId: string | undefined,
  actor: string | undefined,
): Promise<WorldLiveOutcome> {
  if (!COMMAND_SAFE_WORLD.test(worldName)) {
    return { kind: 'unavailable', reason: 'the world name cannot be used in a command' };
  }
  // The plugin turning down the very first command means nothing was changed.
  const state = { reached: false, unavailable: null as string | null };
  const run: Run = async (command) => {
    const attempt = await runCommandViaPlugin(command, serverId, { actor });
    if (attempt.kind === 'unavailable' && !state.reached) state.unavailable = attempt.reason;
    else state.reached = true;
    return attempt;
  };
  const results: WorldLiveResult[] = [];
  for (const [key, value] of Object.entries(values)) {
    const setter = LIVE_SETTERS[key];
    if (!setter || typeof value !== 'boolean') continue;
    const result = await setter(run, worldName, value);
    if (!state.reached && state.unavailable !== null) {
      return { kind: 'unavailable', reason: state.unavailable };
    }
    results.push(result);
  }
  return { kind: 'applied', results };
}
