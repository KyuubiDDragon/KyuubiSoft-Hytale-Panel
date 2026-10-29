/**
 * Server update history + rollback.
 *
 *   1. History log of every update and rollback the panel started, at
 *      <dataPath>/update-history.json. An apply is recorded as pending and only
 *      marked successful once the server runs the target version
 *      (reconcilePendingUpdates); sending `/update apply` proves nothing.
 *   2. JAR snapshots in <serverPath>/.jar-snapshots/: a copy of
 *      HytaleServer.jar plus hard links to the Assets.zip and HytaleServer.aot
 *      it ran with. A link costs no disk space as long as the original exists;
 *      the launcher replaces both with new files instead of rewriting them, so
 *      the linked copy stays the old version. Should something rewrite the
 *      live file in place, the link changes with it: size and mtime are
 *      recorded, and a link that no longer matches them is not restored.
 *   3. Rollback, only while the server is stopped (callers wrap it in
 *      withServerStopped): every file is copied next to its destination and
 *      swapped in by rename, so a JVM never has a JAR rewritten under it and a
 *      full disk never leaves a half-written file behind. The source is a
 *      snapshot or the previous version in updater/backup (written by
 *      `/update apply` and by the launcher).
 *
 * The manager container bind-mounts the server dir (same UID 9999 as the game
 * container), so plain fs operations are enough — no docker exec needed. The
 * game server can write to every folder used here (server, updater, the world
 * data folder with the history), so nothing is read or copied through a link:
 * see noFollowFs. A link, a foreign hard link or a file outside its folder
 * stops the action with a message that names the file.
 */
import fs from 'fs';
import { lstat, mkdir, readdir, rename, rm } from 'fs/promises';
import type { Stats } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { readHytaleJarVersion } from '../utils/jarManifest.js';
import { withFileLock } from '../utils/jsonStore.js';
import {
  UnsafeFileError,
  assertRegularDirectory,
  copyDirectoryTree,
  copyRegularFile,
  linkRegularFile,
  readRegularFile,
  removeTree,
  replaceFileContent,
} from '../utils/noFollowFs.js';
import {
  resolveInstallPaths,
  readInstalledVersion,
  getNativeBackup,
  checkDiskSpace,
  VERSION_FILE_NAME,
  SERVER_JAR_NAME,
  ASSETS_NAME,
  AOT_NAME,
} from './serverInstall.js';

const HISTORY_FILE = path.join(config.dataPath, 'update-history.json');
const SNAPSHOT_DIRNAME = '.jar-snapshots';
const MAX_HISTORY = 100;
const MAX_SNAPSHOTS = 5;
// Only the newest snapshots keep their Assets.zip link: each linked version
// keeps ~4 GB alive once the live Assets.zip has been replaced.
const MAX_ASSET_SNAPSHOTS = 2;
// An apply that has not reached its target version after this long failed.
const PENDING_APPLY_TIMEOUT_MS = 30 * 60 * 1000;
// Size caps for files the panel wrote itself (anything bigger is not one of them).
const HISTORY_MAX_BYTES = 1024 * 1024;
const SIDECAR_MAX_BYTES = 64 * 1024;
const MAX_VERSION_IN_NAME = 40;
// Snapshot ids and file names as the panel creates them; a sidecar with
// anything else (a path, "..") is ignored.
const SNAPSHOT_ID_RE = /^snap-[0-9A-Za-z-]+$/;
const SNAPSHOT_FILE_RE = /^(?!\.\.?$)[0-9A-Za-z._-]{1,200}$/;

export interface UpdateHistoryEntry {
  id: string;
  at: string;
  fromVersion: string | null;
  toVersion: string | null;
  action: 'apply' | 'rollback';
  by: string | null;
  success: boolean;
  /** Apply requested, not confirmed yet. */
  pending?: boolean;
  note?: string;
}

export interface JarSnapshot {
  id: string;
  version: string | null;
  createdAt: string;
  sizeBytes: number;
  file: string;
  /** Hard link to the Assets.zip of this version, when it could be kept. */
  assetsFile?: string;
  assetsSizeBytes?: number;
  assetsMtimeMs?: number;
  hasAssets?: boolean;
  /** Hard link to the HytaleServer.aot of this version. */
  aotFile?: string;
  aotSizeBytes?: number;
  aotMtimeMs?: number;
  hasAot?: boolean;
}

export interface RollbackResult {
  success: boolean;
  error?: string;
  restoredVersion?: string | null;
  /** Whether Assets.zip was restored together with the JAR. */
  restoredAssets?: boolean;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return (await lstatOrNull(p)) !== null;
}

// ---------- history ----------

async function readHistory(): Promise<UpdateHistoryEntry[]> {
  try {
    const raw = await readRegularFile(HISTORY_FILE, [config.dataPath], {
      maxBytes: HISTORY_MAX_BYTES,
    });
    const data = JSON.parse(raw.toString('utf-8')) as unknown;
    return Array.isArray(data) ? (data as UpdateHistoryEntry[]) : [];
  } catch (err) {
    if (err instanceof UnsafeFileError) logger.warn(`[UpdateHistory] ${err.message}`);
    return [];
  }
}

export function getUpdateHistory(): Promise<UpdateHistoryEntry[]> {
  return readHistory();
}

/** Callers hold the history lock. Never throws (a failed write is logged). */
async function writeHistory(list: UpdateHistoryEntry[]): Promise<void> {
  try {
    await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    await replaceFileContent(HISTORY_FILE, JSON.stringify(list.slice(0, MAX_HISTORY), null, 2), [
      config.dataPath,
    ]);
  } catch (err) {
    logger.error('[UpdateHistory] Failed to write history:', err);
  }
}

export async function recordUpdate(
  entry: Omit<UpdateHistoryEntry, 'id' | 'at'>,
): Promise<UpdateHistoryEntry> {
  const full: UpdateHistoryEntry = {
    id: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...entry,
  };
  await withFileLock(HISTORY_FILE, async () => writeHistory([full, ...(await readHistory())]));
  return full;
}

/**
 * Resolves pending applies against what is installed now: done once the
 * installed version equals the target, failed when the staged update is gone
 * without that, or when nothing happened for PENDING_APPLY_TIMEOUT_MS.
 */
export function reconcilePendingUpdates(
  list: UpdateHistoryEntry[],
  state: { installedVersion: string | null; stagedPresent: boolean },
  now: number = Date.now(),
): UpdateHistoryEntry[] {
  return list.map((entry) => {
    if (!entry.pending) return entry;
    if (entry.toVersion && state.installedVersion === entry.toVersion) {
      return { ...entry, pending: false, success: true, note: undefined };
    }
    const age = now - Date.parse(entry.at);
    if (!state.stagedPresent && age > 60_000) {
      return {
        ...entry,
        pending: false,
        success: false,
        note: `Installed version is ${state.installedVersion ?? 'unknown'} after the update`,
      };
    }
    if (age > PENDING_APPLY_TIMEOUT_MS) {
      return {
        ...entry,
        pending: false,
        success: false,
        note: 'The update was not applied in time',
      };
    }
    return entry;
  });
}

/** History with pending applies resolved (and persisted when something changed). */
export async function getReconciledHistory(serverId?: string): Promise<UpdateHistoryEntry[]> {
  const list = await readHistory();
  if (!list.some((e) => e.pending)) return list;
  const paths = await resolveInstallPaths(serverId);
  const installed = await readInstalledVersion(paths.serverPath);
  const stagedPresent =
    !!paths.updaterPath &&
    fs.existsSync(path.join(paths.updaterPath, 'staging', 'Server', SERVER_JAR_NAME));
  return withFileLock(HISTORY_FILE, async () => {
    const current = await readHistory();
    const next = reconcilePendingUpdates(current, {
      installedVersion: installed.version,
      stagedPresent,
    });
    if (JSON.stringify(next) !== JSON.stringify(current)) await writeHistory(next);
    return next;
  });
}

// ---------- file helpers ----------

interface Replacement {
  src: string;
  dest: string;
  /** Folder the real source must lie in (server dir or updater). */
  srcRoot: string;
  /** Folder the real destination must lie in. */
  destRoot: string;
  /** Hard link instead of copying when both are on the same filesystem. */
  allowLink?: boolean;
  /** Hard links of the source the panel made itself (snapshot links). */
  knownLinks?: string[];
  dir?: boolean;
}

const tempNameFor = (dest: string) =>
  path.join(path.dirname(dest), `.${path.basename(dest)}.rollback-tmp`);
const oldNameFor = (dest: string) =>
  path.join(path.dirname(dest), `.${path.basename(dest)}.rollback-old`);

/** Copies (or links) one source to its temporary name; nothing is followed. */
async function prepareReplacement(item: Replacement, tmp: string): Promise<void> {
  const opts = {
    srcRoots: [item.srcRoot],
    destRoots: [item.destRoot],
    knownLinks: item.knownLinks,
  };
  if (item.dir) {
    await copyDirectoryTree(item.src, tmp, opts);
    return;
  }
  if (item.allowLink) {
    try {
      await linkRegularFile(item.src, tmp, opts);
      return;
    } catch (err) {
      if (err instanceof UnsafeFileError) throw err;
      // other filesystem / no hard links: copy instead
    }
  }
  await copyRegularFile(item.src, tmp, opts);
}

/**
 * Replaces several files as one step. Every source is first copied (or hard
 * linked) to a temporary name next to its destination; a failure there (full
 * disk, missing file, a link) removes the temporaries and changes nothing.
 * Then each current file is moved aside and the new one renamed into place; if
 * one of these renames fails, the files already swapped are put back. Async,
 * so copying a 4 GB Assets.zip does not block the panel. Leftovers are
 * deleted with removeTree: the server could swap a folder in them for a link.
 */
async function replaceFiles(items: Replacement[]): Promise<void> {
  const remove = (p: string, item: Replacement) => removeTree(p, [item.destRoot]);
  const prepared: Replacement[] = [];
  try {
    for (const item of items) {
      const tmp = tempNameFor(item.dest);
      await remove(tmp, item);
      // Left by an interrupted earlier swap; it may hold another link of the source.
      await remove(oldNameFor(item.dest), item);
      prepared.push(item);
      await prepareReplacement(item, tmp);
    }
  } catch (err) {
    for (const item of prepared) {
      await remove(tempNameFor(item.dest), item);
    }
    throw err;
  }

  const swapped: { item: Replacement; hadOld: boolean }[] = [];
  try {
    for (const item of items) {
      const hadOld = await exists(item.dest);
      if (hadOld) await rename(item.dest, oldNameFor(item.dest));
      swapped.push({ item, hadOld });
      await rename(tempNameFor(item.dest), item.dest);
    }
  } catch (err) {
    for (const { item, hadOld } of swapped.reverse()) {
      // dest is either the new file or missing (its rename failed)
      await remove(item.dest, item).catch(() => undefined);
      if (hadOld) await rename(oldNameFor(item.dest), item.dest).catch(() => undefined);
    }
    for (const item of items) {
      await remove(tempNameFor(item.dest), item).catch(() => undefined);
    }
    throw err;
  }
  for (const item of items) {
    await remove(oldNameFor(item.dest), item);
  }
}

async function writeVersionFile(
  serverPath: string,
  version: string | null,
  patchline: string | null,
) {
  if (!version) return;
  // start-server.sh rewrites it from the JAR on the next start; this keeps the
  // panel right until then. Replaced by rename, so a planted link is not
  // written through.
  await replaceFileContent(
    path.join(serverPath, VERSION_FILE_NAME),
    `${version}\n${patchline ?? ''}\n`,
    [serverPath],
  );
}

// ---------- JAR snapshots ----------

/** The snapshot folder, or null when it does not exist (and `create` is off). Never a link. */
async function snapshotDir(serverPath: string, create: boolean): Promise<string | null> {
  const dir = path.join(serverPath, SNAPSHOT_DIRNAME);
  if (create) {
    await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  } else if (!(await exists(dir))) {
    return null;
  }
  await assertRegularDirectory(dir, [serverPath]);
  return dir;
}

/** Entries of the snapshot folder with this extension (the panel's own links). */
async function snapshotEntries(dir: string, ext: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** A snapshot from its sidecar; null when it is not one the panel wrote. */
function snapshotFromSidecar(meta: unknown, sidecarName: string): JarSnapshot | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const id = sidecarName.slice(0, -'.json'.length);
  const fileName = (v: unknown) =>
    typeof v === 'string' && SNAPSHOT_FILE_RE.test(v) ? v : undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const file = fileName(m.file);
  if (m.id !== id || !SNAPSHOT_ID_RE.test(id) || !file || typeof m.createdAt !== 'string') {
    return null;
  }
  return {
    id,
    version: typeof m.version === 'string' ? m.version.slice(0, 100) : null,
    createdAt: m.createdAt.slice(0, 40),
    sizeBytes: num(m.sizeBytes) ?? 0,
    file,
    assetsFile: fileName(m.assetsFile),
    assetsSizeBytes: num(m.assetsSizeBytes),
    assetsMtimeMs: num(m.assetsMtimeMs),
    aotFile: fileName(m.aotFile),
    aotSizeBytes: num(m.aotSizeBytes),
    aotMtimeMs: num(m.aotMtimeMs),
  };
}

/**
 * Whether a linked file of a snapshot is still the version it was linked as:
 * a regular file and, where recorded, with the same size and mtime.
 */
async function linkIntact(
  dir: string,
  file?: string,
  size?: number,
  mtimeMs?: number,
): Promise<boolean> {
  if (!file) return false;
  const st = await lstatOrNull(path.join(dir, file));
  return (
    !!st &&
    st.isFile() &&
    (size === undefined || st.size === size) &&
    (mtimeMs === undefined || Math.floor(st.mtimeMs) === mtimeMs)
  );
}

async function readSnapshots(serverPath: string): Promise<JarSnapshot[]> {
  let dir: string | null;
  let names: string[];
  try {
    dir = await snapshotDir(serverPath, false);
    if (!dir) return [];
    names = await readdir(dir);
  } catch (err) {
    logger.warn(`[UpdateHistory] Cannot read the JAR snapshots: ${errorText(err)}`);
    return [];
  }
  const snapshots: JarSnapshot[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let meta: JarSnapshot | null;
    try {
      const raw = await readRegularFile(path.join(dir, name), [serverPath], {
        maxBytes: SIDECAR_MAX_BYTES,
      });
      meta = snapshotFromSidecar(JSON.parse(raw.toString('utf-8')), name);
    } catch {
      continue; // corrupt or unsafe sidecar — skip
    }
    // Only list snapshots whose JAR is still present.
    if (!meta || !(await lstatOrNull(path.join(dir, meta.file)))?.isFile()) continue;
    snapshots.push({
      ...meta,
      hasAssets: await linkIntact(dir, meta.assetsFile, meta.assetsSizeBytes, meta.assetsMtimeMs),
      hasAot: await linkIntact(dir, meta.aotFile, meta.aotSizeBytes, meta.aotMtimeMs),
    });
  }
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return snapshots;
}

export async function listJarSnapshots(serverId?: string): Promise<JarSnapshot[]> {
  const { serverPath } = await resolveInstallPaths(serverId);
  return readSnapshots(serverPath);
}

/**
 * Hard-links `src` into the snapshot dir as `name`; returns its stats, or null
 * when there is no such file or no hard link is possible. A link or a foreign
 * hard link at `src` throws (UnsafeFileError).
 */
async function linkIntoSnapshot(
  src: string,
  dir: string,
  name: string,
  serverPath: string,
): Promise<{ sizeBytes: number; mtimeMs: number } | null> {
  if (!(await exists(src))) return null;
  try {
    const st = await linkRegularFile(src, path.join(dir, name), {
      srcRoots: [serverPath],
      destRoots: [serverPath],
      // Older snapshots of the same version link the same file.
      knownLinks: await snapshotEntries(dir, path.extname(name)),
    });
    return { sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } catch (err) {
    if (err instanceof UnsafeFileError) throw err;
    logger.warn(
      `[UpdateHistory] Could not link ${path.basename(src)} into the snapshot (${errorText(err)}); the snapshot holds it without that file.`,
    );
    return null;
  }
}

/**
 * Copies the current HytaleServer.jar into the snapshots dir and hard-links the
 * current Assets.zip and HytaleServer.aot next to it. Returns null (with a
 * logged reason) if there's no JAR yet; throws UnsafeFileError if one of the
 * files is a link. Prunes old snapshots beyond MAX_SNAPSHOTS, never `keepId`.
 */
export async function snapshotCurrentJar(
  serverId?: string,
  { keepId }: { keepId?: string } = {},
): Promise<JarSnapshot | null> {
  const { serverPath } = await resolveInstallPaths(serverId);
  const jarPath = path.join(serverPath, SERVER_JAR_NAME);
  if (!(await exists(jarPath))) {
    logger.info('[UpdateHistory] No HytaleServer.jar to snapshot yet — skipping.');
    return null;
  }
  const version = (await readInstalledVersion(serverPath)).version;
  const dir = (await snapshotDir(serverPath, true)) as string;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `snap-${ts}`;
  const safeVersion = (version ?? 'unknown')
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .slice(0, MAX_VERSION_IN_NAME);
  const jarFile = `HytaleServer-${safeVersion}-${ts}.jar`;
  const assetsFile = `Assets-${safeVersion}-${ts}.zip`;
  const aotFile = `HytaleServer-${safeVersion}-${ts}.aot`;
  await replaceFiles([
    { src: jarPath, dest: path.join(dir, jarFile), srcRoot: serverPath, destRoot: serverPath },
  ]);

  const meta: JarSnapshot = {
    id,
    version,
    createdAt: new Date().toISOString(),
    sizeBytes: 0,
    file: jarFile,
  };
  try {
    meta.sizeBytes = (await lstat(path.join(dir, jarFile))).size;
    const assets = await linkIntoSnapshot(
      path.join(serverPath, ASSETS_NAME),
      dir,
      assetsFile,
      serverPath,
    );
    if (assets) {
      meta.assetsFile = assetsFile;
      meta.assetsSizeBytes = assets.sizeBytes;
      meta.assetsMtimeMs = assets.mtimeMs;
    }
    const aot = await linkIntoSnapshot(path.join(serverPath, AOT_NAME), dir, aotFile, serverPath);
    if (aot) {
      meta.aotFile = aotFile;
      meta.aotSizeBytes = aot.sizeBytes;
      meta.aotMtimeMs = aot.mtimeMs;
    }
    await replaceFileContent(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2), [
      serverPath,
    ]);
  } catch (err) {
    for (const f of [jarFile, assetsFile, aotFile]) {
      await rm(path.join(dir, f), { force: true }).catch(() => undefined);
    }
    throw err;
  }
  logger.info(
    `[UpdateHistory] Snapshotted JAR (version=${version ?? 'unknown'}, ${Math.round(meta.sizeBytes / 1024 / 1024)} MB${meta.assetsFile ? ', Assets.zip linked' : ''}${meta.aotFile ? ', AOT cache linked' : ''})`,
  );

  await pruneSnapshots(serverPath, dir, keepId);
  return { ...meta, hasAssets: !!meta.assetsFile, hasAot: !!meta.aotFile };
}

/** A snapshot of the current files before a rollback; a failure only costs the undo point. */
async function snapshotBeforeRollback(serverId: string | undefined, keepId?: string) {
  await snapshotCurrentJar(serverId, { keepId }).catch((err) =>
    logger.warn(
      `[UpdateHistory] No snapshot of the current version before the rollback: ${errorText(err)}`,
    ),
  );
}

async function pruneSnapshots(serverPath: string, dir: string, keepId?: string): Promise<void> {
  const all = (await readSnapshots(serverPath)).filter((s) => s.id !== keepId);
  for (const [index, snap] of all.entries()) {
    try {
      const linked = [snap.assetsFile, snap.aotFile].filter((f): f is string => !!f);
      if (index >= MAX_SNAPSHOTS) {
        await rm(path.join(dir, snap.file), { force: true });
        for (const f of linked) await rm(path.join(dir, f), { force: true });
        await rm(path.join(dir, `${snap.id}.json`), { force: true });
      } else if (index >= MAX_ASSET_SNAPSHOTS && linked.length > 0) {
        for (const f of linked) await rm(path.join(dir, f), { force: true });
        const jarOnly: JarSnapshot = {
          id: snap.id,
          version: snap.version,
          createdAt: snap.createdAt,
          sizeBytes: snap.sizeBytes,
          file: snap.file,
        };
        await replaceFileContent(
          path.join(dir, `${snap.id}.json`),
          JSON.stringify(jarOnly, null, 2),
          [serverPath],
        );
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Restores a snapshot. The server must be stopped (withServerStopped). The
 * current JAR is snapshotted first, so a rollback can itself be undone. An
 * AOT cache only works with the JAR that made it: the snapshot's is restored
 * with it; one from an older snapshot without it stays and Java ignores it.
 */
export async function rollbackToSnapshot(
  snapshotId: string,
  serverId?: string,
): Promise<RollbackResult> {
  const { serverPath } = await resolveInstallPaths(serverId);
  const dir = path.join(serverPath, SNAPSHOT_DIRNAME);
  const snap = (await readSnapshots(serverPath)).find((s) => s.id === snapshotId);
  if (!snap) return { success: false, error: 'Snapshot not found' };

  const snapJar = path.join(dir, snap.file);
  if (!(await exists(snapJar))) return { success: false, error: 'Snapshot file missing' };
  const snapAssets = snap.hasAssets && snap.assetsFile ? path.join(dir, snap.assetsFile) : null;
  const snapAot = snap.hasAot && snap.aotFile ? path.join(dir, snap.aotFile) : null;
  const inServer = { srcRoot: serverPath, destRoot: serverPath };

  try {
    await snapshotBeforeRollback(serverId, snapshotId);
    // Collected after that snapshot, which links the live files once more.
    const assetLinks = [
      path.join(serverPath, ASSETS_NAME),
      ...(await snapshotEntries(dir, '.zip')),
    ];
    const aotLinks = [path.join(serverPath, AOT_NAME), ...(await snapshotEntries(dir, '.aot'))];
    await replaceFiles([
      ...(snapAssets
        ? [
            {
              src: snapAssets,
              dest: path.join(serverPath, ASSETS_NAME),
              allowLink: true,
              knownLinks: assetLinks,
              ...inServer,
            },
          ]
        : []),
      ...(snapAot
        ? [
            {
              src: snapAot,
              dest: path.join(serverPath, AOT_NAME),
              allowLink: true,
              knownLinks: aotLinks,
              ...inServer,
            },
          ]
        : []),
      { src: snapJar, dest: path.join(serverPath, SERVER_JAR_NAME), ...inServer },
    ]);
    const restored = await readHytaleJarVersion(path.join(serverPath, SERVER_JAR_NAME));
    await writeVersionFile(
      serverPath,
      restored?.version ?? snap.version,
      restored?.patchline ?? null,
    );
    return {
      success: true,
      restoredVersion: restored?.version ?? snap.version,
      restoredAssets: !!snapAssets,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Rollback failed' };
  }
}

/**
 * Restores the previous version kept in updater/backup: JAR, AOT cache,
 * Licenses and Assets.zip. Config files in the backup are left alone. The
 * server must be stopped (withServerStopped).
 */
export async function rollbackToNativeBackup(serverId?: string): Promise<RollbackResult> {
  const paths = await resolveInstallPaths(serverId);
  const backup = await getNativeBackup(paths.updaterPath);
  if (!paths.updaterPath || !backup) {
    return { success: false, error: 'No previous version in updater/backup' };
  }
  const src = path.join(paths.updaterPath, 'backup');
  // The updater is a different mount than the server dir: everything is copied.
  const disk = await checkDiskSpace([
    { purpose: 'rollback', dir: paths.serverPath, bytes: backup.assetsBytes + backup.jarBytes },
  ]);
  if (disk.checked && !disk.sufficient) {
    return { success: false, error: 'Not enough free disk space to restore the previous version' };
  }
  const fromUpdater = { srcRoot: paths.updaterPath, destRoot: paths.serverPath };
  try {
    await snapshotBeforeRollback(serverId);
    const licenses = path.join(src, 'Server', 'Licenses');
    await replaceFiles([
      ...(backup.hasAssets
        ? [
            {
              src: path.join(src, ASSETS_NAME),
              dest: path.join(paths.serverPath, ASSETS_NAME),
              ...fromUpdater,
            },
          ]
        : []),
      ...(backup.aotBytes > 0
        ? [
            {
              src: path.join(src, 'Server', AOT_NAME),
              dest: path.join(paths.serverPath, AOT_NAME),
              ...fromUpdater,
            },
          ]
        : []),
      ...((await exists(licenses))
        ? [
            {
              src: licenses,
              dest: path.join(paths.serverPath, 'Licenses'),
              dir: true,
              ...fromUpdater,
            },
          ]
        : []),
      {
        src: path.join(src, 'Server', SERVER_JAR_NAME),
        dest: path.join(paths.serverPath, SERVER_JAR_NAME),
        ...fromUpdater,
      },
    ]);
    await writeVersionFile(paths.serverPath, backup.version, backup.patchline);
    return { success: true, restoredVersion: backup.version, restoredAssets: backup.hasAssets };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Rollback failed' };
  }
}
