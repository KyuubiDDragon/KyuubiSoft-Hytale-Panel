/**
 * Modtale Service
 * Integration with the Modtale.net API for browsing and installing mods
 * API Documentation: https://api.modtale.net
 */

import { writeFile, mkdir, access } from 'fs/promises';
import path from 'path';
import https from 'https';
import { config } from '../config.js';
import { sanitizeFileName, isPathSafe } from '../utils/pathSecurity.js';

// Security: Regex pattern for validating project IDs
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const VERSION_PATTERN = /^[a-zA-Z0-9._-]{1,32}$/;

// Modtale API Configuration
const MODTALE_API_BASE = 'https://api.modtale.net';
const MODTALE_CDN_BASE = 'https://cdn.modtale.net';

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

export type ModtaleSortOption = 'relevance' | 'downloads' | 'updated' | 'newest' | 'rating' | 'favorites';
export type ModtaleClassification = 'PLUGIN' | 'DATA' | 'ART' | 'SAVE' | 'MODPACK';

// Available tags from Modtale
export const MODTALE_TAGS = [
  'Adventure', 'RPG', 'Sci-Fi', 'Fantasy', 'Survival', 'Magic', 'Tech',
  'Exploration', 'Minigame', 'PvP', 'Parkour', 'Hardcore', 'Skyblock',
  'Puzzle', 'Quests', 'Economy', 'Protection', 'Admin Tools', 'Chat',
  'Anti-Cheat', 'Performance', 'Library', 'API', 'Mechanics', 'World Gen',
  'Recipes', 'Loot Tables', 'Functions', 'Decoration', 'Vanilla+',
  'Kitchen Sink', 'City', 'Landscape', 'Spawn', 'Lobby', 'Medieval',
  'Modern', 'Futuristic', 'Models', 'Textures', 'Animations', 'Particles'
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
  console.log('Modtale cache cleared');
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
  const key = process.env.MODTALE_API_KEY || config.modtaleApiKey;
  // Only log on first call
  if (key && !apiKeyLogged) {
    console.log(`[Modtale] API key configured (${key.substring(0, 6)}...)`);
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
  } = {}
): Promise<T | null> {
  const { method = 'GET', body, requireAuth = false } = options;
  const apiKey = getApiKey();

  if (requireAuth && !apiKey) {
    console.error('Modtale API key required but not configured');
    return null;
  }

  return new Promise((resolve) => {
    const url = new URL(endpoint, MODTALE_API_BASE);

    const headers: Record<string, string> = {
      'User-Agent': 'KyuubiSoft-HytalePanel/1.0',
      'Accept': 'application/json',
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
            console.error('Modtale API rate limit exceeded');
            resolve(null);
          } else {
            console.error(`Modtale API error: ${res.statusCode} - ${data}`);
            resolve(null);
          }
        } catch (e) {
          console.error('Failed to parse Modtale response:', e);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('Modtale request error:', e);
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
 * Search for mods on Modtale
 */
export async function searchMods(options: {
  search?: string;
  page?: number;
  size?: number;
  sort?: ModtaleSortOption;
  classification?: ModtaleClassification;
  tags?: string[];
  gameVersion?: string;
  author?: string;
} = {}): Promise<ModtaleSearchResult | null> {
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
    console.error(`Invalid project ID format: ${projectId}`);
    return null;
  }

  const cacheKey = `project:${projectId}`;
  const cached = getCached<ModtaleProjectDetails>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await modtaleRequest<ModtaleProjectDetails>(`/api/v1/projects/${encodeURIComponent(projectId)}`);

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
  projectId: string,
  versionId?: string
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

  // Determine target path based on classification
  let targetPath: string;

  // Generate filename from sanitized project title and version
  const extension = project.classification === 'PLUGIN' ? 'jar' : 'zip';
  const filename = `${safeTitle}-${safeVersion}.${extension}`;

  // Security: Final filename validation using existing utility
  const validatedFilename = sanitizeFileName(filename);
  if (!validatedFilename) {
    return { success: false, error: 'Generated filename failed security validation' };
  }

  // Choose target directory based on classification
  switch (project.classification) {
    case 'PLUGIN':
      targetPath = config.modsPath; // Plugins go to mods folder
      break;
    case 'DATA':
    case 'ART':
    case 'SAVE':
      targetPath = config.dataPath;
      break;
    case 'MODPACK':
      targetPath = config.modsPath;
      break;
    default:
      targetPath = config.modsPath;
  }

  // Ensure target directory exists
  try {
    await access(targetPath);
  } catch {
    await mkdir(targetPath, { recursive: true });
  }

  // Security: Construct destination path and verify it's within allowed directory
  const destPath = path.join(targetPath, validatedFilename);
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
    rateLimit: hasApiKey
      ? { tier: 'Standard', limit: 300 }
      : { tier: 'No Auth', limit: 10 },
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

export default {
  searchMods,
  getModDetails,
  getTags,
  getClassifications,
  getGameVersions,
  installModFromModtale,
  checkModtaleStatus,
  getFeaturedMods,
  getRecentMods,
  clearModtaleCache,
  isValidProjectId,
  isValidVersion,
  MODTALE_TAGS,
};
