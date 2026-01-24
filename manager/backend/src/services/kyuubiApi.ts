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

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin version (should match the built JAR version)
export const PLUGIN_VERSION = '1.2.0';
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
 */
function getPluginHost(): string {
  return process.env.GAME_CONTAINER_NAME || config.gameContainerName || 'hytale';
}

/**
 * Check if the KyuubiSoft API plugin is running and responding
 */
export async function isPluginRunning(): Promise<boolean> {
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
 * POST to the KyuubiSoft API plugin (for actions)
 */
export async function postToPlugin<T>(endpoint: string, body?: unknown): Promise<PluginApiResponse & { data?: T }> {
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
