/**
 * KyuubiSoft API Plugin Service
 *
 * Manages the KyuubiSoft API plugin that provides accurate player data,
 * server statistics, and real-time events via HTTP/WebSocket.
 *
 * Multi-server: every public function takes an optional `serverId`. When
 * omitted, the default server in the registry (services/servers.ts) is used.
 * The plugin host (container name) comes from the server context
 * (services/serverContext.ts); the port is the plugin's fixed internal one.
 *
 * Every request and WebSocket carries the server's plugin token
 * (services/pluginAuth.ts). Plugin 2.0.0 requires it; 1.4.x ignores it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  isDemoMode,
  getDemoPerformanceMetrics,
  getDemoJvmMetrics,
  getDemoOnlinePlayers,
  getDemoPlayerDetails,
  getDemoPlayerInventory,
} from './demoData.js';
import { resolveServerId } from './servers.js';
import { PLUGIN_INTERNAL_PORT, getServerContext } from './serverContext.js';
import { ensurePluginAuthConfig, getPluginToken } from './pluginAuth.js';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin version (should match the built JAR version in
// manager/backend/assets/plugins/ and plugins/kyuubisoft-api/build.gradle).
export const PLUGIN_VERSION = '2.1.1';
// The plugin listens on this port inside every game container. Kept exported
// for callers that read the constant directly; per-server callers use
// `resolvePluginEndpoint(serverId)`.
export const PLUGIN_PORT = PLUGIN_INTERNAL_PORT;
export const PLUGIN_JAR_NAME = `KyuubiSoftAPI-${PLUGIN_VERSION}.jar`;

/**
 * Why the plugin refused the panel. Both clear on the next server start,
 * because the panel writes the token into the plugin config before it.
 *  - token_rejected: 401, the plugin runs with a different (older) token
 *  - token_missing:  503 auth_not_configured, the plugin has no token at all
 */
export type PluginAuthError = 'token_rejected' | 'token_missing';

const AUTH_ERROR_MESSAGES: Record<PluginAuthError, string> = {
  token_rejected:
    'Plugin rejected the panel token. Restart the server so the plugin loads the current token.',
  token_missing:
    'Plugin has no auth token configured. Restart the server from the panel so it writes the token.',
};

export interface PluginStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  port: number;
  error?: string;
  authError?: PluginAuthError;
}

export interface PluginApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  authError?: PluginAuthError;
  /** HTTP status of a refused GET (e.g. 404 player offline, 501 not offered by this server build). */
  status?: number;
  /** A POST timed out after it was sent: the plugin may still have run the action. */
  maybeRan?: boolean;
}

/**
 * `Authorization` header for the server's plugin. Empty when the token store
 * cannot be read; the plugin then answers 401/503 and the status says so.
 */
export async function getPluginAuthHeaders(serverId?: string): Promise<Record<string, string>> {
  try {
    const token = await getPluginToken(await resolveServerId(serverId));
    return { Authorization: `Bearer ${token}` };
  } catch (error) {
    console.warn(
      '[KyuubiAPI] Plugin token unavailable:',
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}

/** Map a failed plugin response to an auth error, if it is one. */
async function classifyAuthFailure(response: Response): Promise<PluginAuthError | undefined> {
  if (response.status === 401) return 'token_rejected';
  if (response.status !== 503) return undefined;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  return body?.code === 'auth_not_configured' ? 'token_missing' : undefined;
}

function authFailure<T>(authError: PluginAuthError): PluginApiResponse & { data?: T } {
  return { success: false, error: AUTH_ERROR_MESSAGES[authError], authError };
}

/**
 * Plugin host + port for an explicit or default server id: the server's
 * container on the stack network, always on the plugin's internal port.
 */
export async function resolvePluginEndpoint(
  serverId?: string,
): Promise<{ host: string; port: number }> {
  const { plugin } = await getServerContext(serverId);
  return { host: plugin.host, port: plugin.port };
}

/** On-disk mods path for an explicit or default server id. */
async function resolveModsPath(serverId?: string): Promise<string> {
  return (await getServerContext(serverId)).paths.mods;
}

/**
 * Check if the KyuubiSoft API plugin is installed in the mods folder
 */
export async function isPluginInstalled(serverId?: string): Promise<boolean> {
  // Demo mode: always report plugin as installed
  if (isDemoMode()) {
    return true;
  }

  try {
    const modsPath = await resolveModsPath(serverId);
    const files = fs.readdirSync(modsPath);

    // Check for any KyuubiSoftAPI jar file
    return files.some(
      (file) =>
        file.toLowerCase().startsWith('kyuubisoftapi') &&
        file.endsWith('.jar') &&
        !file.endsWith('.disabled'),
    );
  } catch {
    return false;
  }
}

/**
 * Get the installed plugin version
 */
export async function getInstalledVersion(serverId?: string): Promise<string | null> {
  // Demo mode: return current plugin version
  if (isDemoMode()) {
    return PLUGIN_VERSION;
  }

  try {
    const modsPath = await resolveModsPath(serverId);
    const files = fs.readdirSync(modsPath);

    const pluginFile = files.find(
      (file) =>
        file.toLowerCase().startsWith('kyuubisoftapi') &&
        file.endsWith('.jar') &&
        !file.endsWith('.disabled'),
    );

    if (pluginFile) {
      // Extract version from filename: KyuubiSoftAPI-1.0.0.jar
      const match = pluginFile.match(/KyuubiSoftAPI-(\d+\.\d+\.\d+)\.jar/i);
      return match ? match[1] : 'unknown';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Probe the plugin. A plugin that refuses the panel's token counts as not
 * running (callers fall back to logs) but reports why.
 */
async function probePlugin(
  serverId?: string,
): Promise<{ running: boolean; authError?: PluginAuthError }> {
  // Demo mode: always report plugin as running
  if (isDemoMode()) {
    return { running: true };
  }

  try {
    const { host, port } = await resolvePluginEndpoint(serverId);
    const headers = await getPluginAuthHeaders(serverId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`http://${host}:${port}/api/server/info`, {
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (response.ok) return { running: true };
    const authError = await classifyAuthFailure(response);
    return authError ? { running: false, authError } : { running: false };
  } catch {
    return { running: false };
  }
}

/**
 * Check if the KyuubiSoft API plugin is running and responding
 */
export async function isPluginRunning(serverId?: string): Promise<boolean> {
  return (await probePlugin(serverId)).running;
}

/**
 * Get full plugin status
 */
export async function getPluginStatus(serverId?: string): Promise<PluginStatus> {
  const installed = await isPluginInstalled(serverId);
  const version = await getInstalledVersion(serverId);
  const { port } = await resolvePluginEndpoint(serverId);

  if (!installed) {
    return {
      installed: false,
      running: false,
      version: null,
      port,
    };
  }

  const { running, authError } = await probePlugin(serverId);

  return {
    installed: true,
    running,
    version,
    port,
    ...(authError ? { authError } : {}),
  };
}

/**
 * Get data from the KyuubiSoft API plugin
 */
export async function fetchFromPlugin<T>(
  endpoint: string,
  serverId?: string,
): Promise<PluginApiResponse & { data?: T }> {
  // Demo mode: return mock data based on endpoint
  if (isDemoMode()) {
    return getDemoPluginResponse<T>(endpoint);
  }

  try {
    const { host, port } = await resolvePluginEndpoint(serverId);
    const headers = await getPluginAuthHeaders(serverId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`http://${host}:${port}${endpoint}`, {
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const authError = await classifyAuthFailure(response);
      return authError
        ? authFailure(authError)
        : { success: false, error: `HTTP ${response.status}`, status: response.status };
    }

    const data = (await response.json()) as T;
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin',
    };
  }
}

/**
 * Demo mode: Generate mock plugin responses
 */
function getDemoPluginResponse<T>(endpoint: string): PluginApiResponse & { data?: T } {
  if (endpoint === '/api/server/info') {
    const metrics = getDemoPerformanceMetrics();
    return {
      success: true,
      data: {
        serverName: 'KyuubiSoft Demo Server',
        version: '1.0.0',
        tps: metrics.tps,
        mspt: metrics.mspt,
        playerCount: metrics.playerCount,
        maxPlayers: 100,
        uptime: metrics.uptime,
        worldTime: metrics.worldTime,
        weather: metrics.weather,
      } as T,
    };
  }

  if (endpoint === '/api/server/memory') {
    const jvm = getDemoJvmMetrics();
    return {
      success: true,
      data: {
        heapUsed: jvm.heapUsed,
        heapMax: jvm.heapMax,
        heapPercent: jvm.heapPercent,
        gcCount: jvm.gcCount,
        gcTime: jvm.gcTime,
        threads: jvm.threads,
        cpuLoad: jvm.cpuLoad,
      } as T,
    };
  }

  if (endpoint === '/api/players') {
    const players = getDemoOnlinePlayers();
    return {
      success: true,
      data: players.map((p) => ({
        name: p.name,
        uuid: `demo-uuid-${p.name}`,
        world: 'Orbis',
        online: true,
        joinedAt: p.joined_at,
      })) as T,
    };
  }

  if (endpoint.startsWith('/api/players/') && endpoint.endsWith('/details')) {
    const playerName = endpoint.split('/')[3];
    const details = getDemoPlayerDetails(playerName);
    return {
      success: true,
      data: details as T,
    };
  }

  if (endpoint.startsWith('/api/players/') && endpoint.endsWith('/inventory')) {
    const playerName = endpoint.split('/')[3];
    const inventory = getDemoPlayerInventory(playerName);
    return {
      success: true,
      data: inventory as T,
    };
  }

  return { success: true, data: {} as T };
}

/**
 * POST to the KyuubiSoft API plugin (for actions)
 */
export async function postToPlugin<T>(
  endpoint: string,
  body?: unknown,
  serverId?: string,
): Promise<PluginApiResponse & { data?: T }> {
  // Demo mode: simulate successful actions
  if (isDemoMode()) {
    return { success: true, data: { message: '[DEMO] Action executed successfully' } as T };
  }

  try {
    const { host, port } = await resolvePluginEndpoint(serverId);
    const headers: Record<string, string> = await getPluginAuthHeaders(serverId);
    if (body) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`http://${host}:${port}${endpoint}`, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const authError = response.ok ? undefined : await classifyAuthFailure(response);
    if (authError) return authFailure(authError);

    const data = (await response.json()) as Record<string, unknown>;
    // The plugin replies HTTP 200 with a JSON body {success, message|data, error}.
    // Older code keyed success solely on response.ok, so an action the plugin
    // declined (body success:false) was reported as a success — and the route's
    // console-command fallback was silently skipped, making the action a no-op.
    // Respect the body's success flag so failures correctly fall through.
    const bodySuccess = typeof data.success === 'boolean' ? (data.success as boolean) : response.ok;
    return {
      success: response.ok && bodySuccess,
      data: data.data as T,
      error: (data.error ?? data.message) as string | undefined,
    };
  } catch (error) {
    // Aborted by the timeout: unlike a refused connection, the plugin may
    // have taken the action and still be running it.
    const maybeRan = error instanceof Error && error.name === 'AbortError';
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin',
      ...(maybeRan ? { maybeRan: true } : {}),
    };
  }
}

/**
 * Get players from the plugin API (more accurate than log parsing)
 */
export async function getPlayersFromPlugin(serverId?: string): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/players', serverId);
}

/**
 * Get server info from the plugin API
 */
/** Tick window as plugin 2.1 reports it ("10s", "1m", "5m"). */
export interface PluginTpsWindow {
  window: string;
  tpsAvg: number;
  tpsMin: number;
  tpsMax: number;
  tickMsAvg: number;
  tickMsMin: number;
  tickMsMax: number;
}

export interface PluginWorldPerf {
  world: string;
  targetTps: number;
  tickBudgetMs: number;
  tps: number;
  mspt: number;
  windows: PluginTpsWindow[];
  players: number;
  entities: number;
  loadedChunks: number;
}

/** GET /api/server/tps (plugin 2.1+): headline = slowest world relative to its target. */
export interface PluginServerTps {
  world?: string;
  tps?: number;
  mspt?: number;
  targetTps: number;
  worlds: PluginWorldPerf[];
}

/**
 * Real per-world tick metrics from plugin 2.1+. Older plugins answer 404;
 * callers fall back to the Prometheus gauges then.
 */
export async function getTpsFromPlugin(
  serverId?: string,
): Promise<PluginApiResponse & { data?: PluginServerTps }> {
  return fetchFromPlugin<PluginServerTps>('/api/server/tps', serverId);
}

export async function getServerInfoFromPlugin(serverId?: string): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/server/info', serverId);
}

/**
 * Get memory stats from the plugin API
 */
export async function getMemoryFromPlugin(serverId?: string): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/server/memory', serverId);
}

/**
 * Get Prometheus metrics from the plugin API
 * Returns raw Prometheus text format
 */
export async function getPrometheusMetrics(
  serverId?: string,
): Promise<{ success: boolean; data?: string; error?: string }> {
  // Demo mode: return mock Prometheus metrics
  if (isDemoMode()) {
    const metrics = getDemoPerformanceMetrics();
    const jvm = getDemoJvmMetrics();
    const prometheusData = `# HELP hytale_tps Server TPS
# TYPE hytale_tps gauge
hytale_tps ${metrics.tps.toFixed(2)}
# HELP hytale_mspt Server MSPT
# TYPE hytale_mspt gauge
hytale_mspt ${metrics.mspt.toFixed(2)}
# HELP hytale_player_count Online player count
# TYPE hytale_player_count gauge
hytale_player_count ${metrics.playerCount}
# HELP hytale_uptime_seconds Server uptime in seconds
# TYPE hytale_uptime_seconds counter
hytale_uptime_seconds ${metrics.uptime}
# HELP jvm_memory_used_bytes JVM memory used
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes ${jvm.heapUsed * 1024 * 1024}
# HELP jvm_memory_max_bytes JVM memory max
# TYPE jvm_memory_max_bytes gauge
jvm_memory_max_bytes ${jvm.heapMax * 1024 * 1024}
# HELP jvm_threads_current Current thread count
# TYPE jvm_threads_current gauge
jvm_threads_current ${jvm.threads}
`;
    return { success: true, data: prometheusData };
  }

  try {
    const { host, port } = await resolvePluginEndpoint(serverId);
    const headers = await getPluginAuthHeaders(serverId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`http://${host}:${port}/metrics`, {
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const authError = await classifyAuthFailure(response);
      return authError
        ? { success: false, error: AUTH_ERROR_MESSAGES[authError] }
        : { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.text();
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin',
    };
  }
}

/**
 * Get player details from the plugin API
 */
export async function getPlayerDetailsFromPlugin(
  playerName: string,
  serverId?: string,
): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/details`, serverId);
}

/**
 * Get player inventory from the plugin API
 */
export async function getPlayerInventoryFromPlugin(
  playerName: string,
  serverId?: string,
): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/inventory`, serverId);
}

/**
 * Get player appearance from the plugin API
 */
export async function getPlayerAppearanceFromPlugin(
  playerName: string,
  serverId?: string,
): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/appearance`, serverId);
}

/**
 * Heal a player via the plugin API
 */
export async function healPlayerViaPlugin(
  playerName: string,
  serverId?: string,
): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/heal`, undefined, serverId);
}

/**
 * Clear a player's inventory via the plugin API
 */
export async function clearInventoryViaPlugin(
  playerName: string,
  serverId?: string,
): Promise<PluginApiResponse> {
  return postToPlugin(
    `/api/players/${encodeURIComponent(playerName)}/inventory/clear`,
    undefined,
    serverId,
  );
}

/**
 * Give an item to a player via the plugin API
 */
export async function givePlayerViaPlugin(
  playerName: string,
  item: string,
  amount: number | undefined,
  serverId?: string,
): Promise<PluginApiResponse> {
  return postToPlugin(
    `/api/players/${encodeURIComponent(playerName)}/give`,
    { item, amount },
    serverId,
  );
}

/**
 * Set a player's gamemode via the plugin API
 */
export async function setGamemodeViaPlugin(
  playerName: string,
  gamemode: string,
  serverId?: string,
): Promise<PluginApiResponse> {
  return postToPlugin(
    `/api/players/${encodeURIComponent(playerName)}/gamemode`,
    { gamemode },
    serverId,
  );
}

/**
 * Kill a player via the plugin API
 */
export async function killPlayerViaPlugin(
  playerName: string,
  serverId?: string,
): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/kill`, undefined, serverId);
}

/**
 * Respawn a player via the plugin API
 */
export async function respawnPlayerViaPlugin(
  playerName: string,
  serverId?: string,
): Promise<PluginApiResponse> {
  return postToPlugin(
    `/api/players/${encodeURIComponent(playerName)}/respawn`,
    undefined,
    serverId,
  );
}

/**
 * Teleport a player via the plugin API
 */
export async function teleportPlayerViaPlugin(
  playerName: string,
  options: { target?: string; x?: number; y?: number; z?: number },
  serverId?: string,
): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/teleport`, options, serverId);
}

/**
 * Check if plugin update is available
 */
export async function isUpdateAvailable(
  serverId?: string,
): Promise<{ available: boolean; currentVersion: string | null; latestVersion: string }> {
  const currentVersion = await getInstalledVersion(serverId);

  return {
    available: currentVersion !== null && currentVersion !== PLUGIN_VERSION,
    currentVersion,
    latestVersion: PLUGIN_VERSION,
  };
}

/**
 * Get the path to the bundled plugin JAR
 */
export function getBundledPluginPath(): string {
  // Try multiple possible locations for the plugin JAR
  const possiblePaths = [
    // Relative to module location (works for both src/ and dist/)
    path.join(__dirname, '..', '..', 'assets', 'plugins', PLUGIN_JAR_NAME),
    // Docker container path (/app/assets/plugins/)
    path.join('/app', 'assets', 'plugins', PLUGIN_JAR_NAME),
    // Relative to cwd (fallback for development)
    path.join(process.cwd(), 'assets', 'plugins', PLUGIN_JAR_NAME),
    // Manager backend directory
    path.join(process.cwd(), 'manager', 'backend', 'assets', 'plugins', PLUGIN_JAR_NAME),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Return the first path as default (will trigger proper error in installPlugin)
  return possiblePaths[0];
}

/**
 * Install the KyuubiSoft API plugin
 */
export async function installPlugin(
  serverId?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const bundledPath = getBundledPluginPath();
    const modsPath = await resolveModsPath(serverId);
    const targetPath = path.join(modsPath, PLUGIN_JAR_NAME);

    // Check if bundled JAR exists
    if (!fs.existsSync(bundledPath)) {
      return { success: false, error: 'Plugin JAR not found in assets' };
    }

    // Remove old versions
    const files = fs.readdirSync(modsPath);
    for (const file of files) {
      if (file.toLowerCase().startsWith('kyuubisoftapi') && file.endsWith('.jar')) {
        fs.unlinkSync(path.join(modsPath, file));
      }
    }

    // Copy new version
    fs.copyFileSync(bundledPath, targetPath);

    // Plugin 2.0 stays locked without the panel's token; write it now so the
    // next start loads it, even when that start does not go through the panel.
    await ensurePluginAuthConfig(serverId);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install plugin',
    };
  }
}

/**
 * Uninstall the KyuubiSoft API plugin
 */
export async function uninstallPlugin(
  serverId?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const modsPath = await resolveModsPath(serverId);
    const files = fs.readdirSync(modsPath);

    let removed = false;
    for (const file of files) {
      if (file.toLowerCase().startsWith('kyuubisoftapi') && file.endsWith('.jar')) {
        fs.unlinkSync(path.join(modsPath, file));
        removed = true;
      }
    }

    if (!removed) {
      return { success: false, error: 'Plugin not found' };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to uninstall plugin',
    };
  }
}

// ============================================================
// Live data (plugin 2.1+): server status, plugins, access, permissions,
// sessions and world-thread player reads. Read-only: changes go through
// server commands, so the server stays the single writer.
// ============================================================

export interface LiveServerStatus {
  build: { version?: string; revision?: string; patchline?: string };
  update: {
    moduleEnabled: boolean;
    patchline?: string;
    currentVersion?: string;
    latestVersion?: string;
    available: boolean;
    stagedVersion?: string;
    downloading: boolean;
    progress?: { percent: number; downloadedBytes: number; totalBytes: number; etaSeconds: number };
  };
  /** Never contains tokens: only which tokens exist and when they expire. */
  auth: {
    mode?: string;
    authenticated: boolean;
    hasSessionToken: boolean;
    hasIdentityToken: boolean;
    singleplayer: boolean;
    tokenExpiresAt?: string;
    expiresInSeconds?: number;
    expired?: boolean;
    profileName?: string;
    profileUuid?: string;
    summary?: string;
  };
  lifecycle: {
    booted: boolean;
    shuttingDown: boolean;
    bootedAt?: string;
    shutdownReason?: string;
    shutdownMessage?: string;
  };
  collectedAt: string;
}

export interface LivePluginInfo {
  id: string;
  group?: string;
  name?: string;
  version?: string;
  /**
   * NONE, SETUP, START, ENABLED, SHUTDOWN, DISABLED, FAILED, NOT_LOADED (known
   * but not loaded) or REJECTED (jar in the mods folder the server refused).
   */
  state?: string;
  enabled: boolean;
  /** Built-in server module (group "Hytale"). */
  core: boolean;
  disabledByDefault?: boolean;
  description?: string;
  website?: string;
  authors?: string[];
  serverVersionRange?: string;
  /** COMPATIBLE, MISSING, PARSE_FAILED or INCOMPATIBLE; absent for core modules. */
  serverVersionCheck?: string;
  versionMismatch: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** REJECTED only: the jar name and the dependencies no known plugin provides. */
  file?: string;
  missingDependencies?: string[];
  error?: { type: string; message?: string; wrapperType?: string; wrapperMessage?: string };
}

export interface LivePluginList {
  serverVersion?: string;
  managerState?: string;
  count: number;
  coreCount: number;
  failedCount: number;
  mismatchCount: number;
  plugins: LivePluginInfo[];
}

/** 0.7 whitelist: the RequireJoinPermission flag plus users holding the join grant. */
export interface LiveWhitelist {
  enabled: boolean;
  permission?: string;
  count: number;
  entries: { uuid: string; name?: string; online: boolean }[];
}

export interface LiveBan {
  target?: string;
  targetName?: string;
  by?: string;
  byName?: string;
  timestamp?: string;
  /** Absent for permanent bans. */
  expiresOn?: string;
  permanent: boolean;
  inEffect: boolean;
  reason?: string;
}

export interface LiveBans {
  provider?: string;
  count: number;
  activeCount: number;
  entries: LiveBan[];
}

export interface LivePermissionGroup {
  name: string;
  parent?: string;
  permissions: string[];
  effectivePermissions: string[];
}

export interface LivePermissionGroups {
  defaultGroup: string;
  operatorGroup: string;
  providers: string[];
  providersTampered: boolean;
  count: number;
  groups: LivePermissionGroup[];
  virtualGroups: Record<string, string[]>;
}

export interface LivePermissionUser {
  uuid: string;
  name?: string;
  online: boolean;
  groups: string[];
  permissions: string[];
  operator: boolean;
  joinGrant?: boolean;
  allowedToJoin?: boolean;
  banned?: boolean;
}

export interface LivePermissionUsers {
  /** Always false: the server cannot list every user (online, whitelisted and wildcard users only). */
  complete: boolean;
  count: number;
  users: LivePermissionUser[];
}

export interface LivePing {
  type: string;
  lastMs?: number;
  avg1mMs?: number;
  min1mMs?: number;
  max1mMs?: number;
  avg5mMs?: number;
}

export interface LiveSession {
  uuid: string;
  name: string;
  world?: string;
  /** Absent for players that were online before the plugin started. */
  joinedAt?: string;
  language?: string;
  groups?: string[];
  ping?: LivePing;
  /** Protocol checksum of the client; the server keeps no client build string. */
  protocolCrc?: number;
}

export interface LivePlayerSnapshot extends LiveSession {
  gamemode?: string;
  stats?: Record<string, { value: number; max: number }>;
  position?: { x: number; y: number; z: number };
  yaw?: number;
  pitch?: number;
  /** Skin parts by slot (haircut, eyes, ...). */
  appearance?: Record<string, string>;
}

export interface LiveInventoryItem {
  section?: string;
  slot: number;
  itemId: string;
  amount: number;
  durability?: number;
  maxDurability?: number;
  unbreakable?: boolean;
  broken?: boolean;
}

export interface LiveInventorySection {
  capacity: number;
  activeSlot?: number;
  items: LiveInventoryItem[];
}

export type LiveInventorySectionId =
  'hotbar' | 'storage' | 'armor' | 'utility' | 'tools' | 'backpack';

export interface LivePlayerInventory {
  uuid: string;
  name: string;
  world?: string;
  sections: Partial<Record<LiveInventorySectionId, LiveInventorySection>>;
  items: LiveInventoryItem[];
  totalSlots: number;
  usedSlots: number;
}

async function fetchLive<T>(
  endpoint: string,
  serverId?: string,
): Promise<PluginApiResponse & { data?: T }> {
  if (isDemoMode()) {
    return { success: false, error: 'Live data is not available in demo mode', status: 501 };
  }
  return fetchFromPlugin<T>(endpoint, serverId);
}

/** Build, update, auth and lifecycle state of the running server. */
export function getServerStatusFromPlugin(serverId?: string) {
  return fetchLive<LiveServerStatus>('/api/server/status', serverId);
}

/** Every plugin/mod the server knows, with load state, version and load error. */
export function getLoadedPluginsFromPlugin(serverId?: string) {
  return fetchLive<LivePluginList>('/api/plugins', serverId);
}

export function getWhitelistFromPlugin(serverId?: string) {
  return fetchLive<LiveWhitelist>('/api/access/whitelist', serverId);
}

export function getBansFromPlugin(serverId?: string) {
  return fetchLive<LiveBans>('/api/access/bans', serverId);
}

export function getPermissionGroupsFromPlugin(serverId?: string) {
  return fetchLive<LivePermissionGroups>('/api/permissions/groups', serverId);
}

export function getPermissionUsersFromPlugin(serverId?: string) {
  return fetchLive<LivePermissionUsers>('/api/permissions/users', serverId);
}

export function getPermissionUserFromPlugin(uuid: string, serverId?: string) {
  return fetchLive<LivePermissionUser>(
    `/api/permissions/users/${encodeURIComponent(uuid)}`,
    serverId,
  );
}

/** Online sessions with world, join time, ping and groups (no world-thread reads). */
export function getSessionsFromPlugin(serverId?: string) {
  return fetchLive<{ count: number; sessions: LiveSession[] }>('/api/sessions', serverId);
}

/** Game mode, stats, position, ping, groups and skin, read on the player's world thread. */
export function getPlayerLiveFromPlugin(player: string, serverId?: string) {
  return fetchLive<LivePlayerSnapshot>(`/api/players/${encodeURIComponent(player)}/live`, serverId);
}

/** The real inventory (hotbar, storage, armor, utility, tools, backpack). */
export function getPlayerLiveInventoryFromPlugin(player: string, serverId?: string) {
  return fetchLive<LivePlayerInventory>(
    `/api/players/${encodeURIComponent(player)}/inventory`,
    serverId,
  );
}

// ---------------------------------------------------------------------------
// Mod panel registry (/api/mods/panel, plugin 2.1+): status pages and admin
// actions that KS mods register with the plugin. The raw answer is returned;
// routes/modPanel.ts validates it (schemas/modPanel.ts) before the frontend
// sees it.
// ---------------------------------------------------------------------------

/** The plugin's mod panel answer: HTTP status 0 means unreachable. */
export interface ModPanelPluginResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
  authError?: PluginAuthError;
}

/** Who asks, passed on to the mod (informational) as X-Panel-Actor / Accept-Language. */
export interface ModPanelCaller {
  actor?: string;
  locale?: string;
}

// Plugin limits: snapshot 3 s, action 10 s; a bit more so the plugin's own
// timeout answer arrives instead of an abort here.
const MOD_PANEL_LIST_TIMEOUT_MS = 5000;
const MOD_PANEL_SNAPSHOT_TIMEOUT_MS = 6000;
const MOD_PANEL_ACTION_TIMEOUT_MS = 15000;
// Accepted by the plugin as X-Panel-Actor.
const MOD_PANEL_ACTOR = /^[\w.@-]{1,64}$/;

async function requestModPanel(
  method: 'GET' | 'POST',
  endpoint: string,
  timeoutMs: number,
  serverId: string | undefined,
  caller: ModPanelCaller,
  body?: unknown,
): Promise<ModPanelPluginResponse> {
  if (isDemoMode()) {
    return endpoint === '/api/mods/panel'
      ? { ok: true, status: 200, body: { apiVersion: 1, providers: [] } }
      : {
          ok: false,
          status: 404,
          body: { status: 404, error: 'Unknown provider', code: 'not_found' },
        };
  }
  try {
    const { host, port } = await resolvePluginEndpoint(serverId);
    const headers: Record<string, string> = await getPluginAuthHeaders(serverId);
    // Only what the plugin accepts; anything else (e.g. non-Latin-1 names) would make fetch throw.
    if (caller.actor && MOD_PANEL_ACTOR.test(caller.actor)) headers['X-Panel-Actor'] = caller.actor;
    if (caller.locale) headers['Accept-Language'] = caller.locale;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://${host}:${port}${endpoint}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const authError = response.ok ? undefined : await classifyAuthFailure(response);
    if (authError) {
      return {
        ok: false,
        status: response.status,
        body: null,
        error: AUTH_ERROR_MESSAGES[authError],
        authError,
      };
    }
    const parsed: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin',
    };
  }
}

/** Registered mod providers with their actions. */
export function getModPanelProviders(
  serverId?: string,
  caller: ModPanelCaller = {},
): Promise<ModPanelPluginResponse> {
  return requestModPanel('GET', '/api/mods/panel', MOD_PANEL_LIST_TIMEOUT_MS, serverId, caller);
}

/** One provider's current snapshot. */
export function getModPanelSnapshot(
  providerId: string,
  serverId?: string,
  caller: ModPanelCaller = {},
): Promise<ModPanelPluginResponse> {
  return requestModPanel(
    'GET',
    `/api/mods/panel/${encodeURIComponent(providerId)}`,
    MOD_PANEL_SNAPSHOT_TIMEOUT_MS,
    serverId,
    caller,
  );
}

/** Runs a provider's action; the plugin checks params and confirmation again. */
export function runModPanelAction(
  providerId: string,
  actionId: string,
  request: { params?: Record<string, unknown>; confirmed?: boolean },
  serverId?: string,
  caller: ModPanelCaller = {},
): Promise<ModPanelPluginResponse> {
  return requestModPanel(
    'POST',
    `/api/mods/panel/${encodeURIComponent(providerId)}/actions/${encodeURIComponent(actionId)}`,
    MOD_PANEL_ACTION_TIMEOUT_MS,
    serverId,
    caller,
    { params: request.params ?? {}, confirmed: request.confirmed === true },
  );
}
