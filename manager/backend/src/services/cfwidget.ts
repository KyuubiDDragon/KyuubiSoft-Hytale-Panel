/**
 * CFWidget Service
 * Free CurseForge API proxy for mod update checking
 * No API key required - uses https://api.cfwidget.com
 */

import { readFile, writeFile, mkdir, access, unlink } from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { config } from '../config.js';

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
  console.log('[CFWidget] Cache cleared');
}

// ============== Tracked Mods Storage ==============

const TRACKED_MODS_FILE = 'cfwidget-tracked.json';

interface TrackedModsData {
  mods: Record<string, TrackedMod>;
  lastGlobalCheck: string | null;
}

function getTrackedModsPath(): string {
  return path.join(config.dataPath, TRACKED_MODS_FILE);
}

async function loadTrackedMods(): Promise<TrackedModsData> {
  try {
    const filePath = getTrackedModsPath();
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { mods: {}, lastGlobalCheck: null };
  }
}

async function saveTrackedMods(data: TrackedModsData): Promise<void> {
  try {
    const filePath = getTrackedModsPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[CFWidget] Failed to save tracked mods:', e);
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
        'Accept': 'application/json',
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
            console.error(`[CFWidget] Mod not found: ${slug}`);
            resolve(null);
          } else if (res.statusCode === 429) {
            console.error('[CFWidget] Rate limited');
            resolve(null);
          } else {
            console.error(`[CFWidget] API error: ${res.statusCode}`);
            resolve(null);
          }
        } catch (e) {
          console.error('[CFWidget] Failed to parse response:', e);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[CFWidget] Request error:', e);
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
      return pathParts[2];
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
  filename: string,
  curseforgeInput: string,
  currentVersion?: string
): Promise<{ success: boolean; error?: string; mod?: TrackedMod }> {
  const slug = extractSlugFromUrl(curseforgeInput);

  if (!slug) {
    return { success: false, error: 'Invalid CurseForge URL or slug' };
  }

  // Fetch mod info to validate and get current version
  const modInfo = await getModInfo(slug);

  if (!modInfo) {
    return { success: false, error: 'Mod not found on CurseForge' };
  }

  // Check if this is a wishlist item (no filename = not installed yet)
  const isWishlist = !filename || filename.trim() === '';

  // For wishlist items, use a placeholder filename based on slug
  const actualFilename = isWishlist ? `[wishlist]${slug}` : filename;

  // Extract version from filename if not provided (only for installed mods)
  const installedVersion = isWishlist ? undefined : (currentVersion || extractVersionFromFilename(filename) || undefined);

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
  const data = await loadTrackedMods();
  data.mods[actualFilename] = trackedMod;
  await saveTrackedMods(data);

  return { success: true, mod: trackedMod };
}

/**
 * Untrack a mod
 */
export async function untrackMod(filename: string): Promise<boolean> {
  const data = await loadTrackedMods();

  if (data.mods[filename]) {
    delete data.mods[filename];
    await saveTrackedMods(data);
    return true;
  }

  return false;
}

/**
 * Get all tracked mods
 */
export async function getTrackedMods(): Promise<TrackedModsData> {
  return loadTrackedMods();
}

/**
 * Check for updates on a single mod
 */
export async function checkModUpdate(filename: string): Promise<TrackedMod | null> {
  const data = await loadTrackedMods();
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
    await saveTrackedMods(data);
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
  await saveTrackedMods(data);

  return tracked;
}

/**
 * Check for updates on all tracked mods
 */
export async function checkAllUpdates(): Promise<ModUpdateStatus> {
  const data = await loadTrackedMods();
  const mods = Object.values(data.mods);

  let updatesAvailable = 0;
  const updatedMods: TrackedMod[] = [];

  for (const mod of mods) {
    const updated = await checkModUpdate(mod.filename);
    if (updated) {
      updatedMods.push(updated);
      if (updated.hasUpdate) {
        updatesAvailable++;
      }
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Reload data after all updates to get the correct state
  // (checkModUpdate saves each mod individually, so we need fresh data)
  const freshData = await loadTrackedMods();
  freshData.lastGlobalCheck = new Date().toISOString();
  await saveTrackedMods(freshData);

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
export async function getUpdateStatus(): Promise<ModUpdateStatus> {
  const data = await loadTrackedMods();
  const mods = Object.values(data.mods);

  const updatesAvailable = mods.filter(m => m.hasUpdate).length;

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
  filename: string,
  version: string,
  fileId?: number
): Promise<boolean> {
  const data = await loadTrackedMods();
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
  await saveTrackedMods(data);

  return true;
}

// ============== Download & Install ==============

/**
 * Download a file from URL to destination
 */
async function downloadFile(url: string, destPath: string, redirectCount = 0): Promise<boolean> {
  // Prevent infinite redirects
  if (redirectCount > 10) {
    console.error('[CFWidget] Too many redirects');
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          'Host': parsedUrl.hostname,
        },
      };

      console.log(`[CFWidget] Downloading from: ${parsedUrl.hostname}${parsedUrl.pathname}`);

      const request = protocol.request(options, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
          let redirectUrl = response.headers.location;
          if (redirectUrl) {
            // Handle relative redirects
            if (redirectUrl.startsWith('/')) {
              redirectUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${redirectUrl}`;
            }
            console.log(`[CFWidget] Redirect (${response.statusCode}) to: ${redirectUrl}`);
            downloadFile(redirectUrl, destPath, redirectCount + 1).then(resolve);
            return;
          }
        }

        if (response.statusCode !== 200) {
          console.error(`[CFWidget] Download failed with status: ${response.statusCode} from ${parsedUrl.hostname}${parsedUrl.pathname}`);
          // Log response headers for debugging
          console.error(`[CFWidget] Response headers: ${JSON.stringify(response.headers)}`);
          resolve(false);
          return;
        }

        const file = createWriteStream(destPath);

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log(`[CFWidget] Download complete: ${destPath}`);
          resolve(true);
        });

        file.on('error', (err) => {
          console.error('[CFWidget] File write error:', err);
          file.close();
          resolve(false);
        });
      });

      request.on('error', (err) => {
        console.error('[CFWidget] Download request error:', err);
        resolve(false);
      });

      request.end();
    } catch (err) {
      console.error('[CFWidget] URL parse error:', err);
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
  trackedFilename: string
): Promise<CFWidgetInstallResult> {
  const data = await loadTrackedMods();
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
  if (!safeFilename) {
    return { success: false, error: 'Invalid filename' };
  }

  // Ensure mods directory exists
  try {
    await access(config.modsPath);
  } catch {
    await mkdir(config.modsPath, { recursive: true });
  }

  // Build destination path
  const destPath = path.join(config.modsPath, safeFilename);
  const resolvedDest = path.resolve(destPath);
  const resolvedTarget = path.resolve(config.modsPath);

  // Security: Prevent path traversal
  if (!resolvedDest.startsWith(resolvedTarget + path.sep)) {
    console.error('[CFWidget] Path traversal attempt detected');
    return { success: false, error: 'Invalid destination path' };
  }

  // Construct proper CDN download URL (CFWidget returns website URL, not CDN URL)
  const downloadUrl = constructDownloadUrl(latestFile.id, latestFile.name);

  console.log(`[CFWidget] Downloading ${modInfo.title} to ${destPath}`);
  console.log(`[CFWidget] Download URL: ${downloadUrl}`);

  // Download the file
  const downloaded = await downloadFile(downloadUrl, destPath);
  if (!downloaded) {
    console.error(`[CFWidget] Download failed for URL: ${downloadUrl}`);
    return { success: false, error: `Failed to download mod file from ${downloadUrl}` };
  }

  // If this was a wishlist item or an update, handle old file
  const isWishlist = !tracked.installed;
  const isUpdate = tracked.installed && tracked.filename !== safeFilename;

  // Delete old file if updating to new version
  if (isUpdate && tracked.filename && !tracked.filename.startsWith('[wishlist]')) {
    try {
      const oldPath = path.join(config.modsPath, tracked.filename);
      await unlink(oldPath);
      console.log(`[CFWidget] Deleted old version: ${tracked.filename}`);
    } catch {
      // Old file might not exist, that's OK
    }
  }

  // Update tracked mod data
  const oldKey = trackedFilename;
  delete data.mods[oldKey];

  // Create updated tracked mod entry
  const updatedMod: TrackedMod = {
    filename: safeFilename,
    curseforgeSlug: tracked.curseforgeSlug,
    installedVersion: extractVersionFromFilename(safeFilename) || latestFile.display || latestFile.version,
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
  await saveTrackedMods(data);

  console.log(`[CFWidget] ${isWishlist ? 'Installed' : 'Updated'} ${modInfo.title} (${safeFilename})`);

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
  filename: string
): Promise<{ success: boolean; error?: string }> {
  const data = await loadTrackedMods();
  const tracked = data.mods[filename];

  if (!tracked) {
    return { success: false, error: 'Mod not tracked' };
  }

  // Only delete file if it's installed (not a wishlist item)
  if (tracked.installed && !filename.startsWith('[wishlist]')) {
    try {
      const filePath = path.join(config.modsPath, filename);
      await unlink(filePath);
      console.log(`[CFWidget] Deleted mod file: ${filename}`);
    } catch (err) {
      console.error('[CFWidget] Failed to delete mod file:', err);
      // Continue to untrack even if file deletion fails
    }
  }

  // Remove from tracked mods
  delete data.mods[filename];
  await saveTrackedMods(data);

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
    console.log('[CFWidget] Auto update check already running');
    return;
  }

  console.log('[CFWidget] Starting automatic update check (every hour)');

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
    console.log('[CFWidget] Stopped automatic update check');
  }
}

/**
 * Run the automatic update check
 */
async function runAutoCheck(): Promise<void> {
  try {
    console.log('[CFWidget] Running automatic update check...');
    const status = await checkAllUpdates();
    lastAutoCheck = new Date();

    if (status.updatesAvailable > 0) {
      console.log(`[CFWidget] Found ${status.updatesAvailable} mod update(s) available`);
    } else {
      console.log('[CFWidget] All tracked mods are up to date');
    }
  } catch (e) {
    console.error('[CFWidget] Auto update check failed:', e);
  }
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
