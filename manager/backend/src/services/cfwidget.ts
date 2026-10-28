import { logger } from '../utils/logger.js';
/**
 * CFWidget Service
 * Free CurseForge API proxy for mod update checking
 * No API key required - uses https://api.cfwidget.com
 */

import { mkdir, access, unlink } from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import { resolveFileInDir, resolveRealPathWithin } from '../utils/pathSecurity.js';
import { listServers } from './servers.js';
import { checkServerFiles, contextFromServer, type ServerContext } from './serverContext.js';
import { readRegularFile, replaceFileContent } from '../utils/noFollowFs.js';
import { MAX_SERVER_FILE_BYTES } from '../utils/serverFiles.js';

// CFWidget API Configuration
const CFWIDGET_API_BASE = 'api.cfwidget.com';

// Cache configuration
const CACHE_TTL = 60 * 60 * 1000; // 1 hour (CFWidget caches for 1 hour anyway)
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

// ============== Types ==============

export interface CFWidgetFile {
  id: number;
  url: string;
  display: string;
  name: string;
  type: 'release' | 'beta' | 'alpha';
  version: string;
  filesize: number;
  versions: string[];
  downloads: number;
  uploaded_at: string;
}

export interface CFWidgetMember {
  title: string;
  username: string;
  id: number;
}

export interface CFWidgetProject {
  id: number;
  title: string;
  summary: string;
  description: string;
  game: string;
  type: string;
  urls: {
    curseforge: string;
    project: string;
  };
  thumbnail: string;
  created_at: string;
  downloads: {
    monthly: number;
    total: number;
  };
  license: string;
  donate: string;
  categories: string[];
  members: CFWidgetMember[];
  links: string[];
  files: CFWidgetFile[];
  versions: Record<string, CFWidgetFile[]>;
  download: CFWidgetFile; // Latest/recommended file
}

export interface TrackedMod {
  filename: string;
  curseforgeSlug: string;
  installedFileId?: number;
  installedVersion?: string;
  latestFileId?: number;
  latestVersion?: string;
  latestFileName?: string;
  hasUpdate: boolean;
  lastChecked: string;
  projectId?: number;
  projectTitle?: string;
  projectUrl?: string;
  thumbnail?: string;
  installed: boolean; // false = wishlist item, not yet installed
}

export interface ModUpdateStatus {
  totalTracked: number;
  updatesAvailable: number;
  lastChecked: string | null;
  mods: TrackedMod[];
}

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

export function clearCFWidgetCache(): void {
  cache.clear();
  logger.info('[CFWidget] Cache cleared');
}

// ============== Tracked Mods Storage ==============

// Kept in each server's data folder: every server tracks its own mods.
const TRACKED_MODS_FILE = 'cfwidget-tracked.json';

interface TrackedModsData {
  mods: Record<string, TrackedMod>;
  lastGlobalCheck: string | null;
}

// Tracked filenames become unlink() targets on update/uninstall, so they must
// be plain mod file names inside the mods folder - never a path.
const MOD_FILE_PATTERN = /\.(jar|zip)(\.disabled)?$/i;
const DOWNLOAD_FILE_PATTERN = /\.(jar|zip)$/i;
const SLUG_PATTERN = /^[a-z0-9_-]+$/i;
const WISHLIST_PREFIX = '[wishlist]';

/**
 * Resolve a tracked/requested mod filename to its path in the mods folder, or
 * null if it isn't a bare .jar/.zip file name ("../users.json", "/etc/x",
 * "..\\x.jar" and friends are all refused).
 */
export function resolveTrackedModFile(server: ServerContext, filename: unknown): string | null {
  if (typeof filename !== 'string' || !MOD_FILE_PATTERN.test(filename)) return null;
  return resolveFileInDir(server.paths.mods, filename);
}

function isValidTrackedKey(server: ServerContext, key: string): boolean {
  if (key.startsWith(WISHLIST_PREFIX)) return SLUG_PATTERN.test(key.slice(WISHLIST_PREFIX.length));
  return resolveTrackedModFile(server, key) !== null;
}

function getTrackedModsPath(server: ServerContext): string {
  return path.join(server.paths.data, TRACKED_MODS_FILE);
}

async function loadTrackedMods(server: ServerContext): Promise<TrackedModsData> {
  let parsed: Partial<TrackedModsData>;
  try {
    // In the server's data folder: only a regular file there is read.
    const data = await readRegularFile(getTrackedModsPath(server), [server.paths.data], {
      maxBytes: MAX_SERVER_FILE_BYTES,
    });
    parsed = JSON.parse(data.toString('utf-8'));
  } catch {
    return { mods: Object.create(null), lastGlobalCheck: null };
  }

  // The file lives in the shared data dir and older panels stored the request
  // filename unchecked. Drop every entry whose key or filename isn't a plain
  // mod file name before anything can turn it into a delete path.
  // Prototype-less map: route keys such as "__proto__" must look up nothing.
  const mods: Record<string, TrackedMod> = Object.create(null);
  const stored = parsed?.mods && typeof parsed.mods === 'object' ? parsed.mods : {};
  for (const [key, mod] of Object.entries(stored)) {
    if (
      mod &&
      typeof mod === 'object' &&
      isValidTrackedKey(server, key) &&
      isValidTrackedKey(server, String(mod.filename))
    ) {
      mods[key] = mod;
    } else {
      logger.warn(
        `[CFWidget] Dropping invalid tracked mod entry ${JSON.stringify(key).slice(0, 200)}`,
      );
    }
  }
  return { mods, lastGlobalCheck: parsed?.lastGlobalCheck ?? null };
}

async function saveTrackedMods(server: ServerContext, data: TrackedModsData): Promise<void> {
  try {
    const filePath = getTrackedModsPath(server);
    await mkdir(path.dirname(filePath), { recursive: true });
    await replaceFileContent(filePath, JSON.stringify(data, null, 2), [server.paths.data]);
  } catch (e) {
    logger.error('[CFWidget] Failed to save tracked mods:', e);
  }
}

// ============== API Client ==============

/**
 * Make a request to CFWidget API
 */
async function cfwidgetRequest<T>(slug: string): Promise<T | null> {
  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      hostname: CFWIDGET_API_BASE,
      path: `/hytale/mods/${encodeURIComponent(slug)}`,
      method: 'GET',
      headers: {
        'User-Agent': 'KyuubiSoft-HytalePanel/1.0',
        Accept: 'application/json',
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
          } else if (res.statusCode === 404) {
            logger.error(`[CFWidget] Mod not found: ${slug}`);
            resolve(null);
          } else if (res.statusCode === 429) {
            logger.error('[CFWidget] Rate limited');
            resolve(null);
          } else {
            logger.error(`[CFWidget] API error: ${res.statusCode}`);
            resolve(null);
          }
        } catch (e) {
          logger.error('[CFWidget] Failed to parse response:', e);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      logger.error('[CFWidget] Request error:', e);
      resolve(null);
    });

    req.end();
  });
}

// ============== Public API ==============

/**
 * Get mod info from CFWidget by slug
 */
export async function getModInfo(slug: string): Promise<CFWidgetProject | null> {
  // Check cache first
  const cacheKey = `mod:${slug}`;
  const cached = getCached<CFWidgetProject>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await cfwidgetRequest<CFWidgetProject>(slug);

  if (result) {
    setCache(cacheKey, result);
  }

  return result;
}

/**
 * Extract version from filename
 * Supports patterns like:
 * - ModName-1.0.2-SNAPSHOT_80dc15d9.jar → 1.0.2-SNAPSHOT
 * - ModName-2026.1.12-30731_6cb09a36.jar → 2026.1.12-30731
 * - ModName-1.0.0_e0eb041a.zip → 1.0.0
 * - ModName-1.3.1.jar → 1.3.1
 */
export function extractVersionFromFilename(filename: string): string | null {
  if (!filename) return null;

  // Remove extension
  const nameWithoutExt = filename.replace(/\.(jar|zip)$/i, '');

  // Pattern: ModName-Version_hash or ModName-Version
  // Try to match version pattern after the mod name
  // Version typically starts after the first hyphen and contains numbers/dots
  const match = nameWithoutExt.match(/-(\d+[\d.\-a-zA-Z]*?)(?:_[a-f0-9]+)?$/i);

  if (match && match[1]) {
    return match[1];
  }

  return null;
}

/**
 * Extract slug from CurseForge URL
 * Supports formats:
 * - https://www.curseforge.com/hytale/mods/mod-slug
 * - curseforge.com/hytale/mods/mod-slug
 * - mod-slug (direct slug)
 */
export function extractSlugFromUrl(input: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }

  // Direct slug (no URL)
  if (!input.includes('/') && !input.includes('.')) {
    // Validate slug format
    if (/^[a-z0-9-]+$/.test(input)) {
      return input;
    }
    return null;
  }

  // URL format
  try {
    const url = input.startsWith('http') ? input : `https://${input}`;
    const urlObj = new URL(url);

    // Check if it's a CurseForge URL
    if (!urlObj.hostname.includes('curseforge.com')) {
      return null;
    }

    // Extract slug from path: /hytale/mods/slug or /hytale/mods/slug/...
    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    // Expected format: ['hytale', 'mods', 'slug'] or similar
    if (pathParts.length >= 3 && pathParts[1] === 'mods') {
      // The slug ends up in storage keys - same character set as a direct slug.
      return SLUG_PATTERN.test(pathParts[2]) ? pathParts[2] : null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Track a mod for update checking
 * If filename is empty, the mod is added as a "wishlist" item (not yet installed)
 */
export async function trackMod(
  server: ServerContext,
  filename: string,
  curseforgeInput: string,
  currentVersion?: string,
): Promise<{ success: boolean; error?: string; mod?: TrackedMod }> {
  const slug = extractSlugFromUrl(curseforgeInput);

  if (!slug) {
    return { success: false, error: 'Invalid CurseForge URL or slug' };
  }

  // Check if this is a wishlist item (no filename = not installed yet)
  const isWishlist = !filename || (typeof filename === 'string' && filename.trim() === '');

  // The filename is later used to delete the old file on update/uninstall:
  // only a bare .jar/.zip name in the mods folder is accepted.
  if (!isWishlist && !resolveTrackedModFile(server, filename)) {
    return {
      success: false,
      error: 'Invalid mod filename (expected a .jar or .zip file name from the mods folder)',
    };
  }

  // Fetch mod info to validate and get current version
  const modInfo = await getModInfo(slug);

  if (!modInfo) {
    return { success: false, error: 'Mod not found on CurseForge' };
  }

  // For wishlist items, use a placeholder filename based on slug
  const actualFilename = isWishlist ? `[wishlist]${slug}` : filename;

  // Extract version from filename if not provided (only for installed mods)
  const installedVersion = isWishlist
    ? undefined
    : currentVersion || extractVersionFromFilename(filename) || undefined;

  const latestFile = modInfo.download;

  const trackedMod: TrackedMod = {
    filename: actualFilename,
    curseforgeSlug: slug,
    installedVersion,
    latestFileId: latestFile?.id,
    latestVersion: latestFile?.display || latestFile?.name,
    latestFileName: latestFile?.name,
    hasUpdate: isWishlist, // Wishlist items always show as "needs install"
    lastChecked: new Date().toISOString(),
    projectId: modInfo.id,
    projectTitle: modInfo.title,
    projectUrl: modInfo.urls?.curseforge,
    thumbnail: modInfo.thumbnail,
    installed: !isWishlist,
  };

  // For installed mods, check if update is available
  if (!isWishlist) {
    if (trackedMod.installedFileId && trackedMod.latestFileId) {
      trackedMod.hasUpdate = trackedMod.latestFileId > trackedMod.installedFileId;
    } else if (trackedMod.installedVersion && trackedMod.latestVersion) {
      trackedMod.hasUpdate = trackedMod.installedVersion !== trackedMod.latestVersion;
    }
  }

  // Save to tracked mods
  const data = await loadTrackedMods(server);
  data.mods[actualFilename] = trackedMod;
  await saveTrackedMods(server, data);

  return { success: true, mod: trackedMod };
}

/**
 * Untrack a mod
 */
export async function untrackMod(server: ServerContext, filename: string): Promise<boolean> {
  const data = await loadTrackedMods(server);

  if (data.mods[filename]) {
    delete data.mods[filename];
    await saveTrackedMods(server, data);
    return true;
  }

  return false;
}

/**
 * Get all tracked mods
 */
export async function getTrackedMods(server: ServerContext): Promise<TrackedModsData> {
  return loadTrackedMods(server);
}

/**
 * Check for updates on a single mod
 */
export async function checkModUpdate(
  server: ServerContext,
  filename: string,
): Promise<TrackedMod | null> {
  const data = await loadTrackedMods(server);
  const tracked = data.mods[filename];

  if (!tracked) {
    return null;
  }

  // Migration: set installed field for old entries
  if (tracked.installed === undefined) {
    tracked.installed = !filename.startsWith('[wishlist]');
  }

  // Auto-extract version from filename if not already set (only for installed mods)
  if (tracked.installed && !tracked.installedVersion) {
    const extractedVersion = extractVersionFromFilename(filename);
    if (extractedVersion) {
      tracked.installedVersion = extractedVersion;
    }
  }

  const modInfo = await getModInfo(tracked.curseforgeSlug);

  if (!modInfo) {
    return tracked; // Return existing data if API fails
  }

  const latestFile = modInfo.download;

  tracked.latestFileId = latestFile?.id;
  tracked.latestVersion = latestFile?.display || latestFile?.name;
  tracked.latestFileName = latestFile?.name;
  tracked.lastChecked = new Date().toISOString();
  tracked.projectTitle = modInfo.title;
  tracked.thumbnail = modInfo.thumbnail;

  // Wishlist items always show as "needs install"
  if (!tracked.installed) {
    tracked.hasUpdate = true;
    data.mods[filename] = tracked;
    await saveTrackedMods(server, data);
    return tracked;
  }

  // Update check for installed mods - compare versions
  tracked.hasUpdate = false;
  if (tracked.installedFileId && tracked.latestFileId) {
    tracked.hasUpdate = tracked.latestFileId > tracked.installedFileId;
  } else if (tracked.installedVersion && tracked.latestVersion) {
    // Compare version strings - need to normalize them first
    // Latest version might be filename (e.g., "JET-1.3.2.jar") or display name
    const installedVer = tracked.installedVersion;
    let latestVer = tracked.latestVersion;

    // Extract version from latestVersion if it looks like a filename
    if (latestVer.includes('.jar') || latestVer.includes('.zip')) {
      const extracted = extractVersionFromFilename(latestVer);
      if (extracted) {
        latestVer = extracted;
      }
    }

    tracked.hasUpdate = installedVer !== latestVer;
  }

  data.mods[filename] = tracked;
  await saveTrackedMods(server, data);

  return tracked;
}

/**
 * Check for updates on all tracked mods
 */
export async function checkAllUpdates(server: ServerContext): Promise<ModUpdateStatus> {
  const data = await loadTrackedMods(server);
  const mods = Object.values(data.mods);

  let updatesAvailable = 0;
  const updatedMods: TrackedMod[] = [];

  for (const mod of mods) {
    const updated = await checkModUpdate(server, mod.filename);
    if (updated) {
      updatedMods.push(updated);
      if (updated.hasUpdate) {
        updatesAvailable++;
      }
    }

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Reload data after all updates to get the correct state
  // (checkModUpdate saves each mod individually, so we need fresh data)
  const freshData = await loadTrackedMods(server);
  freshData.lastGlobalCheck = new Date().toISOString();
  await saveTrackedMods(server, freshData);

  return {
    totalTracked: updatedMods.length,
    updatesAvailable,
    lastChecked: freshData.lastGlobalCheck,
    mods: updatedMods,
  };
}

/**
 * Get current update status without checking (uses cached data)
 */
export async function getUpdateStatus(server: ServerContext): Promise<ModUpdateStatus> {
  const data = await loadTrackedMods(server);
  const mods = Object.values(data.mods);

  const updatesAvailable = mods.filter((m) => m.hasUpdate).length;

  return {
    totalTracked: mods.length,
    updatesAvailable,
    lastChecked: data.lastGlobalCheck,
    mods,
  };
}

/**
 * Update installed version for a tracked mod
 */
export async function updateInstalledVersion(
  server: ServerContext,
  filename: string,
  version: string,
  fileId?: number,
): Promise<boolean> {
  const data = await loadTrackedMods(server);
  const tracked = data.mods[filename];

  if (!tracked) {
    return false;
  }

  tracked.installedVersion = version;
  if (fileId) {
    tracked.installedFileId = fileId;
  }

  // Recalculate update status
  if (tracked.installedFileId && tracked.latestFileId) {
    tracked.hasUpdate = tracked.latestFileId > tracked.installedFileId;
  } else if (tracked.installedVersion && tracked.latestVersion) {
    tracked.hasUpdate = tracked.installedVersion !== tracked.latestVersion;
  } else {
    tracked.hasUpdate = false;
  }

  data.mods[filename] = tracked;
  await saveTrackedMods(server, data);

  return true;
}

// ============== Download & Install ==============

/**
 * Download a file from URL to destination
 */
async function downloadFile(url: string, destPath: string, redirectCount = 0): Promise<boolean> {
  // Prevent infinite redirects
  if (redirectCount > 10) {
    logger.error('[CFWidget] Too many redirects');
    return false;
  }

  return new Promise((resolve) => {
    try {
      // Handle URL encoding for spaces and special chars
      const encodedUrl = url.replace(/ /g, '%20');
      const parsedUrl = new URL(encodedUrl);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          Host: parsedUrl.hostname,
        },
      };

      logger.info(`[CFWidget] Downloading from: ${parsedUrl.hostname}${parsedUrl.pathname}`);

      const request = protocol.request(options, (response) => {
        // Handle redirects
        if (
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 307 ||
          response.statusCode === 308
        ) {
          let redirectUrl = response.headers.location;
          if (redirectUrl) {
            // Handle relative redirects
            if (redirectUrl.startsWith('/')) {
              redirectUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${redirectUrl}`;
            }
            logger.info(`[CFWidget] Redirect (${response.statusCode}) to: ${redirectUrl}`);
            downloadFile(redirectUrl, destPath, redirectCount + 1).then(resolve);
            return;
          }
        }

        if (response.statusCode !== 200) {
          logger.error(
            `[CFWidget] Download failed with status: ${response.statusCode} from ${parsedUrl.hostname}${parsedUrl.pathname}`,
          );
          // Log response headers for debugging
          logger.error(`[CFWidget] Response headers: ${JSON.stringify(response.headers)}`);
          resolve(false);
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', async () => {
          try {
            // destPath is <mods folder>/<plain name>. The game server can write
            // to that folder: the file is replaced, never written through a
            // link planted under its name.
            await replaceFileContent(destPath, Buffer.concat(chunks), [path.dirname(destPath)]);
            logger.info(`[CFWidget] Download complete: ${destPath}`);
            resolve(true);
          } catch (err) {
            logger.error('[CFWidget] File write error:', err);
            resolve(false);
          }
        });
        response.on('error', (err) => {
          logger.error('[CFWidget] Download error:', err);
          resolve(false);
        });
      });

      request.on('error', (err) => {
        logger.error('[CFWidget] Download request error:', err);
        resolve(false);
      });

      request.end();
    } catch (err) {
      logger.error('[CFWidget] URL parse error:', err);
      resolve(false);
    }
  });
}

/**
 * Sanitize filename for safe file system operations
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/__+/g, '_');
}

/**
 * Construct CurseForge CDN download URL from file ID and filename
 * CurseForge CDN format: https://mediafilez.forgecdn.net/files/{first4}/{remaining}/{filename}
 */
function constructDownloadUrl(fileId: number, filename: string): string {
  const idStr = fileId.toString();
  // Split file ID: first 4 digits, then remaining digits
  const first = idStr.slice(0, 4);
  const remaining = idStr.slice(4);
  // URL encode the filename for special characters
  const encodedFilename = encodeURIComponent(filename);
  return `https://mediafilez.forgecdn.net/files/${first}/${remaining}/${encodedFilename}`;
}

export interface CFWidgetInstallResult {
  success: boolean;
  error?: string;
  filename?: string;
  modName?: string;
  version?: string;
}

/**
 * Install or update a tracked mod from CFWidget
 */
export async function installTrackedMod(
  server: ServerContext,
  trackedFilename: string,
): Promise<CFWidgetInstallResult> {
  const data = await loadTrackedMods(server);
  const tracked = data.mods[trackedFilename];

  if (!tracked) {
    return { success: false, error: 'Mod not tracked' };
  }

  // Get fresh mod info
  const modInfo = await getModInfo(tracked.curseforgeSlug);
  if (!modInfo) {
    return { success: false, error: 'Could not fetch mod info from CurseForge' };
  }

  const latestFile = modInfo.download;
  if (!latestFile || !latestFile.url) {
    return { success: false, error: 'No download available for this mod' };
  }

  // Sanitize filename
  const safeFilename = sanitizeFilename(latestFile.name);
  if (!safeFilename || !DOWNLOAD_FILE_PATTERN.test(safeFilename)) {
    return {
      success: false,
      error: 'Invalid filename (only .jar or .zip downloads are installed)',
    };
  }

  // Ensure mods directory exists
  const modsDir = server.paths.mods;
  try {
    await access(modsDir);
  } catch {
    await mkdir(modsDir, { recursive: true });
  }

  // Build destination path
  const destPath = path.join(modsDir, safeFilename);
  const resolvedDest = path.resolve(destPath);
  const resolvedTarget = path.resolve(modsDir);

  // Security: Prevent path traversal (also via a symlink already sitting at
  // the destination - the download stream would follow it)
  if (
    !resolvedDest.startsWith(resolvedTarget + path.sep) ||
    !resolveRealPathWithin(destPath, [modsDir])
  ) {
    logger.error('[CFWidget] Path traversal attempt detected');
    return { success: false, error: 'Invalid destination path' };
  }

  // Construct proper CDN download URL (CFWidget returns website URL, not CDN URL)
  const downloadUrl = constructDownloadUrl(latestFile.id, latestFile.name);

  logger.info(`[CFWidget] Downloading ${modInfo.title} to ${destPath}`);
  logger.info(`[CFWidget] Download URL: ${downloadUrl}`);

  // Download the file
  const downloaded = await downloadFile(downloadUrl, destPath);
  if (!downloaded) {
    logger.error(`[CFWidget] Download failed for URL: ${downloadUrl}`);
    return { success: false, error: `Failed to download mod file from ${downloadUrl}` };
  }

  // If this was a wishlist item or an update, handle old file
  const isWishlist = !tracked.installed;
  const isUpdate = tracked.installed && tracked.filename !== safeFilename;

  // Delete old file if updating to new version
  if (isUpdate && tracked.filename && !tracked.filename.startsWith(WISHLIST_PREFIX)) {
    const oldPath = resolveTrackedModFile(server, tracked.filename);
    if (!oldPath) {
      logger.warn(
        `[CFWidget] Not deleting old version with invalid filename: ${JSON.stringify(tracked.filename)}`,
      );
    } else {
      try {
        await unlink(oldPath);
        logger.info(`[CFWidget] Deleted old version: ${tracked.filename}`);
      } catch {
        // Old file might not exist, that's OK
      }
    }
  }

  // Update tracked mod data
  const oldKey = trackedFilename;
  delete data.mods[oldKey];

  // Create updated tracked mod entry
  const updatedMod: TrackedMod = {
    filename: safeFilename,
    curseforgeSlug: tracked.curseforgeSlug,
    installedVersion:
      extractVersionFromFilename(safeFilename) || latestFile.display || latestFile.version,
    installedFileId: latestFile.id,
    latestFileId: latestFile.id,
    latestVersion: latestFile.display || latestFile.name,
    latestFileName: latestFile.name,
    hasUpdate: false, // Just installed/updated, so no update available
    lastChecked: new Date().toISOString(),
    projectId: modInfo.id,
    projectTitle: modInfo.title,
    projectUrl: modInfo.urls?.curseforge,
    thumbnail: modInfo.thumbnail,
    installed: true,
  };

  data.mods[safeFilename] = updatedMod;
  await saveTrackedMods(server, data);

  logger.info(
    `[CFWidget] ${isWishlist ? 'Installed' : 'Updated'} ${modInfo.title} (${safeFilename})`,
  );

  return {
    success: true,
    filename: safeFilename,
    modName: modInfo.title,
    version: updatedMod.installedVersion,
  };
}

/**
 * Uninstall a tracked mod (delete file and untrack)
 */
export async function uninstallTrackedMod(
  server: ServerContext,
  filename: string,
): Promise<{ success: boolean; error?: string }> {
  const data = await loadTrackedMods(server);
  const tracked = data.mods[filename];

  if (!tracked) {
    return { success: false, error: 'Mod not tracked' };
  }

  // Only delete file if it's installed (not a wishlist item)
  if (tracked.installed && !filename.startsWith(WISHLIST_PREFIX)) {
    const filePath = resolveTrackedModFile(server, filename);
    if (!filePath) {
      return { success: false, error: 'Invalid mod filename' };
    }
    try {
      await unlink(filePath);
      logger.info(`[CFWidget] Deleted mod file: ${filename}`);
    } catch (err) {
      logger.error('[CFWidget] Failed to delete mod file:', err);
      // Continue to untrack even if file deletion fails
    }
  }

  // Remove from tracked mods
  delete data.mods[filename];
  await saveTrackedMods(server, data);

  return { success: true };
}

// ============== Automatic Update Checker ==============

let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
let lastAutoCheck: Date | null = null;

/**
 * Start automatic update checking
 */
export function startAutoUpdateCheck(): void {
  if (updateCheckInterval) {
    logger.info('[CFWidget] Auto update check already running');
    return;
  }

  logger.info('[CFWidget] Starting automatic update check (every hour)');

  // Run immediately on start
  runAutoCheck();

  // Then run every hour
  updateCheckInterval = setInterval(runAutoCheck, UPDATE_CHECK_INTERVAL);
}

/**
 * Stop automatic update checking
 */
export function stopAutoUpdateCheck(): void {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
    logger.info('[CFWidget] Stopped automatic update check');
  }
}

/**
 * Run the automatic update check for every server whose files the panel sees
 */
async function runAutoCheck(): Promise<void> {
  let servers: ServerContext[];
  try {
    servers = (await listServers()).map(contextFromServer);
  } catch (e) {
    logger.error('[CFWidget] Auto update check failed:', e);
    return;
  }
  for (const server of servers) {
    if (!checkServerFiles(server).available) continue;
    try {
      logger.info(`[CFWidget] Running automatic update check for server ${server.id}...`);
      const status = await checkAllUpdates(server);

      if (status.updatesAvailable > 0) {
        logger.info(
          `[CFWidget] Found ${status.updatesAvailable} mod update(s) available on server ${server.id}`,
        );
      } else {
        logger.info(`[CFWidget] All tracked mods of server ${server.id} are up to date`);
      }
    } catch (e) {
      logger.error(`[CFWidget] Auto update check failed for server ${server.id}:`, e);
    }
  }
  lastAutoCheck = new Date();
}

/**
 * Get the last auto check time
 */
export function getLastAutoCheckTime(): Date | null {
  return lastAutoCheck;
}

export default {
  getModInfo,
  extractSlugFromUrl,
  trackMod,
  untrackMod,
  getTrackedMods,
  checkModUpdate,
  checkAllUpdates,
  getUpdateStatus,
  updateInstalledVersion,
  installTrackedMod,
  uninstallTrackedMod,
  clearCFWidgetCache,
  startAutoUpdateCheck,
  stopAutoUpdateCheck,
  getLastAutoCheckTime,
};
