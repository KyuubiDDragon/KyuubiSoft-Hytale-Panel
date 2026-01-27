/**
 * CFWidget Service
 * Free CurseForge API proxy for mod update checking
 * No API key required - uses https://api.cfwidget.com
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import https from 'https';
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

  // Update last global check time
  data.lastGlobalCheck = new Date().toISOString();
  await saveTrackedMods(data);

  return {
    totalTracked: updatedMods.length,
    updatesAvailable,
    lastChecked: data.lastGlobalCheck,
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
  clearCFWidgetCache,
  startAutoUpdateCheck,
  stopAutoUpdateCheck,
  getLastAutoCheckTime,
};
