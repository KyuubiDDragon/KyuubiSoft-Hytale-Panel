import { logger } from '../utils/logger.js';
/**
 * Modtale Service
 * Integration with the Modtale.net API for browsing and installing mods
 * API Documentation: https://api.modtale.net
 */

import { mkdir, access, unlink } from 'fs/promises';
import path from 'path';
import https from 'https';
import { config } from '../config.js';
import { sanitizeFileName, isPathSafe, resolveFileInDir } from '../utils/pathSecurity.js';
import type { ServerContext } from './serverContext.js';
import { readRegularFile, replaceFileContent } from '../utils/noFollowFs.js';
import { MAX_SERVER_FILE_BYTES } from '../utils/serverFiles.js';
import { outboundErrorMessage, safeDownload } from '../utils/safeFetch.js';
import { removeReplacedFile } from '../utils/replacedFile.js';

// Security: Regex pattern for validating project IDs
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const VERSION_PATTERN = /^[a-zA-Z0-9._-]{1,32}$/;

// Modtale API Configuration
const MODTALE_API_BASE = 'https://api.modtale.net';
const MODTALE_CDN_BASE = 'https://cdn.modtale.net';
// Downloads (API and CDN) stay on Modtale's own hosts.
export const MODTALE_DOWNLOAD_HOSTS = ['modtale.net'];

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ============== Types ==============

export interface ModtaleProject {
  id: string;
  title: string;
  author: string;
  classification: 'PLUGIN' | 'DATA' | 'ART' | 'SAVE' | 'MODPACK';
  description: string;
  imageUrl?: string;
  downloads: number;
  rating: number;
  updatedAt: string;
  tags: string[];
}

export interface ModtaleVersion {
  id: string;
  versionNumber: string;
  fileUrl: string;
  downloadCount: number;
  gameVersions?: string[];
  changelog?: string;
  channel?: 'RELEASE' | 'BETA' | 'ALPHA';
}

export interface ModtaleProjectDetails extends ModtaleProject {
  about?: string; // Markdown description
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'UNLISTED';
  versions: ModtaleVersion[];
  galleryImages: string[];
  license?: string;
  repositoryUrl?: string;
}

export interface ModtaleSearchResult {
  content: ModtaleProject[];
  totalPages: number;
  totalElements: number;
}

export interface ModtaleInstallResult {
  success: boolean;
  error?: string;
  filename?: string;
  version?: string;
  projectId?: string;
  projectTitle?: string;
}

export type ModtaleSortOption =
  'relevance' | 'downloads' | 'updated' | 'newest' | 'rating' | 'favorites';
export type ModtaleClassification = 'PLUGIN' | 'DATA' | 'ART' | 'SAVE' | 'MODPACK';

// Available tags from Modtale
export const MODTALE_TAGS = [
  'Adventure',
  'RPG',
  'Sci-Fi',
  'Fantasy',
  'Survival',
  'Magic',
  'Tech',
  'Exploration',
  'Minigame',
  'PvP',
  'Parkour',
  'Hardcore',
  'Skyblock',
  'Puzzle',
  'Quests',
  'Economy',
  'Protection',
  'Admin Tools',
  'Chat',
  'Anti-Cheat',
  'Performance',
  'Library',
  'API',
  'Mechanics',
  'World Gen',
  'Recipes',
  'Loot Tables',
  'Functions',
  'Decoration',
  'Vanilla+',
  'Kitchen Sink',
  'City',
  'Landscape',
  'Spawn',
  'Lobby',
  'Medieval',
  'Modern',
  'Futuristic',
  'Models',
  'Textures',
  'Animations',
  'Particles',
] as const;

// ============== Cache ==============

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache: Map<string, CacheEntry<unknown>> = new Map();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data as T;
  }
  cache.delete(key);
  return null;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

export function clearModtaleCache(): void {
  cache.clear();
  logger.info('Modtale cache cleared');
}

// ============== Installed Mods Tracking ==============

interface InstalledModInfo {
  projectId: string;
  projectTitle: string;
  version: string;
  filename: string;
  classification: ModtaleClassification;
  installedAt: string;
}

interface InstalledModsData {
  mods: Record<string, InstalledModInfo>;
}

// Kept in each server's data folder: every server has its own install list.
const INSTALLED_MODS_FILE = 'modtale-installed.json';

function getInstalledModsPath(server: ServerContext): string {
  return path.join(server.paths.data, INSTALLED_MODS_FILE);
}

async function loadInstalledMods(server: ServerContext): Promise<InstalledModsData> {
  try {
    // In the server's data folder: only a regular file there is read.
    const data = await readRegularFile(getInstalledModsPath(server), [server.paths.data], {
      maxBytes: MAX_SERVER_FILE_BYTES,
    });
    return JSON.parse(data.toString('utf-8'));
  } catch {
    return { mods: {} };
  }
}

async function saveInstalledMods(server: ServerContext, data: InstalledModsData): Promise<void> {
  try {
    const filePath = getInstalledModsPath(server);
    // Ensure data directory exists
    await mkdir(path.dirname(filePath), { recursive: true });
    await replaceFileContent(filePath, JSON.stringify(data, null, 2), [server.paths.data]);
  } catch (e) {
    logger.error('Failed to save installed mods tracking:', e);
  }
}

export async function getInstalledModtaleInfo(
  server: ServerContext,
): Promise<Record<string, InstalledModInfo>> {
  const data = await loadInstalledMods(server);
  return data.mods;
}

export async function isModtaleModInstalled(
  server: ServerContext,
  projectId: string,
): Promise<InstalledModInfo | null> {
  const data = await loadInstalledMods(server);
  return data.mods[projectId] || null;
}

async function trackInstalledMod(server: ServerContext, info: InstalledModInfo): Promise<void> {
  const data = await loadInstalledMods(server);
  data.mods[info.projectId] = info;
  await saveInstalledMods(server, data);
}

export async function untrackInstalledMod(
  server: ServerContext,
  projectId: string,
): Promise<boolean> {
  const data = await loadInstalledMods(server);
  if (data.mods[projectId]) {
    delete data.mods[projectId];
    await saveInstalledMods(server, data);
    return true;
  }
  return false;
}

/** Folder a project of this classification goes to; Hytale loads plugins from mods/ too. */
function folderFor(server: ServerContext, classification: ModtaleClassification): string {
  switch (classification) {
    case 'DATA':
    case 'ART':
    case 'SAVE':
      return server.paths.data;
    case 'PLUGIN':
    case 'MODPACK':
    default:
      return server.paths.mods;
  }
}

// ============== Security Validation ==============

/**
 * Validate a project ID to prevent injection attacks
 */
export function isValidProjectId(projectId: string): boolean {
  if (!projectId || typeof projectId !== 'string') {
    return false;
  }
  return PROJECT_ID_PATTERN.test(projectId);
}

/**
 * Validate a version string to prevent path traversal
 */
export function isValidVersion(version: string): boolean {
  if (!version || typeof version !== 'string') {
    return false;
  }
  return VERSION_PATTERN.test(version);
}

/**
 * Sanitize a string for use in filenames
 * Returns null if the string cannot be safely sanitized
 */
function sanitizeForFilename(input: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }
  // Remove any path traversal attempts and invalid characters
  const sanitized = input
    .replace(/\.\./g, '') // Remove path traversal
    .replace(/[/\\:*?"<>|]/g, '') // Remove invalid filename chars
    .replace(/[^a-zA-Z0-9._-]/g, '-') // Replace other chars with dash
    .replace(/-+/g, '-') // Collapse multiple dashes
    .replace(/^-|-$/g, '') // Remove leading/trailing dashes
    .slice(0, 64); // Limit length

  if (!sanitized || sanitized.length === 0) {
    return null;
  }

  return sanitized;
}

// ============== API Client ==============

/**
 * Get the Modtale API key from config/environment
 */
function getApiKey(): string | undefined {
  // config-first so a key set in the Settings UI (config.json, hot-reloaded)
  // wins over the env var.
  const key = config.modtaleApiKey || process.env.MODTALE_API_KEY;
  // Only log on first call
  if (key && !apiKeyLogged) {
    logger.info(`[Modtale] API key configured (${key.substring(0, 6)}...)`);
    apiKeyLogged = true;
  }
  return key || undefined;
}

let apiKeyLogged = false;

/**
 * Make a request to the Modtale API
 */
async function modtaleRequest<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    requireAuth?: boolean;
  } = {},
): Promise<T | null> {
  const { method = 'GET', body, requireAuth = false } = options;
  const apiKey = getApiKey();

  if (requireAuth && !apiKey) {
    logger.error('Modtale API key required but not configured');
    return null;
  }

  return new Promise((resolve) => {
    const url = new URL(endpoint, MODTALE_API_BASE);

    const headers: Record<string, string> = {
      'User-Agent': 'KyuubiSoft-HytalePanel/1.0',
      Accept: 'application/json',
    };

    if (apiKey) {
      headers['X-MODTALE-KEY'] = apiKey;
    }

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const requestOptions: https.RequestOptions = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else if (res.statusCode === 429) {
            logger.error('Modtale API rate limit exceeded');
            resolve(null);
          } else {
            logger.error(`Modtale API error: ${res.statusCode} - ${data}`);
            resolve(null);
          }
        } catch (e) {
          logger.error('Failed to parse Modtale response:', e);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      logger.error('Modtale request error:', e);
      resolve(null);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Download a mod file from Modtale. Modtale states no size or hash for its
 * files, so only the host, size limit and time limit are checked.
 */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
  try {
    // destPath is <folder>/<plain name>. The game server can write to that
    // folder: the file is replaced, never written through a link planted
    // under its name.
    await safeDownload(url, {
      allowedHosts: MODTALE_DOWNLOAD_HOSTS,
      headers: { 'User-Agent': 'KyuubiSoft-HytalePanel/1.0' },
      saveTo: destPath,
    });
    return true;
  } catch (e) {
    logger.error(`[Modtale] Download failed: ${outboundErrorMessage(e)}`);
    return false;
  }
}

// ============== Public API ==============

/**
 * Search for mods on Modtale
 */
export async function searchMods(
  options: {
    search?: string;
    page?: number;
    size?: number;
    sort?: ModtaleSortOption;
    classification?: ModtaleClassification;
    tags?: string[];
    gameVersion?: string;
    author?: string;
  } = {},
): Promise<ModtaleSearchResult | null> {
  const {
    search,
    page = 0,
    size = 20,
    sort = 'downloads',
    classification,
    tags,
    gameVersion,
    author,
  } = options;

  // Build cache key
  const cacheKey = `search:${JSON.stringify(options)}`;
  const cached = getCached<ModtaleSearchResult>(cacheKey);
  if (cached) {
    return cached;
  }

  // Build query params
  const params = new URLSearchParams();
  if (search) params.append('search', search);
  params.append('page', page.toString());
  params.append('size', size.toString());
  params.append('sort', sort);
  if (classification) params.append('classification', classification);
  if (tags && tags.length > 0) params.append('tags', tags.join(','));
  if (gameVersion) params.append('gameVersion', gameVersion);
  if (author) params.append('author', author);

  const result = await modtaleRequest<ModtaleSearchResult>(`/api/v1/projects?${params.toString()}`);

  if (result) {
    setCache(cacheKey, result);
  }

  return result;
}

/**
 * Get mod details by ID
 */
export async function getModDetails(projectId: string): Promise<ModtaleProjectDetails | null> {
  // Security: Validate projectId before using in URL
  if (!isValidProjectId(projectId)) {
    logger.error(`Invalid project ID format: ${projectId}`);
    return null;
  }

  const cacheKey = `project:${projectId}`;
  const cached = getCached<ModtaleProjectDetails>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await modtaleRequest<ModtaleProjectDetails>(
    `/api/v1/projects/${encodeURIComponent(projectId)}`,
  );

  if (result) {
    setCache(cacheKey, result);
  }

  return result;
}

/**
 * Get available tags from Modtale
 */
export async function getTags(): Promise<string[]> {
  const cacheKey = 'tags';
  const cached = getCached<string[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await modtaleRequest<string[]>('/api/v1/tags');

  if (result) {
    setCache(cacheKey, result);
    return result;
  }

  // Return hardcoded tags as fallback
  return [...MODTALE_TAGS];
}

/**
 * Get available classifications
 */
export async function getClassifications(): Promise<string[]> {
  const cacheKey = 'classifications';
  const cached = getCached<string[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await modtaleRequest<string[]>('/api/v1/meta/classifications');

  if (result) {
    setCache(cacheKey, result);
    return result;
  }

  return ['PLUGIN', 'DATA', 'ART', 'SAVE', 'MODPACK'];
}

/**
 * Get supported game versions
 */
export async function getGameVersions(): Promise<string[]> {
  const cacheKey = 'gameVersions';
  const cached = getCached<string[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await modtaleRequest<string[]>('/api/v1/meta/game-versions');

  if (result) {
    setCache(cacheKey, result);
    return result;
  }

  return ['1.0-SNAPSHOT'];
}

/**
 * Install a mod from Modtale
 */
export async function installModFromModtale(
  server: ServerContext,
  projectId: string,
  versionId?: string,
): Promise<ModtaleInstallResult> {
  // Security: Validate projectId
  if (!isValidProjectId(projectId)) {
    return { success: false, error: 'Invalid project ID format' };
  }

  // Security: Validate versionId if provided
  if (versionId && !isValidVersion(versionId)) {
    return { success: false, error: 'Invalid version ID format' };
  }

  // Get project details (getModDetails also validates projectId)
  const project = await getModDetails(projectId);
  if (!project) {
    return { success: false, error: 'Project not found or API unavailable' };
  }

  if (!project.versions || project.versions.length === 0) {
    return { success: false, error: 'No versions available for this project' };
  }

  // Find the version to install
  let version: ModtaleVersion | undefined;
  if (versionId) {
    version = project.versions.find((v) => v.id === versionId || v.versionNumber === versionId);
    if (!version) {
      return { success: false, error: `Version ${versionId} not found` };
    }
  } else {
    // Get latest version (first in array, or find RELEASE channel)
    version = project.versions.find((v) => v.channel === 'RELEASE') || project.versions[0];
  }

  if (!version.fileUrl) {
    return { success: false, error: 'No download URL available for this version' };
  }

  // Security: Validate version number from API response
  const safeVersion = sanitizeForFilename(version.versionNumber);
  if (!safeVersion) {
    return { success: false, error: 'Invalid version number in API response' };
  }

  // Security: Sanitize project title for filename
  const safeTitle = sanitizeForFilename(project.title);
  if (!safeTitle) {
    return { success: false, error: 'Invalid project title for filename' };
  }

  // Construct download URL with encoded components
  let downloadUrl = version.fileUrl;
  if (!downloadUrl.startsWith('http')) {
    // Relative URL - construct full URL with encoded components
    downloadUrl = `${MODTALE_API_BASE}/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(safeVersion)}/download`;
  }

  // Generate filename from sanitized project title and version
  const extension = project.classification === 'PLUGIN' ? 'jar' : 'zip';
  const filename = `${safeTitle}-${safeVersion}.${extension}`;

  // Security: Final filename validation using existing utility
  const validatedFilename = sanitizeFileName(filename);
  if (!validatedFilename) {
    return { success: false, error: 'Generated filename failed security validation' };
  }

  // Choose target directory based on classification
  const targetPath = folderFor(server, project.classification);

  // Ensure target directory exists
  try {
    await access(targetPath);
  } catch {
    await mkdir(targetPath, { recursive: true });
  }

  // An update: the old file is removed once the new one is in place.
  const existingInstall = await isModtaleModInstalled(server, projectId);

  // Security: Construct destination path and verify it's within allowed directory
  const destPath = path.join(targetPath, validatedFilename);
  const resolvedDest = path.resolve(destPath);
  const resolvedTarget = path.resolve(targetPath);

  if (!resolvedDest.startsWith(resolvedTarget + path.sep)) {
    logger.error(`Path traversal attempt detected: ${destPath}`);
    return { success: false, error: 'Invalid destination path' };
  }

  // Download the file
  const downloaded = await downloadFile(downloadUrl, destPath);

  if (!downloaded) {
    return { success: false, error: 'Failed to download mod file' };
  }

  if (existingInstall?.filename) {
    const oldBasePath = folderFor(server, existingInstall.classification);
    // The stored filename is untrusted (shared data dir): only a bare name in the base folder.
    const oldFilePath = resolveFileInDir(oldBasePath, existingInstall.filename);
    await removeReplacedFile(oldFilePath, destPath, '[Modtale]');
  }

  // Track the installed mod
  await trackInstalledMod(server, {
    projectId: project.id,
    projectTitle: project.title,
    version: safeVersion,
    filename: validatedFilename,
    classification: project.classification,
    installedAt: new Date().toISOString(),
  });

  return {
    success: true,
    filename: validatedFilename,
    version: safeVersion,
    projectId: project.id,
    projectTitle: project.title,
  };
}

/**
 * Check if Modtale API is configured and available
 */
export async function checkModtaleStatus(): Promise<{
  configured: boolean;
  hasApiKey: boolean;
  apiAvailable: boolean;
  rateLimit?: {
    tier: string;
    limit: number;
  };
}> {
  const apiKey = getApiKey();
  const hasApiKey = !!apiKey;

  // Try a simple search request to check if API is available
  // This is more reliable than meta endpoints which may not exist
  const result = await modtaleRequest<ModtaleSearchResult>('/api/v1/projects?size=1');

  return {
    configured: true,
    hasApiKey,
    apiAvailable: result !== null && Array.isArray(result.content),
    rateLimit: hasApiKey ? { tier: 'Standard', limit: 300 } : { tier: 'No Auth', limit: 10 },
  };
}

/**
 * Get featured/popular mods
 */
export async function getFeaturedMods(limit: number = 10): Promise<ModtaleProject[]> {
  const result = await searchMods({
    sort: 'downloads',
    size: limit,
    classification: 'PLUGIN',
  });

  return result?.content || [];
}

/**
 * Get recently updated mods
 */
export async function getRecentMods(limit: number = 10): Promise<ModtaleProject[]> {
  const result = await searchMods({
    sort: 'updated',
    size: limit,
  });

  return result?.content || [];
}

/**
 * Uninstall a Modtale mod
 */
export async function uninstallModtale(
  server: ServerContext,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  // Security: Validate projectId
  if (!isValidProjectId(projectId)) {
    return { success: false, error: 'Invalid project ID format' };
  }

  const installed = await isModtaleModInstalled(server, projectId);
  if (!installed) {
    return { success: false, error: 'Mod is not installed' };
  }

  const basePath = folderFor(server, installed.classification);

  // Security: the stored filename (shared data dir) must be a bare name in the base folder -
  // "sub/x.jar" through a symlinked sub folder would pass a plain prefix check.
  const filePath = resolveFileInDir(basePath, installed.filename);
  if (!filePath) {
    return { success: false, error: 'Invalid file path' };
  }

  try {
    await unlink(filePath);
  } catch (e) {
    logger.error('Failed to delete mod file:', e);
    // Continue to untrack even if file doesn't exist
  }

  await untrackInstalledMod(server, projectId);

  return { success: true };
}

export default {
  searchMods,
  getModDetails,
  getTags,
  getClassifications,
  getGameVersions,
  installModFromModtale,
  uninstallModtale,
  checkModtaleStatus,
  getFeaturedMods,
  getRecentMods,
  clearModtaleCache,
  isValidProjectId,
  isValidVersion,
  getInstalledModtaleInfo,
  isModtaleModInstalled,
  MODTALE_TAGS,
};
