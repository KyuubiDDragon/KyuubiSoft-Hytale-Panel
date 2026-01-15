/**
 * Mod Store Service
 * Downloads and installs mods from GitHub releases
 */

import { writeFile, mkdir, access } from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import { config } from '../config.js';

// Registry of available mods
export interface ModStoreEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  github: string; // owner/repo format
  category: 'map' | 'utility' | 'gameplay' | 'admin' | 'other';
  configTemplate?: Record<string, unknown>;
  configPath?: string; // Relative path for config file
  ports?: { name: string; default: number; env: string }[];
}

// Available mods registry
export const MOD_REGISTRY: ModStoreEntry[] = [
  {
    id: 'easywebmap',
    name: 'EasyWebMap',
    description: 'Live web map for Hytale servers with real-time player tracking',
    author: 'cryptobench',
    github: 'cryptobench/EasyWebMap',
    category: 'map',
    configTemplate: {
      httpPort: 18081,
      wsPort: 18082,
      maxZoom: 5,
      minZoom: 0,
      tileSize: 256,
      updateInterval: 1000,
      enableWebSocket: true,
      enablePlayerTracking: true,
      enableChunkRendering: true,
      bindAddress: '0.0.0.0',
    },
    configPath: 'config/EasyWebMap/config.json',
    ports: [
      { name: 'HTTP', default: 18081, env: 'WEBMAP_PORT' },
      { name: 'WebSocket', default: 18082, env: 'WEBMAP_WS_PORT' },
    ],
  },
];

export interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  assets: {
    name: string;
    browser_download_url: string;
    size: number;
  }[];
}

export interface InstallResult {
  success: boolean;
  error?: string;
  filename?: string;
  version?: string;
  configCreated?: boolean;
}

/**
 * Fetch latest release from GitHub
 */
export async function getLatestRelease(githubRepo: string): Promise<GitHubRelease | null> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${githubRepo}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'KyuubiSoft-Panel/1.0',
        Accept: 'application/vnd.github.v3+json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            console.error(`GitHub API error: ${res.statusCode}`);
            resolve(null);
          }
        } catch (e) {
          console.error('Failed to parse GitHub response:', e);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('GitHub request error:', e);
      resolve(null);
    });

    req.end();
  });
}

/**
 * Download file from URL
 */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = (currentUrl: string) => {
      const proto = currentUrl.startsWith('https') ? https : http;

      proto.get(currentUrl, { headers: { 'User-Agent': 'KyuubiSoft-Panel/1.0' } }, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            request(redirectUrl);
            return;
          }
        }

        if (res.statusCode !== 200) {
          console.error(`Download failed: ${res.statusCode}`);
          resolve(false);
          return;
        }

        const chunks: Buffer[] = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            await writeFile(destPath, buffer);
            resolve(true);
          } catch (e) {
            console.error('Failed to write file:', e);
            resolve(false);
          }
        });
        res.on('error', (e) => {
          console.error('Download error:', e);
          resolve(false);
        });
      }).on('error', (e) => {
        console.error('Request error:', e);
        resolve(false);
      });
    };

    request(url);
  });
}

/**
 * Check if a mod is installed
 */
export async function isModInstalled(modId: string): Promise<{ installed: boolean; filename?: string }> {
  const mod = MOD_REGISTRY.find((m) => m.id === modId);
  if (!mod) {
    return { installed: false };
  }

  const { readdir } = await import('fs/promises');

  try {
    const files = await readdir(config.modsPath);

    // Check for mod file (case-insensitive search)
    for (const file of files) {
      const lowerFile = file.toLowerCase();
      if (lowerFile.includes(modId) || lowerFile.includes(mod.name.toLowerCase())) {
        if (file.endsWith('.jar') || file.endsWith('.jar.disabled')) {
          return { installed: true, filename: file };
        }
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return { installed: false };
}

/**
 * Install a mod from the registry
 */
export async function installMod(modId: string): Promise<InstallResult> {
  const mod = MOD_REGISTRY.find((m) => m.id === modId);
  if (!mod) {
    return { success: false, error: 'Mod not found in registry' };
  }

  // Check if already installed
  const installed = await isModInstalled(modId);
  if (installed.installed) {
    return { success: false, error: `Mod already installed: ${installed.filename}` };
  }

  // Get latest release
  const release = await getLatestRelease(mod.github);
  if (!release) {
    return { success: false, error: 'Failed to fetch release from GitHub' };
  }

  // Find JAR asset
  const jarAsset = release.assets.find((a) => a.name.endsWith('.jar'));
  if (!jarAsset) {
    return { success: false, error: 'No JAR file found in release' };
  }

  // Ensure mods directory exists
  try {
    await access(config.modsPath);
  } catch {
    await mkdir(config.modsPath, { recursive: true });
  }

  // Download the JAR
  const destPath = path.join(config.modsPath, jarAsset.name);
  const downloaded = await downloadFile(jarAsset.browser_download_url, destPath);

  if (!downloaded) {
    return { success: false, error: 'Failed to download mod file' };
  }

  // Create config if template exists
  let configCreated = false;
  if (mod.configTemplate && mod.configPath) {
    try {
      const configFullPath = path.join(config.serverPath, mod.configPath);
      const configDir = path.dirname(configFullPath);

      await mkdir(configDir, { recursive: true });
      await writeFile(configFullPath, JSON.stringify(mod.configTemplate, null, 2), 'utf-8');
      configCreated = true;
    } catch (e) {
      console.error('Failed to create config:', e);
      // Non-fatal - mod is still installed
    }
  }

  return {
    success: true,
    filename: jarAsset.name,
    version: release.tag_name,
    configCreated,
  };
}

/**
 * Uninstall a mod
 */
export async function uninstallMod(modId: string): Promise<{ success: boolean; error?: string }> {
  const installed = await isModInstalled(modId);
  if (!installed.installed || !installed.filename) {
    return { success: false, error: 'Mod not installed' };
  }

  const { unlink } = await import('fs/promises');

  try {
    await unlink(path.join(config.modsPath, installed.filename));
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Failed to delete mod file' };
  }
}

/**
 * Get all available mods with installation status
 */
export async function getAvailableMods(): Promise<(ModStoreEntry & { installed: boolean; installedFilename?: string })[]> {
  const result = [];

  for (const mod of MOD_REGISTRY) {
    const status = await isModInstalled(mod.id);
    result.push({
      ...mod,
      installed: status.installed,
      installedFilename: status.filename,
    });
  }

  return result;
}

export default {
  MOD_REGISTRY,
  getLatestRelease,
  isModInstalled,
  installMod,
  uninstallMod,
  getAvailableMods,
};
