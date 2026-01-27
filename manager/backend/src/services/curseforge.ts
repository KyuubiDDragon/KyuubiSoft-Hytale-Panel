/**
 * CurseForge Service
 * Integration with the CurseForge API for browsing and installing mods
 * API Documentation: https://docs.curseforge.com/rest-api/
 */

import { writeFile, mkdir, access, readFile, unlink } from 'fs/promises';
import path from 'path';
import https from 'https';
import { config } from '../config.js';
import { sanitizeFileName } from '../utils/pathSecurity.js';

// Security: Regex pattern for validating mod IDs (CurseForge uses numeric IDs)
const MOD_ID_PATTERN = /^\d{1,10}$/;
const FILE_ID_PATTERN = /^\d{1,10}$/;
const VERSION_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

// CurseForge API Configuration
const CURSEFORGE_API_BASE = 'api.curseforge.com';
const CURSEFORGE_CDN_BASE = 'edge.forgecdn.net';

// Game IDs - Hytale doesn't have an official ID yet, but this can be configured
// For now, we'll use a generic approach that can work with any game
const DEFAULT_GAME_ID = 432; // Minecraft as fallback since Hytale mods may be similar

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ============== Types ==============

export interface CurseForgeCategory {
  id: number;
  gameId: number;
  name: string;
  slug: string;
  url: string;
  iconUrl: string;
  parentCategoryId?: number;
  isClass?: boolean;
}

export interface CurseForgeMod {
  id: number;
  gameId: number;
  name: string;
  slug: string;
  links: {
    websiteUrl: string;
    wikiUrl?: string;
    issuesUrl?: string;
    sourceUrl?: string;
  };
  summary: string;
  status: number;
  downloadCount: number;
  isFeatured: boolean;
  primaryCategoryId: number;
  categories: CurseForgeCategory[];
  classId?: number;
  authors: Array<{
    id: number;
    name: string;
    url: string;
  }>;
  logo?: {
    id: number;
    modId: number;
    title: string;
    thumbnailUrl: string;
    url: string;
  };
  screenshots?: Array<{
    id: number;
    modId: number;
    title: string;
    thumbnailUrl: string;
    url: string;
  }>;
  mainFileId: number;
  latestFiles: CurseForgeFile[];
  latestFilesIndexes: Array<{
    gameVersion: string;
    fileId: number;
    filename: string;
    releaseType: number;
    gameVersionTypeId?: number;
    modLoader?: number;
  }>;
  dateCreated: string;
  dateModified: string;
  dateReleased: string;
  allowModDistribution?: boolean;
  gamePopularityRank: number;
  thumbsUpCount?: number;
}

export interface CurseForgeFile {
  id: number;
  gameId: number;
  modId: number;
  isAvailable: boolean;
  displayName: string;
  fileName: string;
  releaseType: 1 | 2 | 3; // 1=Release, 2=Beta, 3=Alpha
  fileStatus: number;
  hashes: Array<{
    value: string;
    algo: number; // 1=SHA1, 2=MD5
  }>;
  fileDate: string;
  fileLength: number;
  downloadCount: number;
  downloadUrl: string | null;
  gameVersions: string[];
  sortableGameVersions?: Array<{
    gameVersionName: string;
    gameVersionPadded: string;
    gameVersion: string;
    gameVersionReleaseDate: string;
    gameVersionTypeId?: number;
  }>;
  dependencies?: Array<{
    modId: number;
    relationType: number; // 1=EmbeddedLib, 2=OptionalDep, 3=RequiredDep, 4=Tool, 5=Incompatible, 6=Include
  }>;
  modules?: Array<{
    name: string;
    fingerprint: number;
  }>;
  fileFingerprint: number;
}

export interface CurseForgeSearchResult {
  data: CurseForgeMod[];
  pagination: {
    index: number;
    pageSize: number;
    resultCount: number;
    totalCount: number;
  };
}

export interface CurseForgeModDetails {
  data: CurseForgeMod;
}

export interface CurseForgeFilesResult {
  data: CurseForgeFile[];
  pagination: {
    index: number;
    pageSize: number;
    resultCount: number;
    totalCount: number;
  };
}

export interface CurseForgeInstallResult {
  success: boolean;
  error?: string;
  filename?: string;
  version?: string;
  modId?: number;
  modName?: string;
}

export type CurseForgeSortField =
  | 'Featured'
  | 'Popularity'
  | 'LastUpdated'
  | 'Name'
  | 'Author'
  | 'TotalDownloads'
  | 'Category'
  | 'GameVersion';

export type CurseForgeSortOrder = 'asc' | 'desc';

// Release types
export const RELEASE_TYPES = {
  1: 'Release',
  2: 'Beta',
  3: 'Alpha',
} as const;

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

export function clearCurseForgeCache(): void {
  cache.clear();
  console.log('CurseForge cache cleared');
}

// ============== Installed Mods Tracking ==============

interface InstalledModInfo {
  modId: number;
  modName: string;
  fileId: number;
  version: string;
  filename: string;
  installedAt: string;
  releaseType: number;
  gameVersions: string[];
}

interface InstalledModsData {
  mods: Record<string, InstalledModInfo>;
}

const INSTALLED_MODS_FILE = 'curseforge-installed.json';

function getInstalledModsPath(): string {
  return path.join(config.dataPath, INSTALLED_MODS_FILE);
}

async function loadInstalledMods(): Promise<InstalledModsData> {
  try {
    const filePath = getInstalledModsPath();
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { mods: {} };
  }
}

async function saveInstalledMods(data: InstalledModsData): Promise<void> {
  try {
    const filePath = getInstalledModsPath();
    // Ensure data directory exists
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save installed mods tracking:', e);
  }
}

export async function getInstalledCurseForgeInfo(): Promise<Record<string, InstalledModInfo>> {
  const data = await loadInstalledMods();
  return data.mods;
}

export async function isCurseForgeModInstalled(modId: number): Promise<InstalledModInfo | null> {
  const data = await loadInstalledMods();
  return data.mods[modId.toString()] || null;
}

async function trackInstalledMod(info: InstalledModInfo): Promise<void> {
  const data = await loadInstalledMods();
  data.mods[info.modId.toString()] = info;
  await saveInstalledMods(data);
}

export async function untrackInstalledMod(modId: number): Promise<boolean> {
  const data = await loadInstalledMods();
  const key = modId.toString();
  if (data.mods[key]) {
    delete data.mods[key];
    await saveInstalledMods(data);
    return true;
  }
  return false;
}

// ============== Security Validation ==============

/**
 * Validate a mod ID to prevent injection attacks
 */
export function isValidModId(modId: string | number): boolean {
  const idStr = modId.toString();
  if (!idStr || typeof idStr !== 'string') {
    return false;
  }
  return MOD_ID_PATTERN.test(idStr);
}

/**
 * Validate a file ID
 */
export function isValidFileId(fileId: string | number): boolean {
  const idStr = fileId.toString();
  if (!idStr || typeof idStr !== 'string') {
    return false;
  }
  return FILE_ID_PATTERN.test(idStr);
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
 * Get the CurseForge API key from config/environment
 */
function getApiKey(): string | undefined {
  const key = process.env.CURSEFORGE_API_KEY || config.curseforgeApiKey;
  // Only log on first call
  if (key && !apiKeyLogged) {
    console.log(`[CurseForge] API key configured (${key.substring(0, 6)}...)`);
    apiKeyLogged = true;
  }
  return key || undefined;
}

/**
 * Get the configured game ID
 */
function getGameId(): number {
  return config.curseforgeGameId || DEFAULT_GAME_ID;
}

let apiKeyLogged = false;

/**
 * Make a request to the CurseForge API
 */
async function curseforgeRequest<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
  } = {}
): Promise<T | null> {
  const { method = 'GET', body } = options;
  const apiKey = getApiKey();

  if (!apiKey) {
    console.error('CurseForge API key not configured');
    return null;
  }

  return new Promise((resolve) => {
    const url = new URL(`https://${CURSEFORGE_API_BASE}${endpoint}`);

    const headers: Record<string, string> = {
      'User-Agent': 'KyuubiSoft-HytalePanel/1.0',
      'Accept': 'application/json',
      'x-api-key': apiKey,
    };

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
          } else if (res.statusCode === 403) {
            console.error('CurseForge API key invalid or access denied');
            resolve(null);
          } else if (res.statusCode === 429) {
            console.error('CurseForge API rate limit exceeded');
            resolve(null);
          } else {
            console.error(`CurseForge API error: ${res.statusCode} - ${data}`);
            resolve(null);
          }
        } catch (e) {
          console.error('Failed to parse CurseForge response:', e);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('CurseForge request error:', e);
      resolve(null);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Download a file from URL
 */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = (currentUrl: string) => {
      const urlObj = new URL(currentUrl);
      const proto = https;

      const options: https.RequestOptions = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: {
          'User-Agent': 'KyuubiSoft-HytalePanel/1.0',
        },
      };

      proto.get(options, (res) => {
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

// ============== Public API ==============

/**
 * Search for mods on CurseForge
 */
export async function searchMods(options: {
  search?: string;
  gameId?: number;
  classId?: number;
  categoryId?: number;
  gameVersion?: string;
  modLoaderType?: number;
  sortField?: CurseForgeSortField;
  sortOrder?: CurseForgeSortOrder;
  pageSize?: number;
  index?: number;
} = {}): Promise<CurseForgeSearchResult | null> {
  const {
    search,
    gameId = getGameId(),
    classId,
    categoryId,
    gameVersion,
    modLoaderType,
    sortField = 'Popularity',
    sortOrder = 'desc',
    pageSize = 20,
    index = 0,
  } = options;

  // Build cache key
  const cacheKey = `search:${JSON.stringify(options)}`;
  const cached = getCached<CurseForgeSearchResult>(cacheKey);
  if (cached) {
    return cached;
  }

  // Build query params
  const params = new URLSearchParams();
  params.append('gameId', gameId.toString());
  if (search) params.append('searchFilter', search);
  if (classId) params.append('classId', classId.toString());
  if (categoryId) params.append('categoryId', categoryId.toString());
  if (gameVersion) params.append('gameVersion', gameVersion);
  if (modLoaderType) params.append('modLoaderType', modLoaderType.toString());
  params.append('sortField', sortField);
  params.append('sortOrder', sortOrder);
  params.append('pageSize', pageSize.toString());
  params.append('index', index.toString());

  const result = await curseforgeRequest<CurseForgeSearchResult>(`/v1/mods/search?${params.toString()}`);

  if (result) {
    setCache(cacheKey, result);
  }

  return result;
}

/**
 * Get mod details by ID
 */
export async function getModDetails(modId: number): Promise<CurseForgeMod | null> {
  // Security: Validate modId before using in URL
  if (!isValidModId(modId)) {
    console.error(`Invalid mod ID format: ${modId}`);
    return null;
  }

  const cacheKey = `mod:${modId}`;
  const cached = getCached<CurseForgeModDetails>(cacheKey);
  if (cached) {
    return cached.data;
  }

  const result = await curseforgeRequest<CurseForgeModDetails>(`/v1/mods/${modId}`);

  if (result) {
    setCache(cacheKey, result);
    return result.data;
  }

  return null;
}

/**
 * Get files for a mod
 */
export async function getModFiles(
  modId: number,
  options: {
    gameVersion?: string;
    modLoaderType?: number;
    pageSize?: number;
    index?: number;
  } = {}
): Promise<CurseForgeFile[] | null> {
  // Security: Validate modId before using in URL
  if (!isValidModId(modId)) {
    console.error(`Invalid mod ID format: ${modId}`);
    return null;
  }

  const { gameVersion, modLoaderType, pageSize = 50, index = 0 } = options;

  const cacheKey = `files:${modId}:${JSON.stringify(options)}`;
  const cached = getCached<CurseForgeFilesResult>(cacheKey);
  if (cached) {
    return cached.data;
  }

  const params = new URLSearchParams();
  if (gameVersion) params.append('gameVersion', gameVersion);
  if (modLoaderType) params.append('modLoaderType', modLoaderType.toString());
  params.append('pageSize', pageSize.toString());
  params.append('index', index.toString());

  const result = await curseforgeRequest<CurseForgeFilesResult>(
    `/v1/mods/${modId}/files?${params.toString()}`
  );

  if (result) {
    setCache(cacheKey, result);
    return result.data;
  }

  return null;
}

/**
 * Get a specific file
 */
export async function getFile(modId: number, fileId: number): Promise<CurseForgeFile | null> {
  if (!isValidModId(modId) || !isValidFileId(fileId)) {
    console.error(`Invalid mod/file ID format: ${modId}/${fileId}`);
    return null;
  }

  const cacheKey = `file:${modId}:${fileId}`;
  const cached = getCached<{ data: CurseForgeFile }>(cacheKey);
  if (cached) {
    return cached.data;
  }

  const result = await curseforgeRequest<{ data: CurseForgeFile }>(`/v1/mods/${modId}/files/${fileId}`);

  if (result) {
    setCache(cacheKey, result);
    return result.data;
  }

  return null;
}

/**
 * Get download URL for a file
 * Note: Some mods disable third-party downloads - in that case, downloadUrl will be null
 */
export async function getDownloadUrl(modId: number, fileId: number): Promise<string | null> {
  if (!isValidModId(modId) || !isValidFileId(fileId)) {
    return null;
  }

  const result = await curseforgeRequest<{ data: string }>(
    `/v1/mods/${modId}/files/${fileId}/download-url`
  );

  return result?.data || null;
}

/**
 * Get categories for a game
 */
export async function getCategories(gameId?: number): Promise<CurseForgeCategory[] | null> {
  const id = gameId || getGameId();

  const cacheKey = `categories:${id}`;
  const cached = getCached<{ data: CurseForgeCategory[] }>(cacheKey);
  if (cached) {
    return cached.data;
  }

  const result = await curseforgeRequest<{ data: CurseForgeCategory[] }>(
    `/v1/categories?gameId=${id}`
  );

  if (result) {
    setCache(cacheKey, result);
    return result.data;
  }

  return null;
}

/**
 * Install a mod from CurseForge
 */
export async function installModFromCurseForge(
  modId: number,
  fileId?: number
): Promise<CurseForgeInstallResult> {
  // Security: Validate modId
  if (!isValidModId(modId)) {
    return { success: false, error: 'Invalid mod ID format' };
  }

  // Security: Validate fileId if provided
  if (fileId && !isValidFileId(fileId)) {
    return { success: false, error: 'Invalid file ID format' };
  }

  // Get mod details
  const mod = await getModDetails(modId);
  if (!mod) {
    return { success: false, error: 'Mod not found or API unavailable' };
  }

  // Check if third-party downloads are allowed
  if (mod.allowModDistribution === false) {
    return {
      success: false,
      error: 'This mod does not allow third-party downloads. Please download manually from CurseForge.',
      modName: mod.name,
      modId: mod.id,
    };
  }

  // Get the file to install
  let file: CurseForgeFile | null | undefined;

  if (fileId) {
    file = await getFile(modId, fileId);
    if (!file) {
      return { success: false, error: `File ${fileId} not found` };
    }
  } else {
    // Get the main/latest file
    if (mod.latestFiles && mod.latestFiles.length > 0) {
      // Prefer release versions
      file = mod.latestFiles.find(f => f.releaseType === 1) || mod.latestFiles[0];
    }

    if (!file) {
      // Fetch files separately
      const files = await getModFiles(modId);
      if (!files || files.length === 0) {
        return { success: false, error: 'No files available for this mod' };
      }
      file = files.find(f => f.releaseType === 1) || files[0];
    }
  }

  if (!file) {
    return { success: false, error: 'Could not find a file to install' };
  }

  // Get download URL
  let downloadUrl = file.downloadUrl;
  if (!downloadUrl) {
    downloadUrl = await getDownloadUrl(modId, file.id);
  }

  if (!downloadUrl) {
    return {
      success: false,
      error: 'Download URL not available. This mod may not allow third-party downloads.',
      modName: mod.name,
      modId: mod.id,
    };
  }

  // Security: Sanitize filename
  const safeFilename = sanitizeFileName(file.fileName);
  if (!safeFilename) {
    // Use a generated filename if original is problematic
    const safeName = sanitizeForFilename(mod.name);
    if (!safeName) {
      return { success: false, error: 'Could not generate safe filename' };
    }
    const ext = file.fileName.endsWith('.jar') ? '.jar' : '.zip';
    // Use safe filename construction
  }

  const filename = safeFilename || `${sanitizeForFilename(mod.name)}-${file.id}.jar`;

  // Determine target path - mods go to mods directory
  const targetPath = config.modsPath;

  // Ensure target directory exists
  try {
    await access(targetPath);
  } catch {
    await mkdir(targetPath, { recursive: true });
  }

  // Security: Construct destination path and verify it's within allowed directory
  const destPath = path.join(targetPath, filename);
  const resolvedDest = path.resolve(destPath);
  const resolvedTarget = path.resolve(targetPath);

  if (!resolvedDest.startsWith(resolvedTarget + path.sep)) {
    console.error(`Path traversal attempt detected: ${destPath}`);
    return { success: false, error: 'Invalid destination path' };
  }

  // Download the file
  const downloaded = await downloadFile(downloadUrl, destPath);

  if (!downloaded) {
    return { success: false, error: 'Failed to download mod file' };
  }

  // Track the installed mod
  await trackInstalledMod({
    modId: mod.id,
    modName: mod.name,
    fileId: file.id,
    version: file.displayName,
    filename,
    installedAt: new Date().toISOString(),
    releaseType: file.releaseType,
    gameVersions: file.gameVersions,
  });

  return {
    success: true,
    filename,
    version: file.displayName,
    modId: mod.id,
    modName: mod.name,
  };
}

/**
 * Check if CurseForge API is configured and available
 */
export async function checkCurseForgeStatus(): Promise<{
  configured: boolean;
  hasApiKey: boolean;
  apiAvailable: boolean;
  gameId: number;
}> {
  const apiKey = getApiKey();
  const hasApiKey = !!apiKey;
  const gameId = getGameId();

  if (!hasApiKey) {
    return {
      configured: false,
      hasApiKey: false,
      apiAvailable: false,
      gameId,
    };
  }

  // Try a simple search request to check if API is available
  const result = await searchMods({ pageSize: 1 });

  return {
    configured: true,
    hasApiKey,
    apiAvailable: result !== null,
    gameId,
  };
}

/**
 * Get featured/popular mods
 */
export async function getFeaturedMods(limit: number = 10): Promise<CurseForgeMod[]> {
  const result = await searchMods({
    sortField: 'Featured',
    pageSize: limit,
  });

  return result?.data || [];
}

/**
 * Get recently updated mods
 */
export async function getRecentMods(limit: number = 10): Promise<CurseForgeMod[]> {
  const result = await searchMods({
    sortField: 'LastUpdated',
    pageSize: limit,
  });

  return result?.data || [];
}

/**
 * Get popular mods
 */
export async function getPopularMods(limit: number = 10): Promise<CurseForgeMod[]> {
  const result = await searchMods({
    sortField: 'Popularity',
    pageSize: limit,
  });

  return result?.data || [];
}

/**
 * Check for updates for installed mods
 */
export async function checkForUpdates(): Promise<Array<{
  modId: number;
  modName: string;
  currentFileId: number;
  currentVersion: string;
  latestFileId: number;
  latestVersion: string;
  releaseType: number;
  hasUpdate: boolean;
}>> {
  const installed = await getInstalledCurseForgeInfo();
  const updates: Array<{
    modId: number;
    modName: string;
    currentFileId: number;
    currentVersion: string;
    latestFileId: number;
    latestVersion: string;
    releaseType: number;
    hasUpdate: boolean;
  }> = [];

  for (const [, info] of Object.entries(installed)) {
    const mod = await getModDetails(info.modId);
    if (!mod) continue;

    // Find the latest file matching the same release type or better
    const latestFile = mod.latestFiles?.find(f => f.releaseType <= info.releaseType);

    if (latestFile && latestFile.id !== info.fileId) {
      updates.push({
        modId: info.modId,
        modName: info.modName,
        currentFileId: info.fileId,
        currentVersion: info.version,
        latestFileId: latestFile.id,
        latestVersion: latestFile.displayName,
        releaseType: latestFile.releaseType,
        hasUpdate: true,
      });
    } else {
      updates.push({
        modId: info.modId,
        modName: info.modName,
        currentFileId: info.fileId,
        currentVersion: info.version,
        latestFileId: latestFile?.id || info.fileId,
        latestVersion: latestFile?.displayName || info.version,
        releaseType: latestFile?.releaseType || info.releaseType,
        hasUpdate: false,
      });
    }
  }

  return updates;
}

/**
 * Update a mod to the latest version
 */
export async function updateMod(modId: number, fileId?: number): Promise<CurseForgeInstallResult> {
  // First check if mod is installed
  const installed = await isCurseForgeModInstalled(modId);
  if (!installed) {
    return { success: false, error: 'Mod is not installed' };
  }

  // Uninstall old version
  const uninstallResult = await uninstallCurseForge(modId);
  if (!uninstallResult.success) {
    return { success: false, error: `Failed to uninstall old version: ${uninstallResult.error}` };
  }

  // Install new version
  return installModFromCurseForge(modId, fileId);
}

/**
 * Uninstall a CurseForge mod
 */
export async function uninstallCurseForge(modId: number): Promise<{ success: boolean; error?: string }> {
  // Security: Validate modId
  if (!isValidModId(modId)) {
    return { success: false, error: 'Invalid mod ID format' };
  }

  const installed = await isCurseForgeModInstalled(modId);
  if (!installed) {
    return { success: false, error: 'Mod is not installed' };
  }

  const basePath = config.modsPath;
  const filePath = path.join(basePath, installed.filename);
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(basePath);

  // Security: Verify path is within allowed directory
  if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
    return { success: false, error: 'Invalid file path' };
  }

  try {
    await unlink(filePath);
  } catch (e) {
    console.error('Failed to delete mod file:', e);
    // Continue to untrack even if file doesn't exist
  }

  await untrackInstalledMod(modId);

  return { success: true };
}

export default {
  searchMods,
  getModDetails,
  getModFiles,
  getFile,
  getDownloadUrl,
  getCategories,
  installModFromCurseForge,
  uninstallCurseForge,
  updateMod,
  checkCurseForgeStatus,
  getFeaturedMods,
  getRecentMods,
  getPopularMods,
  checkForUpdates,
  clearCurseForgeCache,
  isValidModId,
  isValidFileId,
  isValidVersion,
  getInstalledCurseForgeInfo,
  isCurseForgeModInstalled,
  RELEASE_TYPES,
};
