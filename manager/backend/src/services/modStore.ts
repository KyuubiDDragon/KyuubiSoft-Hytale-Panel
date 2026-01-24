/**
 * Mod Store Service
 * Downloads and installs mods from GitHub releases
 * Supports external mod registry from kyuubisoft.com
 */

import { writeFile, mkdir, access } from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import { config } from '../config.js';

// External registry URL
const EXTERNAL_REGISTRY_URL = 'https://kyuubisoft.com/hytale-mods.json';
const REGISTRY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

// Localized string type for multi-language support
export interface LocalizedString {
  de?: string;
  en?: string;
  pt_br?: string;
}

// Registry of available mods
export interface ModStoreEntry {
  id: string;
  name: string;
  description: string | LocalizedString; // Can be string (legacy) or localized
  author: string;
  github?: string; // owner/repo format (for GitHub releases)
  downloadUrl?: string; // Direct download URL (alternative to github)
  category: 'map' | 'utility' | 'gameplay' | 'admin' | 'other';
  configTemplate?: Record<string, unknown>;
  configPath?: string; // Relative path for config file
  ports?: { name: string; default: number; env: string }[];
  website?: string;
  version?: string; // For direct downloads
  hints?: LocalizedString;
}

// Built-in fallback registry (used if external registry fails)
// Note: configTemplate uses placeholder ports - they get replaced with actual config values during install
const BUILTIN_REGISTRY: ModStoreEntry[] = [
  {
    id: 'easywebmap',
    name: 'EasyWebMap',
    description: 'Live web map for Hytale servers with real-time player tracking',
    author: 'cryptobench',
    github: 'cryptobench/EasyWebMap',
    category: 'map',
    configTemplate: {
      httpPort: 18081, // Placeholder - replaced with config.webMapPort during install
      updateIntervalMs: 1000,
      tileCacheSize: 20000,
      enabledWorlds: [],
      tileSize: 256,
      maxZoom: 4,
      renderExploredChunksOnly: true,
      chunkIndexCacheMs: 30000,
      tileRefreshRadius: 5,
      tileRefreshIntervalMs: 60000,
      useDiskCache: true,
      enableTilePyramids: true,
      enableHttps: false,
      httpsPort: 18082,
      domain: '',
      acmeEmail: '',
      useProductionAcme: true,
    },
    configPath: 'cryptobench_EasyWebMap/config.json', // Relative to modsPath
    ports: [
      { name: 'HTTP', default: 18081, env: 'WEBMAP_PORT' },
    ],
  },
];

// Cache for external registry
let registryCache: { data: ModStoreEntry[]; timestamp: number } | null = null;

/**
 * Fetch JSON from URL
 */
async function fetchJson<T>(url: string): Promise<T | null> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, { headers: { 'User-Agent': 'KyuubiSoft-Panel/1.0' } }, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          fetchJson<T>(redirectUrl).then(resolve);
          return;
        }
      }

      if (res.statusCode !== 200) {
        console.error(`Fetch failed: ${url} - Status: ${res.statusCode}`);
        resolve(null);
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error('Failed to parse JSON:', e);
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    }).on('error', (e) => {
      console.error('Request error:', e);
      resolve(null);
    });
  });
}

/**
 * Fetch mod registry from external URL with caching
 */
async function fetchExternalRegistry(): Promise<ModStoreEntry[]> {
  // Check cache
  if (registryCache && Date.now() - registryCache.timestamp < REGISTRY_CACHE_TTL) {
    return registryCache.data;
  }

  console.log('Fetching external mod registry from:', EXTERNAL_REGISTRY_URL);

  try {
    const response = await fetchJson<{ mods: ModStoreEntry[] } | ModStoreEntry[]>(EXTERNAL_REGISTRY_URL);

    if (response) {
      // Support both { mods: [...] } and [...] formats
      const mods = Array.isArray(response) ? response : response.mods;

      if (Array.isArray(mods) && mods.length > 0) {
        console.log(`Loaded ${mods.length} mods from external registry`);
        registryCache = { data: mods, timestamp: Date.now() };
        return mods;
      }
    }
  } catch (e) {
    console.error('Failed to fetch external registry:', e);
  }

  // Fallback to built-in registry
  console.log('Using built-in mod registry as fallback');
  return BUILTIN_REGISTRY;
}

/**
 * Get the combined mod registry (external + built-in)
 */
export async function getModRegistry(): Promise<ModStoreEntry[]> {
  const externalMods = await fetchExternalRegistry();

  // Merge with built-in, external takes priority for same IDs
  const modMap = new Map<string, ModStoreEntry>();

  // Add built-in first
  for (const mod of BUILTIN_REGISTRY) {
    modMap.set(mod.id, mod);
  }

  // Override/add from external
  for (const mod of externalMods) {
    modMap.set(mod.id, mod);
  }

  return Array.from(modMap.values());
}

// Legacy export for compatibility
export const MOD_REGISTRY = BUILTIN_REGISTRY;

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
 * Extract version from filename (e.g., "EasyWebMap-v1.0.9.jar" -> "v1.0.9")
 */
function extractVersionFromFilename(filename: string): string | null {
  // Common patterns: Name-v1.0.0.jar, Name-1.0.0.jar, Name_v1.0.0.jar
  const patterns = [
    /[-_]v?(\d+\.\d+\.\d+)/i,  // v1.0.0 or 1.0.0
    /[-_]v?(\d+\.\d+)/i,       // v1.0 or 1.0
  ];

  for (const pattern of patterns) {
    const match = filename.match(pattern);
    if (match) {
      return match[1].startsWith('v') ? match[1] : `v${match[1]}`;
    }
  }
  return null;
}

/**
 * Normalize version string for comparison (remove 'v' prefix)
 */
function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '').trim();
}

/**
 * Compare two version strings. Returns:
 * -1 if v1 < v2
 *  0 if v1 == v2
 *  1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = normalizeVersion(v1).split('.').map(Number);
  const parts2 = normalizeVersion(v2).split('.').map(Number);

  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }

  return 0;
}

/**
 * Check if a mod is installed
 */
export async function isModInstalled(modId: string, registry?: ModStoreEntry[]): Promise<{ installed: boolean; filename?: string; installedVersion?: string }> {
  const mods = registry || await getModRegistry();
  const mod = mods.find((m) => m.id === modId);
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
          const version = extractVersionFromFilename(file);
          return { installed: true, filename: file, installedVersion: version || undefined };
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
  const registry = await getModRegistry();
  const mod = registry.find((m) => m.id === modId);
  if (!mod) {
    return { success: false, error: 'Mod not found in registry' };
  }

  // Check if already installed
  const installed = await isModInstalled(modId, registry);
  if (installed.installed) {
    return { success: false, error: `Mod already installed: ${installed.filename}` };
  }

  let downloadUrl: string;
  let filename: string;
  let version: string;

  // Determine download source (GitHub or direct URL)
  if (mod.github) {
    // Get latest release from GitHub
    const release = await getLatestRelease(mod.github);
    if (!release) {
      return { success: false, error: 'Failed to fetch release from GitHub' };
    }

    // Find JAR asset
    const jarAsset = release.assets.find((a) => a.name.endsWith('.jar'));
    if (!jarAsset) {
      return { success: false, error: 'No JAR file found in release' };
    }

    downloadUrl = jarAsset.browser_download_url;
    filename = jarAsset.name;
    version = release.tag_name;
  } else if (mod.downloadUrl) {
    // Direct download URL
    downloadUrl = mod.downloadUrl;
    // Extract filename from URL or use mod name
    const urlParts = mod.downloadUrl.split('/');
    filename = urlParts[urlParts.length - 1] || `${mod.name}.jar`;
    version = mod.version || 'unknown';
  } else {
    return { success: false, error: 'No download source available' };
  }

  // Ensure mods directory exists
  try {
    await access(config.modsPath);
  } catch {
    await mkdir(config.modsPath, { recursive: true });
  }

  // Download the JAR
  const destPath = path.join(config.modsPath, filename);
  const downloaded = await downloadFile(downloadUrl, destPath);

  if (!downloaded) {
    return { success: false, error: 'Failed to download mod file' };
  }

  // Create config if template exists
  let configCreated = false;
  if (mod.configTemplate && mod.configPath) {
    try {
      // Config path is relative to modsPath (where the JAR is installed)
      const configFullPath = path.join(config.modsPath, mod.configPath);
      const configDir = path.dirname(configFullPath);

      // Create a copy of the template and apply dynamic port values
      const configData = { ...mod.configTemplate };

      // For EasyWebMap, set the httpPort from environment/config
      if (modId === 'easywebmap' && 'httpPort' in configData) {
        configData.httpPort = config.webMapPort;
        console.log(`[ModStore] Setting EasyWebMap httpPort to ${config.webMapPort}`);
      }

      await mkdir(configDir, { recursive: true });
      await writeFile(configFullPath, JSON.stringify(configData, null, 2), 'utf-8');
      configCreated = true;
    } catch (e) {
      console.error('Failed to create config:', e);
      // Non-fatal - mod is still installed
    }
  }

  return {
    success: true,
    filename,
    version,
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
 * Check if an update is available for a mod
 */
export async function checkModUpdate(modId: string): Promise<{
  hasUpdate: boolean;
  installedVersion?: string;
  latestVersion?: string;
  error?: string;
}> {
  const registry = await getModRegistry();
  const mod = registry.find((m) => m.id === modId);
  if (!mod) {
    return { hasUpdate: false, error: 'Mod not found' };
  }

  const installed = await isModInstalled(modId, registry);
  if (!installed.installed || !installed.installedVersion) {
    return { hasUpdate: false, error: 'Mod not installed or version unknown' };
  }

  let latestVersion: string | undefined;

  if (mod.github) {
    const release = await getLatestRelease(mod.github);
    if (!release) {
      return { hasUpdate: false, installedVersion: installed.installedVersion, error: 'Failed to fetch latest release' };
    }
    latestVersion = release.tag_name;
  } else if (mod.version) {
    latestVersion = mod.version;
  } else {
    return { hasUpdate: false, installedVersion: installed.installedVersion, error: 'No version info available' };
  }

  const hasUpdate = compareVersions(installed.installedVersion, latestVersion) < 0;

  return {
    hasUpdate,
    installedVersion: installed.installedVersion,
    latestVersion,
  };
}

/**
 * Update a mod to the latest version
 */
export async function updateMod(modId: string): Promise<InstallResult> {
  const registry = await getModRegistry();
  const mod = registry.find((m) => m.id === modId);
  if (!mod) {
    return { success: false, error: 'Mod not found in registry' };
  }

  // Check if installed
  const installed = await isModInstalled(modId, registry);
  if (!installed.installed || !installed.filename) {
    return { success: false, error: 'Mod not installed' };
  }

  let downloadUrl: string;
  let filename: string;
  let latestVersion: string;

  if (mod.github) {
    // Get latest release from GitHub
    const release = await getLatestRelease(mod.github);
    if (!release) {
      return { success: false, error: 'Failed to fetch release from GitHub' };
    }

    // Find JAR asset
    const jarAsset = release.assets.find((a) => a.name.endsWith('.jar'));
    if (!jarAsset) {
      return { success: false, error: 'No JAR file found in release' };
    }

    downloadUrl = jarAsset.browser_download_url;
    filename = jarAsset.name;
    latestVersion = release.tag_name;
  } else if (mod.downloadUrl) {
    downloadUrl = mod.downloadUrl;
    const urlParts = mod.downloadUrl.split('/');
    filename = urlParts[urlParts.length - 1] || `${mod.name}.jar`;
    latestVersion = mod.version || 'unknown';
  } else {
    return { success: false, error: 'No download source available' };
  }

  // Check if already latest
  if (installed.installedVersion) {
    const comparison = compareVersions(installed.installedVersion, latestVersion);
    if (comparison >= 0) {
      return { success: false, error: 'Already on latest version', version: installed.installedVersion };
    }
  }

  const { unlink } = await import('fs/promises');

  // Delete old version
  try {
    await unlink(path.join(config.modsPath, installed.filename));
  } catch (e) {
    console.error('Failed to delete old mod file:', e);
    // Continue anyway - download new version
  }

  // Download new version
  const destPath = path.join(config.modsPath, filename);
  const downloaded = await downloadFile(downloadUrl, destPath);

  if (!downloaded) {
    return { success: false, error: 'Failed to download new version' };
  }

  return {
    success: true,
    filename,
    version: latestVersion,
  };
}

/**
 * Get all available mods with installation status and update info
 */
export async function getAvailableMods(): Promise<(ModStoreEntry & {
  installed: boolean;
  installedFilename?: string;
  installedVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
})[]> {
  const registry = await getModRegistry();
  const result = [];

  for (const mod of registry) {
    const status = await isModInstalled(mod.id, registry);

    let latestVersion: string | undefined;
    let hasUpdate = false;

    // Only check for updates if mod is installed and has GitHub source
    if (status.installed && status.installedVersion && mod.github) {
      const release = await getLatestRelease(mod.github);
      if (release) {
        latestVersion = release.tag_name;
        hasUpdate = compareVersions(status.installedVersion, latestVersion) < 0;
      }
    } else if (mod.version) {
      // For direct download mods, use the version from registry
      latestVersion = mod.version;
      if (status.installed && status.installedVersion) {
        hasUpdate = compareVersions(status.installedVersion, latestVersion) < 0;
      }
    }

    result.push({
      ...mod,
      installed: status.installed,
      installedFilename: status.filename,
      installedVersion: status.installedVersion,
      latestVersion,
      hasUpdate,
    });
  }

  return result;
}

/**
 * Force refresh the external registry cache
 */
export function refreshRegistry(): void {
  registryCache = null;
  console.log('Mod registry cache cleared');
}

/**
 * Get registry info (for debugging)
 */
export function getRegistryInfo(): { url: string; cached: boolean; cacheAge?: number } {
  return {
    url: EXTERNAL_REGISTRY_URL,
    cached: registryCache !== null,
    cacheAge: registryCache ? Date.now() - registryCache.timestamp : undefined,
  };
}

export default {
  MOD_REGISTRY,
  getModRegistry,
  getLatestRelease,
  isModInstalled,
  installMod,
  uninstallMod,
  updateMod,
  checkModUpdate,
  getAvailableMods,
  refreshRegistry,
  getRegistryInfo,
};
