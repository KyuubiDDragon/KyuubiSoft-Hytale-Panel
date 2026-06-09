/**
 * Storage / disk usage reporting.
 *
 * Surfaces two things the watchdog's low-disk alert can't show on its own:
 *   - the filesystem totals (total / used / free) of each server's data volume, and
 *   - a per-category size breakdown (server, worlds, backups, mods, plugins, assets)
 *     so operators can see WHAT is filling the disk — usually growing worlds or
 *     an un-pruned backup folder, the two most common "server won't start, disk
 *     full" causes.
 *
 * Directory sizing walks the tree with lstat (symlinks are not followed, so a
 * symlinked world isn't counted twice and link loops can't hang the walk). The
 * result is cached briefly because a full walk of a multi-GB world is not free.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getServer, getDefaultId } from './servers.js';
import { getWorldsPaths } from './managementHelpers.js';
import { isDemoMode } from './demoData.js';

export interface StorageCategory {
  name: string;
  path: string;
  bytes: number;
  exists: boolean;
}

export interface FilesystemUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface StorageBreakdown {
  filesystem: FilesystemUsage | null;
  categories: StorageCategory[];
  trackedBytes: number; // sum of categories
  generatedAt: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: StorageBreakdown }>();

/**
 * Recursively sum file sizes under `dir`. Symlinks are NOT followed. Errors on
 * individual entries (permissions, races) are ignored so one bad file can't
 * abort the whole measurement.
 */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue; // don't follow — avoids double counting + loops
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isFile()) {
        const st = await fs.promises.lstat(full);
        total += st.size;
      }
    } catch {
      // entry vanished or unreadable — skip
    }
  }
  return total;
}

function statfsUsage(p: string): FilesystemUsage | null {
  try {
    const st = fs.statfsSync(p);
    const totalBytes = st.blocks * st.bsize;
    const freeBytes = st.bavail * st.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      path: p,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0,
    };
  } catch {
    return null; // statfs unsupported on this platform/fs
  }
}

async function resolveServerPaths(serverId?: string): Promise<{ server: string; data: string; backups: string; mods: string; plugins: string; assets: string }> {
  try {
    const id = serverId ?? (await getDefaultId());
    const srv = await getServer(id);
    if (srv) return srv.paths;
  } catch {
    // registry not ready — fall back to the env-configured default paths
  }
  return {
    server: config.serverPath,
    data: config.dataPath,
    backups: config.backupsPath,
    mods: config.modsPath,
    plugins: config.pluginsPath,
    assets: config.assetsPath,
  };
}

export async function getStorageBreakdown(serverId?: string): Promise<StorageBreakdown> {
  if (isDemoMode()) {
    const gb = (n: number) => Math.round(n * 1024 ** 3);
    const categories: StorageCategory[] = [
      { name: 'worlds', path: '/opt/hytale/data/worlds', bytes: gb(4.2), exists: true },
      { name: 'backups', path: '/opt/hytale/backups', bytes: gb(2.1), exists: true },
      { name: 'server', path: '/opt/hytale/server', bytes: gb(1.3), exists: true },
      { name: 'assets', path: '/opt/hytale/assets', bytes: gb(0.9), exists: true },
      { name: 'mods', path: '/opt/hytale/mods', bytes: gb(0.2), exists: true },
      { name: 'plugins', path: '/opt/hytale/plugins', bytes: gb(0.05), exists: true },
    ];
    const trackedBytes = categories.reduce((s, c) => s + c.bytes, 0);
    return {
      filesystem: { path: '/opt/hytale', totalBytes: gb(40), freeBytes: gb(31), usedBytes: gb(9), usedPercent: 22.5 },
      categories,
      trackedBytes,
      generatedAt: new Date().toISOString(),
    };
  }

  const cacheKey = serverId ?? '__default__';
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  const paths = await resolveServerPaths(serverId);

  // Worlds can live in several locations (data/worlds, server/universe/worlds,
  // server/worlds). Sum the real ones, de-duplicating by resolved path so a
  // symlinked location isn't counted twice.
  const worldPaths = getWorldsPaths();
  const seenWorldReal = new Set<string>();
  let worldsBytes = 0;
  let worldsRepresentativePath = worldPaths[0] ?? path.join(paths.data, 'worlds');
  let worldsExist = false;
  for (const wp of worldPaths) {
    try {
      const real = fs.realpathSync(wp);
      if (seenWorldReal.has(real)) continue;
      seenWorldReal.add(real);
      worldsBytes += await dirSize(wp);
      worldsExist = true;
      worldsRepresentativePath = wp;
    } catch {
      // path doesn't exist — skip
    }
  }

  const categoryDefs: Array<{ name: string; path: string }> = [
    { name: 'worlds', path: worldsRepresentativePath },
    { name: 'backups', path: paths.backups },
    { name: 'server', path: paths.server },
    { name: 'assets', path: paths.assets },
    { name: 'mods', path: paths.mods },
    { name: 'plugins', path: paths.plugins },
  ];

  const categories: StorageCategory[] = [];
  for (const def of categoryDefs) {
    if (def.name === 'worlds') {
      categories.push({ name: 'worlds', path: def.path, bytes: worldsBytes, exists: worldsExist });
      continue;
    }
    // The server dir contains the universe/worlds symlink target; dirSize skips
    // symlinks so worlds aren't double-counted under both "server" and "worlds".
    const exists = fs.existsSync(def.path);
    const bytes = exists ? await dirSize(def.path) : 0;
    categories.push({ name: def.name, path: def.path, bytes, exists });
  }

  categories.sort((a, b) => b.bytes - a.bytes);
  const trackedBytes = categories.reduce((s, c) => s + c.bytes, 0);

  const data: StorageBreakdown = {
    filesystem: statfsUsage(paths.data),
    categories,
    trackedBytes,
    generatedAt: new Date().toISOString(),
  };
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}
