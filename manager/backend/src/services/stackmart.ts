import { logger } from '../utils/logger.js';
/**
 * StackMart Service
 * Integration with the StackMart.org API for browsing and installing resources
 * API Documentation: https://stackmart.org/api-docs
 */

import { mkdir, access, unlink } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { sanitizeFileName, resolveFileInDir } from '../utils/pathSecurity.js';
import type { ServerContext } from './serverContext.js';
import { readRegularFile, replaceFileContent } from '../utils/noFollowFs.js';
import { MAX_SERVER_FILE_BYTES } from '../utils/serverFiles.js';
import { outboundErrorMessage, safeDownload, safeRequest } from '../utils/safeFetch.js';
import { removeReplacedFile } from '../utils/replacedFile.js';

// Security: Regex pattern for validating resource IDs (MongoDB ObjectId or slug)
const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// StackMart API Configuration
const STACKMART_API_BASE = 'https://stackmart.org';
const STACKMART_PUBLIC_API = 'https://stackmart.org/api/public';
// API calls and the start of a download stay on StackMart. Where its download
// links redirect to (storage) is not known, so redirects of a download may
// lead to any public host.
export const STACKMART_HOSTS = ['stackmart.org'];
const API_MAX_BYTES = 10 * 1024 * 1024;

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ============== Types ==============

export interface StackMartResource {
  id: string;
  name: string;
  slug: string;
  tagline: string;
  category: string;
  subcategory?: string;
  version: string;
  downloads: number;
  rating: number;
  author: string;
  source: string;
  sourceUrl: string;
  downloadUrl: string;
  iconUrl?: string;
  bannerUrl?: string;
}

export interface StackMartResourceDetails extends StackMartResource {
  description: string;
  features: string[];
  screenshots: string[];
  tags?: string[];
  requirements?: string;
  changelog?: string;
  supportUrl?: string;
  documentationUrl?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  views?: number;
  reviewsCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface StackMartSearchResult {
  resources: StackMartResource[];
  total: number;
  page: number;
  totalPages: number;
  source: string;
  apiVersion: string;
}

export interface StackMartInstallResult {
  success: boolean;
  error?: string;
  filename?: string;
  version?: string;
  resourceId?: string;
  resourceName?: string;
}

export type StackMartSortOption = 'popular' | 'recent' | 'rated';
export type StackMartCategory = 'plugins' | 'mods' | 'scripts' | 'tools';

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

export function clearStackMartCache(): void {
  cache.clear();
  logger.info('StackMart cache cleared');
}

// ============== Installed Resources Tracking ==============

interface InstalledResourceInfo {
  resourceId: string;
  resourceName: string;
  version: string;
  filename: string;
  category: string;
  installedAt: string;
}

interface InstalledResourcesData {
  resources: Record<string, InstalledResourceInfo>;
}

// Kept in each server's data folder: every server has its own install list.
const INSTALLED_RESOURCES_FILE = 'stackmart-installed.json';

function getInstalledResourcesPath(server: ServerContext): string {
  return path.join(server.paths.data, INSTALLED_RESOURCES_FILE);
}

async function loadInstalledResources(server: ServerContext): Promise<InstalledResourcesData> {
  try {
    // In the server's data folder: only a regular file there is read.
    const data = await readRegularFile(getInstalledResourcesPath(server), [server.paths.data], {
      maxBytes: MAX_SERVER_FILE_BYTES,
    });
    return JSON.parse(data.toString('utf-8'));
  } catch {
    return { resources: {} };
  }
}

async function saveInstalledResources(
  server: ServerContext,
  data: InstalledResourcesData,
): Promise<void> {
  try {
    const filePath = getInstalledResourcesPath(server);
    await mkdir(path.dirname(filePath), { recursive: true });
    await replaceFileContent(filePath, JSON.stringify(data, null, 2), [server.paths.data]);
  } catch (e) {
    logger.error('Failed to save installed resources tracking:', e);
  }
}

export async function getInstalledStackMartInfo(
  server: ServerContext,
): Promise<Record<string, InstalledResourceInfo>> {
  const data = await loadInstalledResources(server);
  return data.resources;
}

export async function isStackMartResourceInstalled(
  server: ServerContext,
  resourceId: string,
): Promise<InstalledResourceInfo | null> {
  const data = await loadInstalledResources(server);
  return data.resources[resourceId] || null;
}

async function trackInstalledResource(
  server: ServerContext,
  info: InstalledResourceInfo,
): Promise<void> {
  const data = await loadInstalledResources(server);
  data.resources[info.resourceId] = info;
  await saveInstalledResources(server, data);
}

export async function untrackInstalledResource(
  server: ServerContext,
  resourceId: string,
): Promise<boolean> {
  const data = await loadInstalledResources(server);
  if (data.resources[resourceId]) {
    delete data.resources[resourceId];
    await saveInstalledResources(server, data);
    return true;
  }
  return false;
}

/** Folder a resource of this category goes to (scripts, tools and unknown: data). */
function folderFor(server: ServerContext, category: string | undefined): string {
  switch (category?.toLowerCase()) {
    case 'plugins':
      return server.paths.plugins;
    case 'mods':
      return server.paths.mods;
    default:
      return server.paths.data;
  }
}

// ============== Security Validation ==============

/**
 * Validate a resource ID to prevent injection attacks
 */
export function isValidResourceId(resourceId: string): boolean {
  if (!resourceId || typeof resourceId !== 'string') {
    return false;
  }
  return RESOURCE_ID_PATTERN.test(resourceId);
}

/**
 * Sanitize a string for use in filenames
 */
function sanitizeForFilename(input: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }
  const sanitized = input
    .replace(/\.\./g, '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  if (!sanitized || sanitized.length === 0) {
    return null;
  }

  return sanitized;
}

// ============== API Client ==============

/**
 * Get the StackMart API key from config/environment
 */
function getApiKey(): string | undefined {
  // config-first so a key set in the Settings UI (config.json, hot-reloaded)
  // wins over the env var.
  const key = config.stackmartApiKey || process.env.STACKMART_API_KEY;
  if (key && !apiKeyLogged) {
    logger.info(`[StackMart] API key configured (${key.substring(0, 10)}...)`);
    apiKeyLogged = true;
  }
  return key || undefined;
}

let apiKeyLogged = false;

/**
 * Make a request to the StackMart API (browser-like User-Agent, which works
 * better with Cloudflare and other DDoS protection services)
 */
async function stackmartRequest<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    requireAuth?: boolean;
    isPublic?: boolean;
  } = {},
): Promise<T | null> {
  const { method = 'GET', body, requireAuth = false, isPublic = true } = options;
  const apiKey = getApiKey();

  if (requireAuth && !apiKey) {
    logger.error('StackMart API key required but not configured');
    return null;
  }

  try {
    const baseUrl = isPublic ? STACKMART_PUBLIC_API : STACKMART_API_BASE + '/api';
    // Ensure endpoint doesn't start with / to properly append to base URL
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const url = new URL(`${baseUrl}/${cleanEndpoint}`);

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; KyuubiSoft-HytalePanel/1.0)',
      Accept: 'application/json',
    };

    if (apiKey) {
      headers['X-Publisher-Key'] = apiKey;
    }

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await safeRequest(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      allowedHosts: STACKMART_HOSTS,
      maxBytes: API_MAX_BYTES,
    });

    if (response.status === 200) {
      return JSON.parse(response.body.toString('utf-8')) as T;
    } else if (response.status === 429) {
      logger.error('StackMart API rate limit exceeded');
      return null;
    } else {
      const text = response.body.toString('utf-8').slice(0, 500);
      logger.error(`StackMart API error: ${response.status} - ${text}`);
      return null;
    }
  } catch (e) {
    logger.error(`StackMart request error: ${outboundErrorMessage(e)}`);
    return null;
  }
}

/**
 * Download a resource file. StackMart states no hash for its files; the
 * download starts on StackMart, within the size and time limit.
 */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
  try {
    // destPath is <folder>/<plain name>. The game server can write to that
    // folder: the file is replaced, never written through a link planted
    // under its name.
    await safeDownload(url, {
      allowedHosts: STACKMART_HOSTS,
      redirectHosts: null,
      headers: { 'User-Agent': 'KyuubiSoft-HytalePanel/1.0' },
      saveTo: destPath,
    });
    return true;
  } catch (e) {
    logger.error(`[StackMart] Download failed: ${outboundErrorMessage(e)}`);
    return false;
  }
}

// ============== Public API ==============

/**
 * Search for resources on StackMart
 */
export async function searchResources(
  options: {
    search?: string;
    page?: number;
    limit?: number;
    sort?: StackMartSortOption;
    category?: StackMartCategory;
    subcategory?: string;
  } = {},
): Promise<StackMartSearchResult | null> {
  const { search, page = 1, limit = 20, sort = 'popular', category, subcategory } = options;

  // Build cache key
  const cacheKey = `stackmart:search:${JSON.stringify(options)}`;
  const cached = getCached<StackMartSearchResult>(cacheKey);
  if (cached) {
    return cached;
  }

  // Build query params
  const params = new URLSearchParams();
  if (search) params.append('search', search);
  params.append('page', page.toString());
  params.append('limit', limit.toString());
  params.append('sort', sort);
  if (category) params.append('category', category);
  if (subcategory) params.append('subcategory', subcategory);

  const result = await stackmartRequest<StackMartSearchResult>(`/resources?${params.toString()}`);

  if (result) {
    setCache(cacheKey, result);
  }

  return result;
}

/**
 * Get resource details by ID or slug
 */
export async function getResourceDetails(
  resourceId: string,
): Promise<{ resource: StackMartResourceDetails } | null> {
  // Security: Validate resourceId before using in URL
  if (!isValidResourceId(resourceId)) {
    logger.error(`Invalid resource ID format: ${resourceId}`);
    return null;
  }

  const cacheKey = `stackmart:resource:${resourceId}`;
  const cached = getCached<{ resource: StackMartResourceDetails }>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await stackmartRequest<{ resource: StackMartResourceDetails }>(
    `/resources/${encodeURIComponent(resourceId)}`,
  );

  if (result) {
    setCache(cacheKey, result);
  }

  return result;
}

/**
 * Get available categories from StackMart
 */
export async function getCategories(): Promise<string[]> {
  const cacheKey = 'stackmart:categories';
  const cached = getCached<{ categories: string[] }>(cacheKey);
  if (cached) {
    return cached.categories;
  }

  const result = await stackmartRequest<{ categories: string[]; source: string }>('/categories');

  if (result) {
    setCache(cacheKey, result);
    return result.categories;
  }

  // Return hardcoded categories as fallback
  return ['plugins', 'mods', 'scripts', 'tools'];
}

/**
 * Install a resource from StackMart
 */
export async function installResourceFromStackMart(
  server: ServerContext,
  resourceId: string,
): Promise<StackMartInstallResult> {
  // Security: Validate resourceId
  if (!isValidResourceId(resourceId)) {
    return { success: false, error: 'Invalid resource ID format' };
  }

  // Get resource details
  const detailsResult = await getResourceDetails(resourceId);
  if (!detailsResult || !detailsResult.resource) {
    return { success: false, error: 'Resource not found or API unavailable' };
  }

  const resource = detailsResult.resource;

  // Check for download URL
  const downloadUrl = resource.fileUrl || resource.downloadUrl;
  if (!downloadUrl) {
    return { success: false, error: 'No download URL available for this resource' };
  }

  // Security: Sanitize resource name and version for filename
  const safeName = sanitizeForFilename(resource.name);
  const safeVersion = sanitizeForFilename(resource.version);
  if (!safeName) {
    return { success: false, error: 'Invalid resource name for filename' };
  }
  if (!safeVersion) {
    return { success: false, error: 'Invalid version for filename' };
  }

  // Determine file extension based on category and original filename
  let extension = 'jar';
  if (resource.fileName) {
    const ext = path.extname(resource.fileName).slice(1);
    if (ext) extension = ext;
  } else if (resource.category === 'scripts') {
    extension = 'zip';
  }

  const filename = `${safeName}-${safeVersion}.${extension}`;

  // Security: Final filename validation
  const validatedFilename = sanitizeFileName(filename);
  if (!validatedFilename) {
    return { success: false, error: 'Generated filename failed security validation' };
  }

  // Choose target directory based on category
  const targetPath = folderFor(server, resource.category);

  // Ensure target directory exists
  try {
    await access(targetPath);
  } catch {
    await mkdir(targetPath, { recursive: true });
  }

  // An update: the old file is removed once the new one is in place.
  const existingInstall = await isStackMartResourceInstalled(server, resourceId);

  // Security: Construct destination path and verify it's within allowed directory
  const destPath = path.join(targetPath, validatedFilename);
  const resolvedDest = path.resolve(destPath);
  const resolvedTarget = path.resolve(targetPath);

  if (!resolvedDest.startsWith(resolvedTarget + path.sep)) {
    logger.error(`Path traversal attempt detected: ${destPath}`);
    return { success: false, error: 'Invalid destination path' };
  }

  // Build full download URL
  let fullDownloadUrl = downloadUrl;
  if (!downloadUrl.startsWith('http')) {
    fullDownloadUrl = `${STACKMART_API_BASE}${downloadUrl}`;
  }

  // Download the file
  const downloaded = await downloadFile(fullDownloadUrl, destPath);

  if (!downloaded) {
    return { success: false, error: 'Failed to download resource file' };
  }

  if (existingInstall?.filename) {
    const oldBasePath = folderFor(server, existingInstall.category);
    // The stored filename is untrusted (shared data dir): only a bare name in the base folder.
    const oldFilePath = resolveFileInDir(oldBasePath, existingInstall.filename);
    await removeReplacedFile(oldFilePath, destPath, '[StackMart]');
  }

  // Track the installed resource
  await trackInstalledResource(server, {
    resourceId: resource.id,
    resourceName: resource.name,
    version: safeVersion,
    filename: validatedFilename,
    category: resource.category || 'plugins',
    installedAt: new Date().toISOString(),
  });

  return {
    success: true,
    filename: validatedFilename,
    version: safeVersion,
    resourceId: resource.id,
    resourceName: resource.name,
  };
}

/**
 * Uninstall a StackMart resource
 */
export async function uninstallStackMart(
  server: ServerContext,
  resourceId: string,
): Promise<{ success: boolean; error?: string }> {
  // Security: Validate resourceId
  if (!isValidResourceId(resourceId)) {
    return { success: false, error: 'Invalid resource ID format' };
  }

  const installed = await isStackMartResourceInstalled(server, resourceId);
  if (!installed) {
    return { success: false, error: 'Resource is not installed' };
  }

  const basePath = folderFor(server, installed.category);

  // Security: the stored filename (shared data dir) must be a bare name in the base folder -
  // "sub/x.jar" through a symlinked sub folder would pass a plain prefix check.
  const filePath = resolveFileInDir(basePath, installed.filename);
  if (!filePath) {
    return { success: false, error: 'Invalid file path' };
  }

  try {
    await unlink(filePath);
  } catch (e) {
    logger.error('Failed to delete resource file:', e);
    // Continue to untrack even if file doesn't exist
  }

  await untrackInstalledResource(server, resourceId);

  return { success: true };
}

/**
 * Check if StackMart API is configured and available
 */
export async function checkStackMartStatus(): Promise<{
  configured: boolean;
  hasApiKey: boolean;
  apiAvailable: boolean;
  rateLimit: {
    limit: number;
  };
}> {
  const apiKey = getApiKey();
  const hasApiKey = !!apiKey;

  // Try a simple request to check if API is available
  const result = await stackmartRequest<StackMartSearchResult>('/resources?limit=1');

  return {
    configured: true,
    hasApiKey,
    apiAvailable: result !== null && Array.isArray(result.resources),
    rateLimit: { limit: 100 }, // Public API rate limit
  };
}

/**
 * Get popular resources
 */
export async function getPopularResources(limit: number = 10): Promise<StackMartResource[]> {
  const result = await searchResources({
    sort: 'popular',
    limit,
  });

  return result?.resources || [];
}

/**
 * Get recent resources
 */
export async function getRecentResources(limit: number = 10): Promise<StackMartResource[]> {
  const result = await searchResources({
    sort: 'recent',
    limit,
  });

  return result?.resources || [];
}

export default {
  searchResources,
  getResourceDetails,
  getCategories,
  installResourceFromStackMart,
  uninstallStackMart,
  checkStackMartStatus,
  getPopularResources,
  getRecentResources,
  clearStackMartCache,
  isValidResourceId,
  getInstalledStackMartInfo,
  isStackMartResourceInstalled,
};
