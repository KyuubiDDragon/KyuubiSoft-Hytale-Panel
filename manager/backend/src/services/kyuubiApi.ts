/**
 * KyuubiSoft API Plugin Service
 *
 * Manages the KyuubiSoft API plugin that provides accurate player data,
 * server statistics, and real-time events via HTTP/WebSocket.
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

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin version (should match the built JAR version)
export const PLUGIN_VERSION = '1.2.2';
export const PLUGIN_PORT = 18085;
export const PLUGIN_JAR_NAME = `KyuubiSoftAPI-${PLUGIN_VERSION}.jar`;

export interface PluginStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  port: number;
  error?: string;
}

export interface PluginApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Check if the KyuubiSoft API plugin is installed in the mods folder
 */
export function isPluginInstalled(): boolean {
  // Demo mode: always report plugin as installed
  if (isDemoMode()) {
    return true;
  }

  try {
    const modsPath = config.modsPath;
    const files = fs.readdirSync(modsPath);

    // Check for any KyuubiSoftAPI jar file
    return files.some(file =>
      file.toLowerCase().startsWith('kyuubisoftapi') &&
      file.endsWith('.jar') &&
      !file.endsWith('.disabled')
    );
  } catch {
    return false;
  }
}

/**
 * Get the installed plugin version
 */
export function getInstalledVersion(): string | null {
  // Demo mode: return current plugin version
  if (isDemoMode()) {
    return PLUGIN_VERSION;
  }

  try {
    const modsPath = config.modsPath;
    const files = fs.readdirSync(modsPath);

    const pluginFile = files.find(file =>
      file.toLowerCase().startsWith('kyuubisoftapi') &&
      file.endsWith('.jar') &&
      !file.endsWith('.disabled')
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
 * Get the host for connecting to the plugin API
 * Uses the game container name for Docker networking
 * Note: config.gameContainerName already has STACK_NAME fallback built in
 */
function getPluginHost(): string {
  return config.gameContainerName;
}

/**
 * Check if the KyuubiSoft API plugin is running and responding
 */
export async function isPluginRunning(): Promise<boolean> {
  // Demo mode: always report plugin as running
  if (isDemoMode()) {
    return true;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const host = getPluginHost();
    const response = await fetch(`http://${host}:${PLUGIN_PORT}/api/server/info`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get full plugin status
 */
export async function getPluginStatus(): Promise<PluginStatus> {
  const installed = isPluginInstalled();
  const version = getInstalledVersion();

  if (!installed) {
    return {
      installed: false,
      running: false,
      version: null,
      port: PLUGIN_PORT,
    };
  }

  const running = await isPluginRunning();

  return {
    installed: true,
    running,
    version,
    port: PLUGIN_PORT,
  };
}

/**
 * Get data from the KyuubiSoft API plugin
 */
export async function fetchFromPlugin<T>(endpoint: string): Promise<PluginApiResponse & { data?: T }> {
  // Demo mode: return mock data based on endpoint
  if (isDemoMode()) {
    return getDemoPluginResponse<T>(endpoint);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const host = getPluginHost();
    const response = await fetch(`http://${host}:${PLUGIN_PORT}${endpoint}`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as T;
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin'
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
      data: players.map(p => ({
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
export async function postToPlugin<T>(endpoint: string, body?: unknown): Promise<PluginApiResponse & { data?: T }> {
  // Demo mode: simulate successful actions
  if (isDemoMode()) {
    return { success: true, data: { message: '[DEMO] Action executed successfully' } as T };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const host = getPluginHost();
    const response = await fetch(`http://${host}:${PLUGIN_PORT}${endpoint}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const data = await response.json() as Record<string, unknown>;
    return {
      success: response.ok,
      data: data.data as T,
      error: data.error as string | undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin'
    };
  }
}

/**
 * Get players from the plugin API (more accurate than log parsing)
 */
export async function getPlayersFromPlugin(): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/players');
}

/**
 * Get server info from the plugin API
 */
export async function getServerInfoFromPlugin(): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/server/info');
}

/**
 * Get memory stats from the plugin API
 */
export async function getMemoryFromPlugin(): Promise<PluginApiResponse> {
  return fetchFromPlugin('/api/server/memory');
}

/**
 * Get Prometheus metrics from the plugin API
 * Returns raw Prometheus text format
 */
export async function getPrometheusMetrics(): Promise<{ success: boolean; data?: string; error?: string }> {
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const host = getPluginHost();
    const response = await fetch(`http://${host}:${PLUGIN_PORT}/metrics`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.text();
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to plugin'
    };
  }
}

/**
 * Get player details from the plugin API
 */
export async function getPlayerDetailsFromPlugin(playerName: string): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/details`);
}

/**
 * Get player inventory from the plugin API
 */
export async function getPlayerInventoryFromPlugin(playerName: string): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/inventory`);
}

/**
 * Get player appearance from the plugin API
 */
export async function getPlayerAppearanceFromPlugin(playerName: string): Promise<PluginApiResponse> {
  return fetchFromPlugin(`/api/players/${encodeURIComponent(playerName)}/appearance`);
}

/**
 * Heal a player via the plugin API
 */
export async function healPlayerViaPlugin(playerName: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/heal`);
}

/**
 * Clear a player's inventory via the plugin API
 */
export async function clearInventoryViaPlugin(playerName: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/inventory/clear`);
}

/**
 * Set a player's gamemode via the plugin API
 */
export async function setGamemodeViaPlugin(playerName: string, gamemode: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/gamemode`, { gamemode });
}

/**
 * Kill a player via the plugin API
 */
export async function killPlayerViaPlugin(playerName: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/kill`);
}

/**
 * Respawn a player via the plugin API
 */
export async function respawnPlayerViaPlugin(playerName: string): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/respawn`);
}

/**
 * Teleport a player via the plugin API
 */
export async function teleportPlayerViaPlugin(
  playerName: string,
  options: { target?: string; x?: number; y?: number; z?: number }
): Promise<PluginApiResponse> {
  return postToPlugin(`/api/players/${encodeURIComponent(playerName)}/teleport`, options);
}

/**
 * Check if plugin update is available
 */
export function isUpdateAvailable(): { available: boolean; currentVersion: string | null; latestVersion: string } {
  const currentVersion = getInstalledVersion();

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
export async function installPlugin(): Promise<{ success: boolean; error?: string }> {
  try {
    const bundledPath = getBundledPluginPath();
    const targetPath = path.join(config.modsPath, PLUGIN_JAR_NAME);

    // Check if bundled JAR exists
    if (!fs.existsSync(bundledPath)) {
      return { success: false, error: 'Plugin JAR not found in assets' };
    }

    // Remove old versions
    const modsPath = config.modsPath;
    const files = fs.readdirSync(modsPath);
    for (const file of files) {
      if (file.toLowerCase().startsWith('kyuubisoftapi') && file.endsWith('.jar')) {
        fs.unlinkSync(path.join(modsPath, file));
      }
    }

    // Copy new version
    fs.copyFileSync(bundledPath, targetPath);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install plugin'
    };
  }
}

/**
 * Uninstall the KyuubiSoft API plugin
 */
export async function uninstallPlugin(): Promise<{ success: boolean; error?: string }> {
  try {
    const modsPath = config.modsPath;
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
      error: error instanceof Error ? error.message : 'Failed to uninstall plugin'
    };
  }
}
