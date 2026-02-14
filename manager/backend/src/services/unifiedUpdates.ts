/**
 * Unified Updates Service
 * Aggregates mod update information from all sources:
 * - CFWidget (CurseForge mods via free proxy)
 * - CurseForge API (direct API)
 * - Modtale
 * - StackMart
 * - Mod Store
 */

import { getUpdateStatus as getCFWidgetStatus, type TrackedMod } from './cfwidget.js';
import { getInstalledCurseForgeInfo, checkForUpdates as checkCurseForgeUpdates, getFileChangelog as getCurseForgeChangelog } from './curseforge.js';
import { getInstalledModtaleInfo, getModDetails as getModtaleDetails } from './modtale.js';
import { getInstalledStackMartInfo, getResourceDetails as getStackMartDetails } from './stackmart.js';
import { getModRegistry, isModInstalled, getLatestRelease } from './modStore.js';

/**
 * Normalize version string for comparison (remove 'v' prefix and trim)
 */
function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '').trim();
}

/**
 * Compare two version strings. Returns true if they are semantically equal.
 * Handles 'v' prefix differences (v1.2.6 == 1.2.6)
 */
function versionsAreEqual(v1: string, v2: string): boolean {
  return normalizeVersion(v1) === normalizeVersion(v2);
}

export interface UnifiedModUpdate {
  filename: string;
  name: string;
  source: 'cfwidget' | 'curseforge' | 'modtale' | 'stackmart' | 'modstore';
  installedVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  thumbnail?: string;
  projectUrl?: string;
  lastChecked?: string;
  // Source-specific IDs
  sourceId?: string;
  modId?: number;
  // Changelog for the latest version
  changelog?: string;
}

export interface UnifiedUpdateStatus {
  totalTracked: number;
  updatesAvailable: number;
  lastChecked: string | null;
  mods: UnifiedModUpdate[];
}

/**
 * Get unified update status from all sources
 */
export async function getUnifiedUpdateStatus(): Promise<UnifiedUpdateStatus> {
  const allMods: UnifiedModUpdate[] = [];
  let updatesAvailable = 0;

  // 1. Get CFWidget tracked mods (includes CurseForge installs)
  try {
    const cfwidgetStatus = await getCFWidgetStatus();
    for (const mod of cfwidgetStatus.mods) {
      allMods.push({
        filename: mod.filename,
        name: mod.projectTitle || mod.curseforgeSlug,
        source: 'cfwidget',
        installedVersion: mod.installedVersion || '-',
        latestVersion: mod.latestVersion || '-',
        hasUpdate: mod.hasUpdate,
        thumbnail: mod.thumbnail,
        projectUrl: mod.projectUrl,
        lastChecked: mod.lastChecked,
        sourceId: mod.curseforgeSlug,
      });
      if (mod.hasUpdate) updatesAvailable++;
    }
  } catch (e) {
    console.error('[UnifiedUpdates] Failed to get CFWidget status:', e);
  }

  // 2. Get CurseForge API installed mods (not already in CFWidget)
  try {
    const curseforgeInstalled = await getInstalledCurseForgeInfo();
    const curseforgeUpdates = await checkCurseForgeUpdates();

    for (const [modIdStr, info] of Object.entries(curseforgeInstalled)) {
      // Skip if already tracked in CFWidget (by filename)
      if (allMods.some(m => m.filename === info.filename)) continue;

      // Find update info
      const updateInfo = curseforgeUpdates.find(u => u.modId === parseInt(modIdStr));
      const hasUpdate = updateInfo?.hasUpdate || false;
      const latestVersion = updateInfo?.latestVersion || info.version;

      // Get changelog if update is available
      let changelog: string | undefined;
      if (hasUpdate && updateInfo?.latestFileId) {
        try {
          const changelogText = await getCurseForgeChangelog(info.modId, updateInfo.latestFileId);
          if (changelogText) {
            changelog = changelogText;
          }
        } catch {
          // Failed to get changelog
        }
      }

      allMods.push({
        filename: info.filename,
        name: info.modName,
        source: 'curseforge',
        installedVersion: info.version,
        latestVersion,
        hasUpdate,
        lastChecked: new Date().toISOString(),
        sourceId: modIdStr,
        modId: info.modId,
        changelog,
      });
      if (hasUpdate) updatesAvailable++;
    }
  } catch (e) {
    console.error('[UnifiedUpdates] Failed to get CurseForge API status:', e);
  }

  // 3. Get Modtale installed mods (not already tracked)
  try {
    const modtaleInstalled = await getInstalledModtaleInfo();
    for (const [, info] of Object.entries(modtaleInstalled)) {
      // Skip if already tracked in CFWidget (by filename)
      if (allMods.some(m => m.filename === info.filename)) continue;

      // Check for updates
      let hasUpdate = false;
      let latestVersion = info.version;
      let changelog: string | undefined;
      try {
        const project = await getModtaleDetails(info.projectId);
        if (project && project.versions && project.versions.length > 0) {
          const latestVer = project.versions.find(v => v.channel === 'RELEASE') || project.versions[0];
          latestVersion = latestVer.versionNumber;
          // Use normalized version comparison to handle 'v' prefix differences
          hasUpdate = !versionsAreEqual(info.version, latestVersion);
          // Get changelog from latest version
          if (hasUpdate && latestVer.changelog) {
            changelog = latestVer.changelog;
          }
        }
      } catch {
        // Failed to check, keep current version
      }

      allMods.push({
        filename: info.filename,
        name: info.projectTitle,
        source: 'modtale',
        installedVersion: info.version,
        latestVersion,
        hasUpdate,
        sourceId: info.projectId,
        lastChecked: new Date().toISOString(),
        changelog,
      });
      if (hasUpdate) updatesAvailable++;
    }
  } catch (e) {
    console.error('[UnifiedUpdates] Failed to get Modtale status:', e);
  }

  // 3. Get StackMart installed resources
  try {
    const stackmartInstalled = await getInstalledStackMartInfo();
    for (const [, info] of Object.entries(stackmartInstalled)) {
      // Skip if already tracked in CFWidget (by filename)
      if (allMods.some(m => m.filename === info.filename)) continue;

      // Check for updates
      let hasUpdate = false;
      let latestVersion = info.version;
      try {
        const result = await getStackMartDetails(info.resourceId);
        if (result && result.resource && result.resource.version) {
          latestVersion = result.resource.version;
          // Use normalized version comparison to handle 'v' prefix differences
          hasUpdate = !versionsAreEqual(info.version, latestVersion);
        }
      } catch {
        // Failed to check, keep current version
      }

      allMods.push({
        filename: info.filename,
        name: info.resourceName,
        source: 'stackmart',
        installedVersion: info.version,
        latestVersion,
        hasUpdate,
        sourceId: info.resourceId,
        lastChecked: new Date().toISOString(),
      });
      if (hasUpdate) updatesAvailable++;
    }
  } catch (e) {
    console.error('[UnifiedUpdates] Failed to get StackMart status:', e);
  }

  // 4. Get Mod Store installed mods
  try {
    const registry = await getModRegistry();
    for (const mod of registry) {
      const installed = await isModInstalled(mod.id, registry);
      if (!installed.installed || !installed.filename) continue;

      // Skip if already tracked in CFWidget (by filename)
      if (allMods.some(m => m.filename === installed.filename)) continue;

      // Check for updates via GitHub
      let hasUpdate = false;
      let latestVersion = installed.installedVersion || mod.version || '-';
      let changelog: string | undefined;
      if (mod.github) {
        try {
          const release = await getLatestRelease(mod.github);
          if (release) {
            latestVersion = release.tag_name;
            // Use normalized version comparison to handle 'v' prefix differences
            hasUpdate = !versionsAreEqual(installed.installedVersion || '', release.tag_name);
            // Get changelog from GitHub release body
            if (hasUpdate && release.body) {
              changelog = release.body;
            }
          }
        } catch {
          // Failed to check
        }
      }

      allMods.push({
        filename: installed.filename,
        name: mod.name,
        source: 'modstore',
        installedVersion: installed.installedVersion || '-',
        latestVersion,
        hasUpdate,
        sourceId: mod.id,
        lastChecked: new Date().toISOString(),
        changelog,
      });
      if (hasUpdate) updatesAvailable++;
    }
  } catch (e) {
    console.error('[UnifiedUpdates] Failed to get ModStore status:', e);
  }

  return {
    totalTracked: allMods.length,
    updatesAvailable,
    lastChecked: new Date().toISOString(),
    mods: allMods,
  };
}

export default {
  getUnifiedUpdateStatus,
};
