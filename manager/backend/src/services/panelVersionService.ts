/**
 * Panel Version Service
 *
 * Checks for panel updates by querying the GitHub repository.
 * Compares the current panel version with the latest release/tag on GitHub.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// GitHub repository information
const GITHUB_OWNER = 'KyuubiDDragon';
const GITHUB_REPO = 'KyuubiSoft-Hytale-Panel';

// Cache duration (15 minutes)
const CACHE_DURATION_MS = 15 * 60 * 1000;

interface VersionCache {
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  publishedAt: string;
  checkedAt: number;
}

interface PanelVersionInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseNotes: string;
  publishedAt: string;
  lastChecked: string;
}

let versionCache: VersionCache | null = null;

/**
 * Get the current panel version from package.json
 */
export async function getCurrentVersion(): Promise<string> {
  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const content = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content);
    return packageJson.version || '0.0.0';
  } catch (error) {
    console.error('[PanelVersion] Failed to read package.json:', error);
    return '0.0.0';
  }
}

/**
 * Parse a version string into components for comparison
 */
function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const cleaned = version.replace(/^v/, '').split('-')[0];
  const parts = cleaned.split('.').map(Number);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
  };
}

/**
 * Compare two version strings
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const ver1 = parseVersion(v1);
  const ver2 = parseVersion(v2);

  if (ver1.major !== ver2.major) return ver1.major > ver2.major ? 1 : -1;
  if (ver1.minor !== ver2.minor) return ver1.minor > ver2.minor ? 1 : -1;
  if (ver1.patch !== ver2.patch) return ver1.patch > ver2.patch ? 1 : -1;
  return 0;
}

/**
 * Fetch the latest release from GitHub API
 */
async function fetchLatestRelease(): Promise<{
  version: string;
  url: string;
  notes: string;
  publishedAt: string;
} | null> {
  try {
    // Try releases first (official releases)
    const releaseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

    const response = await fetch(releaseUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'KyuubiSoft-Hytale-Panel',
      },
    });

    if (response.ok) {
      const release = await response.json();
      return {
        version: release.tag_name?.replace(/^v/, '') || release.name || 'unknown',
        url: release.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
        notes: release.body || '',
        publishedAt: release.published_at || new Date().toISOString(),
      };
    }

    // If no releases, try tags
    if (response.status === 404) {
      const tagsUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/tags`;
      const tagsResponse = await fetch(tagsUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'KyuubiSoft-Hytale-Panel',
        },
      });

      if (tagsResponse.ok) {
        const tags = await tagsResponse.json();
        if (tags && tags.length > 0) {
          const latestTag = tags[0];
          return {
            version: latestTag.name?.replace(/^v/, '') || 'unknown',
            url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${latestTag.name}`,
            notes: '',
            publishedAt: new Date().toISOString(),
          };
        }
      }
    }

    console.log('[PanelVersion] No releases or tags found on GitHub');
    return null;
  } catch (error) {
    console.error('[PanelVersion] Failed to fetch from GitHub:', error);
    return null;
  }
}

/**
 * Check for panel updates
 * Uses caching to avoid excessive GitHub API calls
 */
export async function checkPanelUpdate(forceRefresh = false): Promise<PanelVersionInfo> {
  const currentVersion = await getCurrentVersion();
  const now = Date.now();

  // Use cache if available and not expired
  if (!forceRefresh && versionCache && (now - versionCache.checkedAt) < CACHE_DURATION_MS) {
    const updateAvailable = compareVersions(versionCache.latestVersion, currentVersion) > 0;
    return {
      currentVersion,
      latestVersion: versionCache.latestVersion,
      updateAvailable,
      releaseUrl: versionCache.releaseUrl,
      releaseNotes: versionCache.releaseNotes,
      publishedAt: versionCache.publishedAt,
      lastChecked: new Date(versionCache.checkedAt).toISOString(),
    };
  }

  // Fetch latest release from GitHub
  const latest = await fetchLatestRelease();

  if (latest) {
    // Update cache
    versionCache = {
      latestVersion: latest.version,
      releaseUrl: latest.url,
      releaseNotes: latest.notes,
      publishedAt: latest.publishedAt,
      checkedAt: now,
    };

    const updateAvailable = compareVersions(latest.version, currentVersion) > 0;
    return {
      currentVersion,
      latestVersion: latest.version,
      updateAvailable,
      releaseUrl: latest.url,
      releaseNotes: latest.notes,
      publishedAt: latest.publishedAt,
      lastChecked: new Date(now).toISOString(),
    };
  }

  // Return current version info if GitHub check failed
  return {
    currentVersion,
    latestVersion: currentVersion,
    updateAvailable: false,
    releaseUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
    releaseNotes: '',
    publishedAt: '',
    lastChecked: new Date(now).toISOString(),
  };
}

/**
 * Get the cached version info without making a new request
 */
export function getCachedVersionInfo(): VersionCache | null {
  return versionCache;
}

/**
 * Clear the version cache
 */
export function clearVersionCache(): void {
  versionCache = null;
}

export default {
  getCurrentVersion,
  checkPanelUpdate,
  getCachedVersionInfo,
  clearVersionCache,
};
