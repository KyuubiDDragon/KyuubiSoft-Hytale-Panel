/**
 * KyuubiSoft API Plugin Service
 *
 * Manages the KyuubiSoft API plugin that provides accurate player data,
 * server statistics, and real-time events via HTTP/WebSocket.
 *
 * Multi-server: every public function takes an optional `serverId`. When
 * omitted, the default server in the registry (services/servers.ts) is used.
 * The plugin host (container name) and port are pulled from the registry
 * entry, falling back to legacy env-var config if the registry isn't ready
 * yet on fresh boot.
 *
 * Every request and WebSocket carries the server's plugin token
 * (services/pluginAuth.ts). Plugin 2.0.0 requires it; 1.4.x ignores it.
 */

import { config } from '../config.js';
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
import { getDefaultId, getServer, resolveServerId } from './servers.js';
import { ensurePluginAuthConfig, getPluginToken } from './pluginAuth.js';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin version (should match the built JAR version in
// manager/backend/assets/plugins/ and plugins/kyuubisoft-api/build.gradle).
export const PLUGIN_VERSION = '2.0.0';
// Legacy default plugin port. Kept exported for back-compat with callers
// that read this constant directly (e.g. configService snapshots, status
// fallbacks). Per-server callers should use `resolvePluginEndpoint(serverId)`
// which reads the actual port from the registry.
export const PLUGIN_PORT = 18085;
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
 * Resolve the plugin host + port for an explicit or default server id.
 * Falls back to env-var defaults if the registry isn't loaded yet.
 */
export async function resolvePluginEndpoint(
  serverId?: string,
): Promise<{ host: string; port: number }> {
  try {
    const id = serverId ?? (await getDefaultId());
    const s = await getServer(id);
    if (s) return { host: s.containerName, port: s.network.pluginPort };
  } catch {
    /* registry not ready yet */
  }
  return { host: config.gameContainerName, port: PLUGIN_PORT };
}

/**
 * Resolve the on-disk mods path for an explicit or default server id.
 * Falls back to legacy env-var config if registry isn't loaded.
 */
async function resolveModsPath(serverId?: string): Promise<string> {
  try {
    const id = serverId ?? (await getDefaultId());
    const s = await getServer(id);
    if (s) return s.paths.mods;
  } catch {
    /* registry not ready yet */
  }
  return config.modsPath;
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
        : { success: false, error: `HTTP ${response.status}` };
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
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin',
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
