/**
 * Unified Updates Service
 * Aggregates mod update information from all sources:
 * - CFWidget (CurseForge mods)
 * - Modtale
 * - StackMart
 * - Mod Store
 */

import { getUpdateStatus as getCFWidgetStatus, type TrackedMod } from './cfwidget.js';
import { getInstalledModtaleInfo, getModDetails as getModtaleDetails } from './modtale.js';
import { getInstalledStackMartInfo, getResourceDetails as getStackMartDetails } from './stackmart.js';
import { getModRegistry, isModInstalled, getLatestRelease } from './modStore.js';

export interface UnifiedModUpdate {
  filename: string;
  name: string;
  source: 'cfwidget' | 'modtale' | 'stackmart' | 'modstore';
  installedVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  thumbnail?: string;
  projectUrl?: string;
  lastChecked?: string;
  // Source-specific IDs
  sourceId?: string;
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

  // 2. Get Modtale installed mods
  try {
    const modtaleInstalled = await getInstalledModtaleInfo();
    for (const [, info] of Object.entries(modtaleInstalled)) {
      // Skip if already tracked in CFWidget (by filename)
      if (allMods.some(m => m.filename === info.filename)) continue;

      // Check for updates
      let hasUpdate = false;
      let latestVersion = info.version;
      try {
        const project = await getModtaleDetails(info.projectId);
        if (project && project.versions && project.versions.length > 0) {
          const latestVer = project.versions.find(v => v.channel === 'RELEASE') || project.versions[0];
          latestVersion = latestVer.versionNumber;
          hasUpdate = latestVersion !== info.version;
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
          hasUpdate = latestVersion !== info.version;
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
      if (mod.github) {
        try {
          const release = await getLatestRelease(mod.github);
          if (release) {
            latestVersion = release.tag_name;
            hasUpdate = installed.installedVersion !== release.tag_name;
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
