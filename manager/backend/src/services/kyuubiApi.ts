/**
 * KyuubiSoft API Plugin Service
 *
 * Manages the KyuubiSoft API plugin that provides accurate player data,
 * server statistics, and real-time events via HTTP/WebSocket.
 */

import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';

// Plugin version (should match the built JAR version)
export const PLUGIN_VERSION = '1.0.0';
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
 * Check if the KyuubiSoft API plugin is running and responding
 */
export async function isPluginRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`http://localhost:${PLUGIN_PORT}/api/server/info`, {
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

    const response = await fetch(`http://localhost:${PLUGIN_PORT}${endpoint}`, {
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
  // The JAR is stored in the manager's assets folder
  return path.join(process.cwd(), 'assets', 'plugins', PLUGIN_JAR_NAME);
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
