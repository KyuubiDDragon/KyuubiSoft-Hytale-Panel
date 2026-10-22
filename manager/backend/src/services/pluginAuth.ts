/**
 * Auth token for the KyuubiSoft API plugin.
 *
 * Plugin 2.0.0 refuses every HTTP request and WebSocket upgrade without
 * `Authorization: Bearer <token>`. The panel owns that token: it generates one
 * random token per server, keeps it in its own data volume (plugin-tokens.json,
 * never in servers.json, which the API hands to the browser) and writes it
 * into the plugin's config file before each server start.
 *
 * Old 1.4.x plugins keep working: the panel also sets their `authEnabled`
 * flag, so they check the same header on HTTP.
 */
import { mkdir, readdir, stat, chmod } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { isDemoMode } from './demoData.js';
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
const TOKEN_BYTES = 32;
const SECRET_FILE_MODE = 0o600;

/** Where the plugin reads its config, relative to the server's working dir. */
export const PLUGIN_CONFIG_RELATIVE_PATH = path.join('config', 'kyuubisoft-api', 'config.json');

interface TokenFile {
  schemaVersion: 1;
  tokens: Record<string, string>;
}

export interface PluginConfigWriteResult {
  ok: boolean;
  changed: boolean;
  path?: string;
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

export function pluginConfigPath(serverDir: string): string {
  return path.join(serverDir, PLUGIN_CONFIG_RELATIVE_PATH);
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

/**
 * Put `token` into the plugin config at `configPath`, keeping every other key
 * the operator set (port, position interval, CORS allowlist, …). Returns
 * changed:false when the file already holds the token.
 */
export async function writePluginAuthConfig(
  configPath: string,
  token: string,
): Promise<{ changed: boolean }> {
  await mkdir(path.dirname(configPath), { recursive: true });
  return withFileLock(configPath, async () => {
    let current: Record<string, unknown> | null = null;
    try {
      current = await readJsonFile<Record<string, unknown>>(configPath, { isValid: isPlainObject });
    } catch (err) {
      if (!(err instanceof JsonFileCorruptError)) throw err;
      // The plugin cannot read it either and would stay locked; rewrite it.
      const kept = err.backupPath ? ` (copy kept as ${path.basename(err.backupPath)})` : '';
      console.warn(
        `[PluginAuth] ${configPath} is unreadable (${err.reason}); rewriting it with the panel token${kept}`,
      );
    }

    if (current?.insecureDisableAuth === true) {
      // The operator's explicit choice, so it stays; but say so on every start.
      console.warn(
        `[PluginAuth] ${configPath} sets insecureDisableAuth: the plugin API accepts requests without a token`,
      );
    }

    if (current?.authToken === token && current?.authEnabled === true) return { changed: false };

    // authEnabled only matters for 1.4.x plugins; 2.0.0 always requires the token.
    await writeJsonAtomic(
      configPath,
      { ...(current ?? {}), authEnabled: true, authToken: token },
      { mode: SECRET_FILE_MODE },
    );
    // A file created by an older plugin may be world-readable; it now holds a secret.
    await chmod(configPath, SECRET_FILE_MODE).catch(() => {});
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

async function ensureForServer(server: ServerInstance): Promise<PluginConfigWriteResult> {
  if (!(await isDirectory(server.paths.server))) {
    return {
      ok: false,
      changed: false,
      error: `server directory ${server.paths.server} is not reachable from the panel`,
    };
  }
  const configPath = pluginConfigPath(server.paths.server);
  const { changed } = await writePluginAuthConfig(configPath, await getPluginToken(server.id));
  if (changed) console.log(`[PluginAuth:${server.id}] Plugin token written to ${configPath}`);
  return { ok: true, changed, path: configPath };
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
  }
  if (!result.ok)
    console.warn(`[PluginAuth:${id}] Could not write the plugin token: ${result.error}`);
  return result;
}

/** Plugin installed or configured for this server? Only then is a config worth writing at boot. */
async function hasPluginFootprint(server: ServerInstance): Promise<boolean> {
  try {
    await stat(pluginConfigPath(server.paths.server));
    return true;
  } catch {
    /* no config yet */
  }
  try {
    return (await readdir(server.paths.mods)).some(isPluginJarFile);
  } catch {
    return false;
  }
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
