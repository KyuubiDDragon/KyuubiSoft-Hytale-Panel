/**
 * Filesystem view of a Hytale installation: installed version, staged update,
 * native updater backup and the disk space an update needs.
 *
 * Hytale 0.7 keeps its updater next to the server directory:
 *   /opt/hytale/updater/staging/   downloaded by `/update download`, applied by
 *                                  the launcher (start-server.sh) before java starts
 *   /opt/hytale/updater/backup/    the replaced version, written by `/update apply`
 *                                  (and by start-server.sh when an update is applied
 *                                  without one)
 * Everything here only reads, except discardStagedUpdate (with the server
 * stopped; a running server is asked with `/update cancel`). Server console
 * output is not visible to the panel yet, which is why the Update Center
 * derives its state from these files instead of command output.
 */
import { stat, statfs, readdir, rename } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { readHytaleJarVersion } from '../utils/jarManifest.js';
import { readRegularFile, removeTree } from '../utils/noFollowFs.js';
import { getDefaultId, getServer } from './servers.js';

export const VERSION_FILE_NAME = '.hytale-version';
export const SERVER_JAR_NAME = 'HytaleServer.jar';
export const ASSETS_NAME = 'Assets.zip';
export const AOT_NAME = 'HytaleServer.aot';
/**
 * Written by the game container's entrypoint on every start, with the same
 * random id, into its updater folder and into the server folder. The panel
 * compares both to tell whether it sees the updater folder the game container
 * uses (an old compose file leaves the game container with a private one).
 */
export const UPDATER_MOUNT_MARKER = '.updater-mount-id';

// Free space kept on top of the computed need, so an apply never fills a disk.
const DISK_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024;
const VERSION_FILE_MAX_BYTES = 4096;

export interface InstallPaths {
  serverPath: string;
  /** null when the updater directory is not mounted for this server. */
  updaterPath: string | null;
  backupsPath: string;
}

/**
 * Paths for a server id. Only the compose (default) server has the updater
 * mounted in the manager; additional servers report it as unavailable.
 */
export async function resolveInstallPaths(serverId?: string): Promise<InstallPaths> {
  let serverPath = config.serverPath;
  let backupsPath = config.backupsPath;
  try {
    const id = serverId ?? (await getDefaultId());
    const srv = await getServer(id);
    if (srv) {
      serverPath = srv.paths.server;
      backupsPath = srv.paths.backups;
    }
  } catch {
    // registry not ready: legacy single-server paths
  }
  return {
    serverPath,
    backupsPath,
    updaterPath:
      path.resolve(serverPath) === path.resolve(config.serverPath) ? config.updaterPath : null,
  };
}

/**
 * Whether the panel sees the updater folder the game container uses:
 *  - missing: not mounted in the panel (compose file from before the native
 *    updater, or an additional server);
 *  - not_shared: mounted, but the game container wrote another id into its
 *    updater folder than into the server folder both share (the game
 *    container got a private updater folder, e.g. from an old compose file
 *    with a new image). Its staged updates are invisible to the panel then.
 * Before the game container wrote a marker (first start with this image) a
 * mounted folder counts as shared.
 */
export type UpdaterMountState = 'mounted' | 'missing' | 'not_shared';

async function readMarker(dir: string): Promise<string | null> {
  try {
    const raw = await readRegularFile(path.join(dir, UPDATER_MOUNT_MARKER), [dir], {
      maxBytes: 256,
    });
    return raw.toString('utf-8').trim() || null;
  } catch {
    return null;
  }
}

export async function checkUpdaterMount(paths: InstallPaths): Promise<UpdaterMountState> {
  if (!paths.updaterPath) return 'missing';
  const st = await stat(paths.updaterPath).catch(() => null);
  if (!st?.isDirectory()) return 'missing';
  const expected = await readMarker(paths.serverPath);
  if (!expected) return 'mounted';
  return (await readMarker(paths.updaterPath)) === expected ? 'mounted' : 'not_shared';
}

// ---------- installed version ----------

export interface VersionInfo {
  version: string | null;
  patchline: string | null;
}

export interface InstalledVersion extends VersionInfo {
  source: 'jar' | 'version-file' | 'unknown';
}

/**
 * `.hytale-version` holds the version on the first line and, since the panel
 * stamps it from `java -jar HytaleServer.jar --version`, the patchline on the
 * second. Older files only have the first line.
 */
export function parseVersionFile(content: string): VersionInfo {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { version: lines[0] || null, patchline: lines[1] || null };
}

export async function readVersionFile(serverPath: string): Promise<VersionInfo> {
  try {
    // The server can write here: a link is not followed.
    const raw = await readRegularFile(path.join(serverPath, VERSION_FILE_NAME), [serverPath], {
      maxBytes: VERSION_FILE_MAX_BYTES,
    });
    return parseVersionFile(raw.toString('utf-8'));
  } catch {
    return { version: null, patchline: null };
  }
}

/** Version of the JAR on disk; falls back to the stamped version file. */
export async function readInstalledVersion(serverPath: string): Promise<InstalledVersion> {
  const jar = await readHytaleJarVersion(path.join(serverPath, SERVER_JAR_NAME));
  if (jar) return { ...jar, source: 'jar' };
  const file = await readVersionFile(serverPath);
  if (file.version) return { ...file, source: 'version-file' };
  return { version: null, patchline: null, source: 'unknown' };
}

// ---------- staged update / native backup ----------

async function fileSize(p: string): Promise<number> {
  try {
    const st = await stat(p);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

export interface StagedUpdate extends VersionInfo {
  jarBytes: number;
  assetsBytes: number;
  stagedAt: string;
}

/**
 * The staged update, present as soon as `staging/Server/HytaleServer.jar`
 * exists (the same condition the launcher uses to apply it).
 */
export async function getStagedUpdate(updaterPath: string | null): Promise<StagedUpdate | null> {
  if (!updaterPath) return null;
  const jar = path.join(updaterPath, 'staging', 'Server', SERVER_JAR_NAME);
  let st;
  try {
    st = await stat(jar);
  } catch {
    return null;
  }
  const v = await readHytaleJarVersion(jar);
  return {
    version: v?.version ?? null,
    patchline: v?.patchline ?? null,
    jarBytes: st.size,
    assetsBytes: await fileSize(path.join(updaterPath, 'staging', ASSETS_NAME)),
    stagedAt: st.mtime.toISOString(),
  };
}

const DISCARDED_PREFIX = '.staging-discarded-';

/**
 * Removes what earlier discards could not delete. Never throws. The updater
 * folder belongs to the server, so the trees are deleted without following
 * links (removeTree).
 */
async function sweepDiscarded(updaterPath: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(updaterPath);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.startsWith(DISCARDED_PREFIX))) {
    await removeTree(path.join(updaterPath, name), [updaterPath]).catch((err: unknown) =>
      logger.warn(`[ServerInstall] Could not delete ${name}: ${(err as Error).message}`),
    );
  }
}

export interface StagedAside {
  /** Puts it back as the staged update (when what it was set aside for failed). */
  restore(): Promise<void>;
  /** Deletes it for good; a failure is only logged (it is out of the way already). */
  remove(): Promise<void>;
}

/**
 * Moves the staged update out of the way, so the start script no longer sees
 * it, by a rename (a half-deleted staging folder is never applied). Only while
 * the server is stopped (callers hold the lifecycle lock): a running server
 * may write to it. Returns null when nothing is staged.
 */
export async function setStagedUpdateAside(
  updaterPath: string | null,
): Promise<StagedAside | null> {
  if (!updaterPath) return null;
  await sweepDiscarded(updaterPath);
  const staging = path.join(updaterPath, 'staging');
  const aside = path.join(updaterPath, `${DISCARDED_PREFIX}${Date.now()}`);
  try {
    await rename(staging, aside);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      // An older compose file mounted the updater read-only into the panel.
      throw new Error(
        `The panel cannot change the updater folder (${code}). Mount it writable for the manager in docker-compose.yml and recreate the containers.`,
      );
    }
    throw err;
  }
  return {
    restore: () => rename(aside, staging),
    remove: () => sweepDiscarded(updaterPath),
  };
}

/** Deletes the staged update (see setStagedUpdateAside). False when none was staged. */
export async function discardStagedUpdate(updaterPath: string | null): Promise<boolean> {
  const aside = await setStagedUpdateAside(updaterPath);
  if (!aside) return false;
  await aside.remove();
  return true;
}

export interface NativeBackup extends VersionInfo {
  jarBytes: number;
  aotBytes: number;
  assetsBytes: number;
  hasAssets: boolean;
  createdAt: string;
}

/** The previous version kept in `updater/backup/`, or null. */
export async function getNativeBackup(updaterPath: string | null): Promise<NativeBackup | null> {
  if (!updaterPath) return null;
  const jar = path.join(updaterPath, 'backup', 'Server', SERVER_JAR_NAME);
  let st;
  try {
    st = await stat(jar);
  } catch {
    return null;
  }
  const v = await readHytaleJarVersion(jar);
  const assetsBytes = await fileSize(path.join(updaterPath, 'backup', ASSETS_NAME));
  return {
    version: v?.version ?? null,
    patchline: v?.patchline ?? null,
    jarBytes: st.size,
    aotBytes: await fileSize(path.join(updaterPath, 'backup', 'Server', AOT_NAME)),
    assetsBytes,
    hasAssets: assetsBytes > 0,
    createdAt: st.mtime.toISOString(),
  };
}

// ---------- disk space ----------

export interface DiskNeed {
  /** What the bytes are for, e.g. "backup" or "staged". */
  purpose: string;
  /** Directory the bytes are written to. */
  dir: string;
  bytes: number;
}

export interface DiskVolumeCheck {
  dirs: string[];
  requiredBytes: number;
  freeBytes: number;
  sufficient: boolean;
}

export interface DiskCheck {
  checked: boolean;
  sufficient: boolean;
  requiredBytes: number;
  volumes: DiskVolumeCheck[];
  needs: DiskNeed[];
}

/**
 * Sums the needs per filesystem (same st_dev = same disk, even across bind
 * mounts) and compares each sum with the free space plus a safety margin.
 */
export async function checkDiskSpace(needs: DiskNeed[]): Promise<DiskCheck> {
  const byDev = new Map<string, { dirs: Set<string>; bytes: number; free: number }>();
  for (const need of needs) {
    if (need.bytes <= 0) continue;
    let dev: string;
    let free: number;
    try {
      dev = String((await stat(need.dir)).dev);
      const fsInfo = await statfs(need.dir);
      free = Number(fsInfo.bavail) * Number(fsInfo.bsize);
    } catch {
      return { checked: false, sufficient: true, requiredBytes: 0, volumes: [], needs };
    }
    const entry = byDev.get(dev) ?? { dirs: new Set<string>(), bytes: 0, free };
    entry.dirs.add(need.dir);
    entry.bytes += need.bytes;
    byDev.set(dev, entry);
  }
  const volumes = [...byDev.values()].map((v) => {
    const requiredBytes = v.bytes + DISK_SAFETY_MARGIN_BYTES;
    return {
      dirs: [...v.dirs],
      requiredBytes,
      freeBytes: v.free,
      sufficient: v.free >= requiredBytes,
    };
  });
  return {
    checked: true,
    sufficient: volumes.every((v) => v.sufficient),
    requiredBytes: volumes.reduce((sum, v) => sum + v.requiredBytes, 0),
    volumes,
    needs,
  };
}

/** Size of the newest native world backup, as an estimate for the next one. */
async function newestNativeBackupBytes(backupsPath: string): Promise<number> {
  const dir = path.join(backupsPath, 'native');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.zip'));
  } catch {
    return 0;
  }
  let newest = { mtime: 0, size: 0 };
  for (const name of names) {
    try {
      const st = await stat(path.join(dir, name));
      if (st.isFile() && st.mtimeMs > newest.mtime) newest = { mtime: st.mtimeMs, size: st.size };
    } catch {
      // vanished meanwhile
    }
  }
  return newest.size;
}

/**
 * Disk space applying the staged update needs:
 *  - backup: `/update apply` (or the launcher) copies the current JAR, AOT
 *    cache and Assets.zip (~4 GB) to updater/backup; the old backup is deleted
 *    first, so its size is credited.
 *  - staged: the launcher copies the staged JAR and Assets.zip into the server
 *    directory (a different mount, so a copy, not a rename) before swapping.
 *  - world: with RunBackupBeforeUpdate a native world backup is written first.
 */
export async function checkApplyDiskSpace(
  paths: InstallPaths,
  staged: StagedUpdate,
  backup: NativeBackup | null,
  { worldBackup }: { worldBackup: boolean },
): Promise<DiskCheck> {
  if (!paths.updaterPath) {
    return { checked: false, sufficient: true, requiredBytes: 0, volumes: [], needs: [] };
  }
  const current =
    (await fileSize(path.join(paths.serverPath, SERVER_JAR_NAME))) +
    (await fileSize(path.join(paths.serverPath, AOT_NAME))) +
    (await fileSize(path.join(paths.serverPath, ASSETS_NAME)));
  const oldBackup = backup ? backup.jarBytes + backup.aotBytes + backup.assetsBytes : 0;
  const needs: DiskNeed[] = [
    { purpose: 'backup', dir: paths.updaterPath, bytes: Math.max(0, current - oldBackup) },
    { purpose: 'staged', dir: paths.serverPath, bytes: staged.jarBytes + staged.assetsBytes },
  ];
  if (worldBackup) {
    needs.push({
      purpose: 'world',
      dir: paths.backupsPath,
      bytes: await newestNativeBackupBytes(paths.backupsPath),
    });
  }
  return checkDiskSpace(needs);
}
