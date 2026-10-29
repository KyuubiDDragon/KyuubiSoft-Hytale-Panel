import { logger } from '../utils/logger.js';
/**
 * Mod Store Service
 * Downloads and installs mods from GitHub releases
 * Supports external mod registry from kyuubisoft.com
 */

import { mkdir, access } from 'fs/promises';
import path from 'path';
import {
  outboundErrorMessage,
  safeDownload,
  safeRequest,
  type ExpectedFile,
  type OutboundPolicy,
} from '../utils/safeFetch.js';
import { readRegularFile, replaceFileContent, UnsafeFileError } from '../utils/noFollowFs.js';
import { removeReplacedFile } from '../utils/replacedFile.js';
import { resolveRealPathWithin } from '../utils/pathSecurity.js';
import { MAX_SERVER_FILE_BYTES } from '../utils/serverFiles.js';
import type { ServerContext } from './serverContext.js';

// External registry URL
const EXTERNAL_REGISTRY_URL = 'https://kyuubisoft.com/hytale-mods.json';
const REGISTRY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
const REGISTRY_HOSTS = ['kyuubisoft.com'];
const GITHUB_API_HOSTS = ['api.github.com'];
// Release assets: github.com redirects to release-assets.githubusercontent.com.
export const GITHUB_DOWNLOAD_HOSTS = ['github.com', 'githubusercontent.com'];
const JSON_MAX_BYTES = 10 * 1024 * 1024;

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
  sha256?: string; // Of the direct download; checked when given
  size?: number; // Bytes of the direct download; checked when given
  category: 'map' | 'utility' | 'gameplay' | 'admin' | 'other';
  configTemplate?: Record<string, unknown>;
  configPath?: string; // Relative path for config file
  ports?: { name: string; default: number; env: string }[];
  website?: string;
  version?: string; // For direct downloads
  hints?: LocalizedString;
  // Optional compatibility metadata (populated by the registry). Used by the
  // mod-compatibility checker to warn before installing a mod built for a
  // different server version.
  gameVersions?: string[];
  minServerVersion?: string;
  maxServerVersion?: string;
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
      httpPort: 18081, // Placeholder - replaced with the server's web map port during install
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
    configPath: 'cryptobench_EasyWebMap/config.json', // Relative to the mods folder
    ports: [{ name: 'HTTP', default: 18081, env: 'WEBMAP_PORT' }],
  },
];

// Cache for external registry
let registryCache: { data: ModStoreEntry[]; timestamp: number } | null = null;

/**
 * Fetch JSON from one of `hosts` (redirects stay on them).
 */
async function fetchJson<T>(
  url: string,
  hosts: readonly string[],
  headers: Record<string, string> = {},
): Promise<T | null> {
  try {
    const res = await safeRequest(url, {
      allowedHosts: hosts,
      httpsOnly: true,
      maxBytes: JSON_MAX_BYTES,
      headers: { 'User-Agent': 'KyuubiSoft-Panel/1.0', ...headers },
    });
    if (res.status !== 200) {
      logger.error(`Fetch failed: ${url} - Status: ${res.status}`);
      return null;
    }
    return JSON.parse(res.body.toString('utf-8')) as T;
  } catch (e) {
    logger.error(`Fetch failed: ${url} - ${outboundErrorMessage(e)}`);
    return null;
  }
}

/**
 * Fetch mod registry from external URL with caching
 */
async function fetchExternalRegistry(): Promise<ModStoreEntry[]> {
  // Check cache
  if (registryCache && Date.now() - registryCache.timestamp < REGISTRY_CACHE_TTL) {
    return registryCache.data;
  }

  logger.info('Fetching external mod registry from:', EXTERNAL_REGISTRY_URL);

  try {
    const response = await fetchJson<{ mods: ModStoreEntry[] } | ModStoreEntry[]>(
      EXTERNAL_REGISTRY_URL,
      REGISTRY_HOSTS,
    );

    if (response) {
      // Support both { mods: [...] } and [...] formats
      const mods = Array.isArray(response) ? response : response.mods;

      if (Array.isArray(mods) && mods.length > 0) {
        logger.info(`Loaded ${mods.length} mods from external registry`);
        registryCache = { data: mods, timestamp: Date.now() };
        return mods;
      }
    }
  } catch (e) {
    logger.error('Failed to fetch external registry:', e);
  }

  // Fallback to built-in registry
  logger.info('Using built-in mod registry as fallback');
  return BUILTIN_REGISTRY;
}

/**
 * Get the combined mod registry (external + built-in)
 * External registry values override built-in, but built-in configTemplate/configPath
 * are preserved if external doesn't have them (for EasyWebMap etc.)
 */
export async function getModRegistry(): Promise<ModStoreEntry[]> {
  const externalMods = await fetchExternalRegistry();

  // Merge with built-in, external takes priority but preserves built-in config templates
  const modMap = new Map<string, ModStoreEntry>();

  // Add built-in first
  for (const mod of BUILTIN_REGISTRY) {
    modMap.set(mod.id, mod);
  }

  // Merge from external - preserve built-in configTemplate/configPath if external doesn't have them
  for (const externalMod of externalMods) {
    const existingMod = modMap.get(externalMod.id);
    if (existingMod) {
      // Debug: Log what we're merging
      logger.info(`[ModStore] Merging mod ${externalMod.id}:`);
      logger.info(`  - External has configTemplate: ${externalMod.configTemplate !== undefined}`);
      logger.info(`  - External has configPath: ${externalMod.configPath !== undefined}`);
      logger.info(`  - Built-in has configTemplate: ${existingMod.configTemplate !== undefined}`);
      logger.info(`  - Built-in has configPath: ${existingMod.configPath !== undefined}`);

      // Merge: external overrides, but keep built-in configTemplate/configPath if not in external
      const mergedMod: ModStoreEntry = {
        ...existingMod,
        ...externalMod,
        // Preserve built-in config template if external doesn't have one
        configTemplate: externalMod.configTemplate ?? existingMod.configTemplate,
        configPath: externalMod.configPath ?? existingMod.configPath,
        ports: externalMod.ports ?? existingMod.ports,
      };

      logger.info(`  - Merged has configTemplate: ${mergedMod.configTemplate !== undefined}`);
      logger.info(`  - Merged has configPath: ${mergedMod.configPath !== undefined}`);

      modMap.set(externalMod.id, mergedMod);
    } else {
      // New mod from external registry
      modMap.set(externalMod.id, externalMod);
    }
  }

  return Array.from(modMap.values());
}

// Legacy export for compatibility
export const MOD_REGISTRY = BUILTIN_REGISTRY;

export interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  body?: string; // Release notes / changelog
  assets: {
    name: string;
    browser_download_url: string;
    size: number;
    digest?: string | null; // "sha256:<hex>" for assets uploaded since mid-2025
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
  const release = await fetchJson<GitHubRelease>(
    `https://api.github.com/repos/${githubRepo}/releases/latest`,
    GITHUB_API_HOSTS,
    { Accept: 'application/vnd.github.v3+json' },
  );
  return release && Array.isArray(release.assets) ? release : null;
}

/**
 * The game server can write to its mods folder: a folder below it that is a
 * link out of it is refused, and files are replaced instead of written
 * through a link planted under their name.
 */
async function writeModsFolderFile(modsDir: string, file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  if (!resolveRealPathWithin(dir, [modsDir])) {
    throw new UnsafeFileError(dir, 'it lies outside the expected folder');
  }
  await mkdir(dir, { recursive: true });
  await replaceFileContent(file, content, [modsDir]);
}

async function readModsFolderFile(modsDir: string, file: string): Promise<string> {
  return (await readRegularFile(file, [modsDir], { maxBytes: MAX_SERVER_FILE_BYTES })).toString(
    'utf-8',
  );
}

/**
 * Download a mod file. SECURITY: every hop is checked (utils/safeFetch.ts),
 * so a malicious registry entry or release asset can't redirect the panel
 * into internal services (localhost, 169.254.169.254, RFC1918); size and
 * hash are checked where the source states them.
 */
async function downloadFile(download: ModDownload, destPath: string): Promise<boolean> {
  try {
    // destPath is <mods folder>/<plain name>. The game server can write to
    // that folder: the file is replaced, never written through a link
    // planted under its name.
    await safeDownload(download.url, {
      ...download.policy,
      headers: { 'User-Agent': 'KyuubiSoft-Panel/1.0' },
      expected: download.expected,
      saveTo: destPath,
    });
    return true;
  } catch (e) {
    logger.error(`[ModStore] Download failed: ${outboundErrorMessage(e)}`);
    return false;
  }
}

interface ModDownload {
  url: string;
  filename: string;
  version: string;
  expected: ExpectedFile;
  policy: OutboundPolicy;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const positiveSize = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

/** Size and SHA-256 GitHub states for a release asset. */
function githubAssetExpected(asset: GitHubRelease['assets'][number]): ExpectedFile {
  const sha256 = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/i, '') : '';
  return {
    ...(positiveSize(asset.size) ? { size: asset.size } : {}),
    ...(SHA256_HEX.test(sha256) ? { sha256 } : {}),
  };
}

/**
 * Where the latest version of `mod` comes from. GitHub assets stay on GitHub;
 * a direct registry URL may redirect to any public host and is checked
 * against the registry's sha256/size when it gives them.
 */
async function latestDownload(mod: ModStoreEntry): Promise<ModDownload | { error: string }> {
  if (mod.github) {
    const release = await getLatestRelease(mod.github);
    if (!release) return { error: 'Failed to fetch release from GitHub' };
    const jarAsset = release.assets.find((a) => a.name.endsWith('.jar'));
    if (!jarAsset) return { error: 'No JAR file found in release' };
    return {
      url: jarAsset.browser_download_url,
      // SECURITY: never trust the asset name as a path component.
      filename: safeModFilename(jarAsset.name, `${mod.name}.jar`),
      version: release.tag_name,
      expected: githubAssetExpected(jarAsset),
      policy: { allowedHosts: GITHUB_DOWNLOAD_HOSTS, httpsOnly: true },
    };
  }
  if (mod.downloadUrl) {
    // Reduce the URL's last part to a safe basename so a registry-supplied
    // URL ending in e.g. /../../foo can't escape modsPath.
    const urlParts = mod.downloadUrl.split('/');
    return {
      url: mod.downloadUrl,
      filename: safeModFilename(urlParts[urlParts.length - 1], `${mod.name}.jar`),
      version: mod.version || 'unknown',
      expected: {
        ...(typeof mod.sha256 === 'string' && SHA256_HEX.test(mod.sha256)
          ? { sha256: mod.sha256 }
          : {}),
        ...(positiveSize(mod.size) ? { size: mod.size } : {}),
      },
      policy: {},
    };
  }
  return { error: 'No download source available' };
}

/**
 * Reduce an untrusted download filename to a safe basename inside modsPath.
 * Strips any directory components and rejects anything that isn't a plain
 * `.jar`/`.zip` file name — defends against `..` traversal and absolute paths
 * coming from a release asset name or a registry-supplied download URL.
 */
function safeModFilename(rawName: string, fallback: string): string {
  const clean = (name: string): string | null => {
    const base = path.basename((name || '').replace(/\\/g, '/').trim());
    return base && /^[A-Za-z0-9._+-]+\.(jar|zip)$/i.test(base) && !base.startsWith('.')
      ? base
      : null;
  };
  // Sanitize the fallback too: it derives from mod.name which is registry data.
  return clean(rawName) ?? clean(fallback) ?? 'mod.jar';
}

/**
 * Extract version from filename (e.g., "EasyWebMap-v1.0.9.jar" -> "v1.0.9")
 */
function extractVersionFromFilename(filename: string): string | null {
  // Common patterns: Name-v1.0.0.jar, Name-1.0.0.jar, Name_v1.0.0.jar
  const patterns = [
    /[-_]v?(\d+\.\d+\.\d+)/i, // v1.0.0 or 1.0.0
    /[-_]v?(\d+\.\d+)/i, // v1.0 or 1.0
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
 * Check if a filename matches a mod (more precise matching to avoid false positives)
 */
function filenameMatchesMod(filename: string, modId: string, modName: string): boolean {
  const lowerFile = filename.toLowerCase();
  const lowerModId = modId.toLowerCase();
  const lowerModName = modName.toLowerCase().replace(/\s+/g, '');

  // Remove extension for comparison
  const baseName = lowerFile.replace(/\.(jar|jar\.disabled)$/i, '');

  // Check if filename starts with modId followed by a separator or version
  // e.g., "easywebmap-1.0.0" matches "easywebmap" but "easystorenetwork" does not
  const modIdPattern = new RegExp(`^${escapeRegex(lowerModId)}(-|_|\\.|\\s|$)`, 'i');
  if (modIdPattern.test(baseName)) {
    return true;
  }

  // Also check mod name (without spaces) followed by separator
  const modNamePattern = new RegExp(`^${escapeRegex(lowerModName)}(-|_|\\.|\\s|$)`, 'i');
  if (modNamePattern.test(baseName)) {
    return true;
  }

  return false;
}

/**
 * Escape regex special characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a mod is installed
 */
export async function isModInstalled(
  server: ServerContext,
  modId: string,
  registry?: ModStoreEntry[],
): Promise<{ installed: boolean; filename?: string; installedVersion?: string }> {
  const mods = registry || (await getModRegistry());
  const mod = mods.find((m) => m.id === modId);
  if (!mod) {
    return { installed: false };
  }

  const { readdir } = await import('fs/promises');

  try {
    const files = await readdir(server.paths.mods);

    // Check for mod file (precise matching to avoid false positives)
    for (const file of files) {
      if (file.endsWith('.jar') || file.endsWith('.jar.disabled')) {
        if (filenameMatchesMod(file, modId, mod.name)) {
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
export async function installMod(server: ServerContext, modId: string): Promise<InstallResult> {
  logger.info(`[ModStore] installMod called for: ${modId}`);
  const registry = await getModRegistry();
  const mod = registry.find((m) => m.id === modId);
  if (!mod) {
    logger.info(`[ModStore] Mod ${modId} not found in registry`);
    return { success: false, error: 'Mod not found in registry' };
  }

  // Debug: Log mod details including configTemplate
  logger.info(
    `[ModStore] Found mod: ${mod.name}, hasConfigTemplate: ${!!mod.configTemplate}, configPath: ${mod.configPath || 'none'}`,
  );
  if (mod.configTemplate) {
    logger.info(`[ModStore] configTemplate keys: ${Object.keys(mod.configTemplate).join(', ')}`);
  }

  // Check if already installed
  const installed = await isModInstalled(server, modId, registry);
  if (installed.installed) {
    logger.info(`[ModStore] Mod already installed: ${installed.filename}`);
    return { success: false, error: `Mod already installed: ${installed.filename}` };
  }

  const download = await latestDownload(mod);
  if ('error' in download) {
    return { success: false, error: download.error };
  }
  const { filename, version } = download;

  // Ensure mods directory exists
  const modsDir = server.paths.mods;
  try {
    await access(modsDir);
  } catch {
    await mkdir(modsDir, { recursive: true });
  }

  // Download the JAR
  const destPath = path.join(modsDir, filename);
  const downloaded = await downloadFile(download, destPath);

  if (!downloaded) {
    return { success: false, error: 'Failed to download mod file' };
  }

  // Create config if template exists
  let configCreated = false;
  if (mod.configTemplate && mod.configPath) {
    try {
      // Config path is relative to the mods folder (where the JAR is installed)
      const configFullPath = path.join(modsDir, mod.configPath);

      // Create a copy of the template and apply dynamic port values
      const configData = { ...mod.configTemplate };

      // For EasyWebMap, set the httpPort to the server's web map port
      if (modId === 'easywebmap' && 'httpPort' in configData) {
        configData.httpPort = server.network.webMapPort;
        logger.info(`[ModStore] Setting EasyWebMap httpPort to ${server.network.webMapPort}`);
      }

      const configContent = JSON.stringify(configData, null, 2);
      logger.info(`[ModStore] Writing config file: ${configFullPath}`);
      await writeModsFolderFile(modsDir, configFullPath, configContent);

      // Verify the config was written correctly
      const verifyContent = await readModsFolderFile(modsDir, configFullPath);
      if (verifyContent === configContent) {
        logger.info(`[ModStore] Config file verified successfully (${configContent.length} bytes)`);
        configCreated = true;
      } else {
        logger.error('[ModStore] Config file verification failed - content mismatch');
      }
    } catch (e) {
      logger.error('Failed to create config:', e);
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
export async function uninstallMod(
  server: ServerContext,
  modId: string,
): Promise<{ success: boolean; error?: string }> {
  const installed = await isModInstalled(server, modId);
  if (!installed.installed || !installed.filename) {
    return { success: false, error: 'Mod not installed' };
  }

  const { unlink } = await import('fs/promises');

  try {
    await unlink(path.join(server.paths.mods, installed.filename));
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Failed to delete mod file' };
  }
}

/**
 * Check if an update is available for a mod
 */
export async function checkModUpdate(
  server: ServerContext,
  modId: string,
): Promise<{
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

  const installed = await isModInstalled(server, modId, registry);
  if (!installed.installed || !installed.installedVersion) {
    return { hasUpdate: false, error: 'Mod not installed or version unknown' };
  }

  let latestVersion: string | undefined;

  if (mod.github) {
    const release = await getLatestRelease(mod.github);
    if (!release) {
      return {
        hasUpdate: false,
        installedVersion: installed.installedVersion,
        error: 'Failed to fetch latest release',
      };
    }
    latestVersion = release.tag_name;
  } else if (mod.version) {
    latestVersion = mod.version;
  } else {
    return {
      hasUpdate: false,
      installedVersion: installed.installedVersion,
      error: 'No version info available',
    };
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
export async function updateMod(server: ServerContext, modId: string): Promise<InstallResult> {
  const registry = await getModRegistry();
  const mod = registry.find((m) => m.id === modId);
  if (!mod) {
    return { success: false, error: 'Mod not found in registry' };
  }

  // Check if installed
  const installed = await isModInstalled(server, modId, registry);
  if (!installed.installed || !installed.filename) {
    return { success: false, error: 'Mod not installed' };
  }

  const download = await latestDownload(mod);
  if ('error' in download) {
    return { success: false, error: download.error };
  }
  const { filename, version: latestVersion } = download;

  // Check if already latest
  if (installed.installedVersion) {
    const comparison = compareVersions(installed.installedVersion, latestVersion);
    if (comparison >= 0) {
      return {
        success: false,
        error: 'Already on latest version',
        version: installed.installedVersion,
      };
    }
  }

  // Download new version; the old one is removed once it is in place.
  const destPath = path.join(server.paths.mods, filename);
  const downloaded = await downloadFile(download, destPath);

  if (!downloaded) {
    return { success: false, error: 'Failed to download new version' };
  }

  await removeReplacedFile(
    path.join(server.paths.mods, installed.filename),
    destPath,
    '[ModStore]',
  );

  return {
    success: true,
    filename,
    version: latestVersion,
  };
}

/**
 * Get all available mods with installation status and update info
 */
export async function getAvailableMods(server: ServerContext): Promise<
  (ModStoreEntry & {
    installed: boolean;
    installedFilename?: string;
    installedVersion?: string;
    latestVersion?: string;
    hasUpdate?: boolean;
  })[]
> {
  const registry = await getModRegistry();
  const result = [];

  for (const mod of registry) {
    const status = await isModInstalled(server, mod.id, registry);

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
  logger.info('Mod registry cache cleared');
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

/**
 * Ensure EasyWebMap config exists and has correct port
 * This can be called after server startup to fix config if mod created default
 */
export async function ensureEasyWebMapConfig(server: ServerContext): Promise<{
  success: boolean;
  created: boolean;
  updated: boolean;
  error?: string;
}> {
  const configPath = path.join(server.paths.mods, 'cryptobench_EasyWebMap/config.json');
  const expectedPort = server.network.webMapPort;

  logger.info(
    `[ModStore] ensureEasyWebMapConfig: checking ${configPath}, expected port: ${expectedPort}`,
  );

  try {
    // Check if EasyWebMap is installed
    const installed = await isModInstalled(server, 'easywebmap');
    if (!installed.installed) {
      logger.info('[ModStore] EasyWebMap not installed, skipping config check');
      return { success: true, created: false, updated: false };
    }

    // Check if config file exists
    let existingConfig: Record<string, unknown> | null = null;
    try {
      const content = await readModsFolderFile(server.paths.mods, configPath);
      existingConfig = JSON.parse(content);
      logger.info(
        `[ModStore] Found existing config, httpPort: ${(existingConfig as { httpPort?: number }).httpPort}`,
      );
    } catch {
      // Config doesn't exist
      logger.info('[ModStore] Config file does not exist');
    }

    // Get the config template from registry
    const registry = await getModRegistry();
    const mod = registry.find((m) => m.id === 'easywebmap');

    if (!mod?.configTemplate) {
      logger.error('[ModStore] No config template found for EasyWebMap in registry');
      return {
        success: false,
        created: false,
        updated: false,
        error: 'No config template in registry',
      };
    }

    if (!existingConfig) {
      // Create new config
      const newConfig = { ...mod.configTemplate, httpPort: expectedPort };
      await writeModsFolderFile(server.paths.mods, configPath, JSON.stringify(newConfig, null, 2));
      logger.info(`[ModStore] Created new EasyWebMap config with httpPort: ${expectedPort}`);
      return { success: true, created: true, updated: false };
    }

    // Check if port needs updating
    if ((existingConfig as { httpPort?: number }).httpPort !== expectedPort) {
      (existingConfig as { httpPort: number }).httpPort = expectedPort;
      await writeModsFolderFile(
        server.paths.mods,
        configPath,
        JSON.stringify(existingConfig, null, 2),
      );
      logger.info(`[ModStore] Updated EasyWebMap config httpPort to: ${expectedPort}`);
      return { success: true, created: false, updated: true };
    }

    logger.info('[ModStore] EasyWebMap config already has correct port');
    return { success: true, created: false, updated: false };
  } catch (error) {
    logger.error('[ModStore] Error ensuring EasyWebMap config:', error);
    return {
      success: false,
      created: false,
      updated: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
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
  ensureEasyWebMapConfig,
};
