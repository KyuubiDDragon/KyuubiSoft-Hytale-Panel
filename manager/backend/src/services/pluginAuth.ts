/**
 * Auth token for the KyuubiSoft API plugin.
 *
 * Plugin 2.0.0 refuses every HTTP request and WebSocket upgrade without
 * `Authorization: Bearer <token>`. The panel owns that token: it generates one
 * random token per server, keeps it in its own data volume (plugin-tokens.json,
 * never in servers.json, which the API hands to the browser) and writes it
 * into the plugin's config file before each server start.
 *
 * Where the plugin reads its config:
 *  - 2.1.0+: its data directory, `<mods>/KyuubiDDragon_KyuubiSoftAPI/config.json`
 *    (the server's mods folder is the plugin's data root).
 *  - up to 2.0.x: `<server>/config/kyuubisoft-api/config.json`.
 * The panel always writes the new file. It keeps the old one up to date only
 * while it still matters: the file exists (2.1 moves it away on its first
 * start) or a jar older than 2.1.0 is installed. A new file starts from the
 * old one's keys, so port and CORS settings survive the move.
 *
 * Old 1.4.x plugins keep working: the panel also sets their `authEnabled`
 * flag, so they check the same header on HTTP.
 */
import {
  mkdir,
  readdir,
  stat,
  lstat,
  open,
  writeFile,
  constants as fsConstants,
} from 'fs/promises';
import type { Stats } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isDemoMode } from './demoData.js';
import { resolveRealPathWithin } from '../utils/pathSecurity.js';
import {
  getServer,
  listServers,
  onServerDeleted,
  resolveServerId,
  type ServerInstance,
} from './servers.js';
import {
  JsonFileCorruptError,
  readJsonFile,
  withFileLock,
  writeJsonAtomic,
} from '../utils/jsonStore.js';

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
const TOKENS_FILE = path.join(DATA_DIR, 'plugin-tokens.json');
// Copies of unreadable plugin configs: they may hold an old token, so they go
// to the panel's own volume instead of the server dir the game can read.
const CONFIG_BACKUP_DIR = path.join(DATA_DIR, 'plugin-config-backups');
const TOKEN_BYTES = 32;
const SECRET_FILE_MODE = 0o600;
// O_NOFOLLOW is POSIX only; on Windows (dev/tests) it is undefined.
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** The plugin's data directory name below the mods folder (`<Group>_<Name>`). */
export const PLUGIN_DATA_DIR_NAME = 'KyuubiDDragon_KyuubiSoftAPI';
/** Where plugin 2.1+ reads its config, relative to the server's mods dir. */
const PLUGIN_CONFIG_SEGMENTS = [PLUGIN_DATA_DIR_NAME, 'config.json'];
export const PLUGIN_CONFIG_RELATIVE_PATH = path.join(...PLUGIN_CONFIG_SEGMENTS);
/** Where plugins up to 2.0.x read it, relative to the server's working dir. */
const LEGACY_CONFIG_SEGMENTS = ['config', 'kyuubisoft-api', 'config.json'];
export const LEGACY_PLUGIN_CONFIG_RELATIVE_PATH = path.join(...LEGACY_CONFIG_SEGMENTS);
/** First plugin version that reads the config from its data directory. */
const DATA_DIR_CONFIG_SINCE: readonly [number, number, number] = [2, 1, 0];

/** A config file below a base dir the panel must not be lured out of. */
interface ConfigLocation {
  base: string;
  segments: readonly string[];
}

function primaryLocation(modsDir: string): ConfigLocation {
  return { base: modsDir, segments: PLUGIN_CONFIG_SEGMENTS };
}

function legacyLocation(serverDir: string): ConfigLocation {
  return { base: serverDir, segments: LEGACY_CONFIG_SEGMENTS };
}

function locationPath(loc: ConfigLocation): string {
  return path.join(loc.base, ...loc.segments);
}

/** The plugin config path is redirected (symlink) or not what it should be. */
export class UnsafePluginConfigPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePluginConfigPathError';
  }
}

interface TokenFile {
  schemaVersion: 1;
  tokens: Record<string, string>;
}

export interface PluginConfigWriteResult {
  ok: boolean;
  changed: boolean;
  path?: string;
  /** Set when the pre-2.1 config was kept up to date as well. */
  legacyPath?: string;
  error?: string;
}

// Tokens never change once issued, so a read-through cache is safe.
const tokenCache = new Map<string, string>();

function isTokenFile(value: unknown): value is TokenFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<TokenFile>;
  return (
    v.schemaVersion === 1 &&
    !!v.tokens &&
    typeof v.tokens === 'object' &&
    Object.values(v.tokens).every((t) => typeof t === 'string' && t.length > 0)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function generatePluginToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/** True for a KyuubiSoftAPI jar in a mods folder (any version, not disabled). */
export function isPluginJarFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.startsWith('kyuubisoftapi') && lower.endsWith('.jar');
}

/** Version of a KyuubiSoftAPI jar from its file name, or null when it has none. */
export function pluginJarVersion(fileName: string): [number, number, number] | null {
  const match = /^kyuubisoftapi-(\d+)\.(\d+)\.(\d+)/i.exec(fileName);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * True when one of these mods-folder entries is a plugin jar that still reads
 * the pre-2.1 config path. A jar without a version in its name counts as old.
 */
export function needsLegacyConfig(modsEntries: string[]): boolean {
  return modsEntries.filter(isPluginJarFile).some((jar) => {
    const version = pluginJarVersion(jar);
    if (!version) return true;
    for (let i = 0; i < 3; i++) {
      if (version[i] !== DATA_DIR_CONFIG_SINCE[i]) return version[i] < DATA_DIR_CONFIG_SINCE[i];
    }
    return false;
  });
}

/** Config path of plugin 2.1+ below the server's mods dir. */
export function pluginConfigPath(modsDir: string): string {
  return locationPath(primaryLocation(modsDir));
}

/** Config path of plugins up to 2.0.x below the server dir. */
export function legacyPluginConfigPath(serverDir: string): string {
  return locationPath(legacyLocation(serverDir));
}

/** Read the token file inside the lock; a damaged file counts as empty. */
async function readTokenFile(): Promise<TokenFile | null> {
  try {
    return await readJsonFile<TokenFile>(TOKENS_FILE, { isValid: isTokenFile });
  } catch (err) {
    if (!(err instanceof JsonFileCorruptError)) throw err;
    // Tokens can always be re-issued (each server picks up its new token on
    // the next start), so a damaged file must not block the plugin for good.
    const kept = err.backupPath ? `, old file kept as ${path.basename(err.backupPath)}` : '';
    console.error(
      `[PluginAuth] plugin-tokens.json is unreadable (${err.reason}); issuing new plugin tokens${kept}`,
    );
    return null;
  }
}

/** The server's plugin token; created and persisted on first use. */
export async function getPluginToken(serverId: string): Promise<string> {
  const cached = tokenCache.get(serverId);
  if (cached) return cached;

  await mkdir(DATA_DIR, { recursive: true });
  const token = await withFileLock(TOKENS_FILE, async () => {
    const current = await readTokenFile();
    const existing = current?.tokens[serverId];
    if (existing) return existing;
    const issued = generatePluginToken();
    const next: TokenFile = {
      schemaVersion: 1,
      tokens: { ...(current?.tokens ?? {}), [serverId]: issued },
    };
    await writeJsonAtomic(TOKENS_FILE, next, { mode: SECRET_FILE_MODE });
    return issued;
  });
  tokenCache.set(serverId, token);
  return token;
}

export async function deletePluginToken(serverId: string): Promise<void> {
  tokenCache.delete(serverId);
  await withFileLock(TOKENS_FILE, async () => {
    const current = await readTokenFile();
    if (!current?.tokens[serverId]) return;
    const { [serverId]: _removed, ...rest } = current.tokens;
    await writeJsonAtomic(
      TOKENS_FILE,
      { schemaVersion: 1, tokens: rest },
      { mode: SECRET_FILE_MODE },
    );
  });
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The server and mods dirs are shared with the game container, so a mod can
 * plant symlinks there to make the panel read or write elsewhere. Walk the
 * config's path below its base dir with lstat: no segment may be a symlink,
 * directories must be real directories (missing ones are created one level at
 * a time unless `create` is false) and an existing config must be a regular
 * file. The real path must still lie inside the base dir. Returns the config
 * path.
 */
async function preparePluginConfigPath(loc: ConfigLocation, create = true): Promise<string> {
  let current = loc.base;
  for (const [i, segment] of loc.segments.entries()) {
    current = path.join(current, segment);
    const isFile = i === loc.segments.length - 1;
    const rel = path.relative(loc.base, current);
    let st = await lstatOrNull(current);
    if (!st && !isFile && create) {
      await mkdir(current).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
      // Re-check: something else may have created the entry in between.
      st = await lstatOrNull(current);
    }
    if (st?.isSymbolicLink()) throw new UnsafePluginConfigPathError(`${rel} is a symlink`);
    if (st && (isFile ? !st.isFile() : !st.isDirectory())) {
      throw new UnsafePluginConfigPathError(
        `${rel} is not a regular ${isFile ? 'file' : 'directory'}`,
      );
    }
    if (!st && !create) break; // nothing there yet, nothing to redirect
  }
  if (create && !resolveRealPathWithin(current, [loc.base])) {
    throw new UnsafePluginConfigPathError(
      `${path.join(...loc.segments)} resolves outside its base directory`,
    );
  }
  return locationPath(loc);
}

/** Content of the config without following a symlink at the file itself; null if absent. */
async function readConfigNoFollow(configPath: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(configPath, fsConstants.O_RDONLY | NO_FOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return await fh.readFile('utf-8');
  } finally {
    await fh.close();
  }
}

/** Parse the plugin config; an unreadable one is copied to the panel volume (0600) and treated as empty. */
async function parseConfigOrBackup(
  configPath: string,
  raw: string | null,
): Promise<Record<string, unknown> | null> {
  if (raw === null || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    /* handled below; the parser message would quote the content (token) */
  }
  await mkdir(CONFIG_BACKUP_DIR, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const backup = path.join(CONFIG_BACKUP_DIR, `config.json.corrupt-${stamp}`);
  await writeFile(backup, raw, { mode: SECRET_FILE_MODE, flag: 'wx' });
  // The plugin cannot read it either and would stay locked; rewrite it.
  console.warn(
    `[PluginAuth] ${configPath} is unreadable; rewriting it with the panel token (copy kept as ${backup})`,
  );
  return null;
}

/**
 * Keys of the pre-2.1 config, to start a new data-dir config from. Null when
 * there is none or it cannot be read safely (symlinked, unparseable): the new
 * file then starts empty, the plugin uses its defaults.
 */
async function readLegacySeed(serverDir: string): Promise<Record<string, unknown> | null> {
  const loc = legacyLocation(serverDir);
  try {
    const configPath = await preparePluginConfigPath(loc, false);
    const raw = await readConfigNoFollow(configPath);
    if (raw === null || raw.trim() === '') return null;
    const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the pre-2.1 config exists as a regular file (not a link). */
async function legacyConfigExists(serverDir: string): Promise<boolean> {
  try {
    const st = await lstatOrNull(legacyPluginConfigPath(serverDir));
    return !!st && st.isFile();
  } catch {
    return false;
  }
}

/**
 * Put `token` into the plugin 2.1+ config below `modsDir`, keeping every
 * other key the operator set (port, position interval, CORS allowlist, …).
 * When the file does not exist yet it starts from `seed` (the pre-2.1
 * config's keys). Returns changed:false when the file already holds the
 * token. Throws UnsafePluginConfigPathError, without writing, when the path is
 * redirected.
 */
export async function writePluginAuthConfig(
  modsDir: string,
  token: string,
  seed: Record<string, unknown> | null = null,
): Promise<{ changed: boolean }> {
  return writeConfigAt(primaryLocation(modsDir), token, seed);
}

/** Same for the pre-2.1 config below `serverDir`, read by plugins up to 2.0.x. */
export async function writeLegacyPluginAuthConfig(
  serverDir: string,
  token: string,
): Promise<{ changed: boolean }> {
  return writeConfigAt(legacyLocation(serverDir), token, null);
}

async function writeConfigAt(
  loc: ConfigLocation,
  token: string,
  seed: Record<string, unknown> | null,
): Promise<{ changed: boolean }> {
  const configPath = locationPath(loc);
  return withFileLock(configPath, async () => {
    await preparePluginConfigPath(loc);
    const raw = await readConfigNoFollow(configPath);
    const current = raw === null ? seed : await parseConfigOrBackup(configPath, raw);

    if (current?.insecureDisableAuth === true) {
      // The operator's explicit choice, so it stays; but say so on every start.
      console.warn(
        `[PluginAuth] ${configPath} sets insecureDisableAuth: the plugin API accepts requests without a token`,
      );
    }

    if (raw !== null && current?.authToken === token && current?.authEnabled === true) {
      return { changed: false };
    }

    // Check again right before writing to keep the window for a swap small.
    // The temp file is created with O_EXCL and renamed over the entry itself,
    // so a link planted at the file name is replaced, never followed.
    await preparePluginConfigPath(loc);
    // authEnabled only matters for 1.4.x plugins; 2.0.0 always requires the token.
    await writeJsonAtomic(
      configPath,
      { ...(current ?? {}), authEnabled: true, authToken: token },
      { mode: SECRET_FILE_MODE },
    );
    // A file created by an older plugin may be world-readable; it now holds a
    // secret. chmod through the descriptor, so a swapped-in link is not followed.
    const fh = await open(configPath, fsConstants.O_RDONLY | NO_FOLLOW).catch(() => null);
    if (fh) {
      await fh.chmod(SECRET_FILE_MODE).catch(() => {});
      await fh.close();
    }
    return { changed: true };
  });
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function modsEntries(modsDir: string): Promise<string[]> {
  try {
    return await readdir(modsDir);
  } catch {
    return [];
  }
}

async function ensureForServer(server: ServerInstance): Promise<PluginConfigWriteResult> {
  const { mods: modsDir, server: serverDir } = server.paths;
  if (!(await isDirectory(modsDir))) {
    return {
      ok: false,
      changed: false,
      error: `mods directory ${modsDir} is not reachable from the panel`,
    };
  }
  const token = await getPluginToken(server.id);
  const serverDirReachable = await isDirectory(serverDir);
  const legacyExists = serverDirReachable && (await legacyConfigExists(serverDir));

  // Plugin 2.1+: data-dir config, started from the old file's keys.
  const configPath = pluginConfigPath(modsDir);
  const seed = legacyExists ? await readLegacySeed(serverDir) : null;
  const { changed } = await writePluginAuthConfig(modsDir, token, seed);
  if (changed) console.log(`[PluginAuth:${server.id}] Plugin token written to ${configPath}`);
  const result: PluginConfigWriteResult = { ok: true, changed, path: configPath };

  // Plugins up to 2.0.x: keep their file current while it is still read.
  if (serverDirReachable && (legacyExists || needsLegacyConfig(await modsEntries(modsDir)))) {
    const legacyPath = legacyPluginConfigPath(serverDir);
    const legacy = await writeLegacyPluginAuthConfig(serverDir, token);
    if (legacy.changed) {
      console.log(`[PluginAuth:${server.id}] Plugin token written to ${legacyPath} (plugin < 2.1)`);
    }
    result.changed = result.changed || legacy.changed;
    result.legacyPath = legacyPath;
  }
  return result;
}

/**
 * Write the server's token into its plugin config. Called before every start
 * so the fresh server process loads it. Never throws: a failure must not keep
 * the server from starting (the plugin then stays locked and the status says so).
 */
export async function ensurePluginAuthConfig(serverId?: string): Promise<PluginConfigWriteResult> {
  if (isDemoMode()) return { ok: true, changed: false };
  let id = serverId ?? 'default';
  let result: PluginConfigWriteResult;
  try {
    id = await resolveServerId(serverId);
    const server = await getServer(id);
    result = server
      ? await ensureForServer(server)
      : { ok: false, changed: false, error: `unknown server id ${id}` };
  } catch (err) {
    result = { ok: false, changed: false, error: err instanceof Error ? err.message : String(err) };
    if (err instanceof UnsafePluginConfigPathError) {
      // Someone with write access to the server or mods dir tried to redirect the write.
      console.error(
        `[PluginAuth:${id}] SECURITY: refusing to write the plugin token, ${err.message}. ` +
          'Remove the link in the server or mods directory; the plugin stays locked until then.',
      );
      return result;
    }
  }
  if (!result.ok)
    console.warn(`[PluginAuth:${id}] Could not write the plugin token: ${result.error}`);
  return result;
}

/** Plugin installed or configured for this server? Only then is a config worth writing at boot. */
async function hasPluginFootprint(server: ServerInstance): Promise<boolean> {
  for (const configPath of [
    pluginConfigPath(server.paths.mods),
    legacyPluginConfigPath(server.paths.server),
  ]) {
    try {
      await stat(configPath);
      return true;
    } catch {
      /* no config there */
    }
  }
  return (await modsEntries(server.paths.mods)).some(isPluginJarFile);
}

let initialized = false;

/**
 * Boot hook: drop tokens of deleted servers and bring every installed
 * plugin's config up to date, so a start outside the panel (Docker restart
 * policy, host reboot) also loads the panel's token.
 */
export function initializePluginAuth(): void {
  if (initialized || isDemoMode()) return;
  initialized = true;
  onServerDeleted((serverId) => deletePluginToken(serverId));
  void (async () => {
    for (const server of await listServers()) {
      if (await hasPluginFootprint(server)) await ensurePluginAuthConfig(server.id);
    }
  })().catch((err) => console.error('[PluginAuth] Boot sync failed:', err));
}
