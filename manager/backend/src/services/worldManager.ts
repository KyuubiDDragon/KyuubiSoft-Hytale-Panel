/**
 * Per-world management: individual world backup / restore / upload / delete,
 * seed lookup, and chunk pregeneration.
 *
 * These complement the whole-server backup system (services/backup.ts) with
 * world-granular operations operators actually ask for: snapshot just one
 * world before an experiment, ship a world between servers, or pre-generate
 * terrain so players don't lag the server generating chunks on first visit.
 *
 * tar is invoked via execFile with an argv array (NO shell), so world names
 * and paths can never be interpreted as shell — there's no quoting to get
 * wrong. World names are additionally validated against the real on-disk
 * world list, so only an existing directory inside a known worlds root can be
 * targeted (no traversal).
 *
 * Imports and restores are validated by the archive safety layer: archives
 * containing links, special files, absolute paths or ".." are refused before
 * anything is written, the unpacked size is capped (ARCHIVE_EXTRACT_MAX_GB),
 * and extraction happens in a staging directory next to the worlds dir.
 * An import only adds new world folders (the server may keep running); a
 * restore replaces one world folder while the server is stopped.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveServerIdSync } from './servers.js';
import { getServerContext, worldRoots } from './serverContext.js';
import * as dockerService from './docker.js';
import { logger } from '../utils/logger.js';
import {
  ArchiveRejectedError,
  archiveFormatFromName,
  extractToStaging,
  inspectArchive,
  type ArchiveFormat,
} from '../utils/archiveSafety.js';
import { resolveRealPath, resolveRealPathWithin } from '../utils/pathSecurity.js';
import { removeTree } from '../utils/noFollowFs.js';
import { publish } from './eventBus.js';
import {
  EXTRACT_RESERVE_BYTES,
  archiveExtractMaxBytes,
  freeTimestampedPath,
} from './backupCommon.js';
import { flushWorldsIfRunning, withBackupLock } from './backup.js';
import {
  runningBackupJob,
  startBackupJob,
  waitForBackupJob,
  type BackupJob,
} from './backupJobs.js';
import { withServerStopped } from './serverLifecycle.js';

const execFileAsync = promisify(execFile);

const WORLD_BACKUP_PREFIX = 'world_';
// Staging next to the worlds dir (same filesystem, inside the data dir, and
// excluded from panel backups by its .kp-extract- prefix).
const WORLD_STAGING_PREFIX = '.kp-extract-world-';

// A worlds dir that was replaced by a link elsewhere (e.g. into the panel's
// own data) must not receive an import: the real target has to stay inside
// the game data or server directory of the server the import is for.
async function worldExtractRoots(serverId?: string): Promise<string[]> {
  const { paths } = await getServerContext(serverId);
  return [paths.data, paths.server];
}

export interface WorldBackup {
  id: string; // the tar.gz filename
  world: string; // world name parsed from the filename
  createdAt: string;
  sizeBytes: number;
}

export interface WorldDetails {
  name: string;
  path: string;
  seed: string | null;
  sizeBytes: number;
  fileCount: number;
}

async function resolvePaths(serverId?: string): Promise<{ backups: string; serverPath: string }> {
  const { paths } = await getServerContext(serverId);
  return { backups: paths.backups, serverPath: paths.server };
}

/**
 * Find a world directory by name across the server's world roots. Returns the
 * absolute path + its parent (the worlds dir) or null if not found. The name
 * is matched against real directory entries, so traversal/encoded names can't
 * escape — we never build a path from raw user input.
 */
async function findWorldDir(
  worldName: string,
  serverId: string | undefined,
): Promise<{ worldPath: string; parentDir: string } | null> {
  for (const worldsPath of worldRoots(await getServerContext(serverId))) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(worldsPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === worldName) {
        return { worldPath: path.join(worldsPath, entry.name), parentDir: worldsPath };
      }
    }
  }
  return null;
}

function dirSizeSync(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const sub = dirSizeSync(full);
        bytes += sub.bytes;
        files += sub.files;
      } else if (entry.isFile()) {
        bytes += fs.statSync(full).size;
        files += 1;
      }
    } catch {
      /* skip */
    }
  }
  return { bytes, files };
}

function readSeed(worldPath: string): string | null {
  // The seed lives in the world's config.json. Field name varies by build, so
  // probe the common spellings.
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(worldPath, 'config.json'), 'utf-8'));
    for (const key of ['Seed', 'seed', 'WorldSeed', 'worldSeed', 'levelSeed']) {
      if (cfg[key] !== undefined && cfg[key] !== null && `${cfg[key]}` !== '') {
        return `${cfg[key]}`;
      }
    }
    if (cfg.Defaults && cfg.Defaults.Seed !== undefined) return `${cfg.Defaults.Seed}`;
  } catch {
    /* no config or unreadable */
  }
  return null;
}

export async function getWorldDetails(
  worldName: string,
  serverId?: string,
): Promise<WorldDetails | null> {
  const found = await findWorldDir(worldName, serverId);
  if (!found) return null;
  const { bytes, files } = dirSizeSync(found.worldPath);
  return {
    name: worldName,
    path: found.worldPath,
    seed: readSeed(found.worldPath),
    sizeBytes: bytes,
    fileCount: files,
  };
}

// ---------- backup / restore ----------

// _YYYYMMDD-HHMMSS, or _YYYY-MM-DD-HHMM: what earlier versions actually wrote
// (their timestamp kept the date dashes and cut the seconds off).
const WORLD_BACKUP_TS = String.raw`_(?:\d{8}-\d{6}|\d{4}-\d{2}-\d{2}-\d{4})`;
const WORLD_BACKUP_ID = new RegExp(
  `^${WORLD_BACKUP_PREFIX}[A-Za-z0-9_.\\- ]+${WORLD_BACKUP_TS}\\.tar\\.gz$`,
);
const WORLD_BACKUP_SUFFIX = new RegExp(`${WORLD_BACKUP_TS}(?:\\.tar\\.gz)?$`);

function safeBackupId(id: string): boolean {
  // Only our own generated world backup filenames.
  return WORLD_BACKUP_ID.test(id);
}

/** world_<name>_<timestamp>.tar.gz → <name> */
function worldNameOf(backupId: string): string {
  return backupId.slice(WORLD_BACKUP_PREFIX.length).replace(WORLD_BACKUP_SUFFIX, '');
}

export async function backupWorld(
  worldName: string,
  serverId?: string,
): Promise<{ success: boolean; backup?: WorldBackup; error?: string }> {
  const found = await findWorldDir(worldName, serverId);
  if (!found) return { success: false, error: 'World not found' };

  const { backups } = await resolvePaths(serverId);
  fs.mkdirSync(backups, { recursive: true });

  // YYYYMMDD-HHMMSS (the date dashes must go too, or the id check rejects the backup)
  const tsAt = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  // Keep the world name readable but strip characters that don't belong in our id pattern.
  const safeName = worldName.replace(/[^A-Za-z0-9_.\- ]/g, '_');
  // Never overwrite a backup from the same second (e.g. a restore's safety copy).
  const outFile = freeTimestampedPath((at) =>
    path.join(backups, `${WORLD_BACKUP_PREFIX}${safeName}_${tsAt(at)}.tar.gz`),
  );
  const filename = path.basename(outFile);

  try {
    // A running server writes the world to disk first; a stopped one needs nothing.
    const flush = await flushWorldsIfRunning(serverId);
    if (flush.note) logger.warn(`[Worlds] backup of "${worldName}": ${flush.note}`);
    // No shell: tar gets an argv array. -C parent + the directory name means the
    // archive contains the world folder itself (restore recreates it by name).
    await execFileAsync(
      'tar',
      ['-czf', outFile, '-C', found.parentDir, path.basename(found.worldPath)],
      {
        maxBuffer: 1024 * 1024 * 10,
      },
    );
    const size = fs.statSync(outFile).size;
    publish(
      'backup.completed',
      { name: filename, world: worldName, sizeMb: Math.round(size / 1024 / 1024) },
      serverId,
    );
    return {
      success: true,
      backup: {
        id: filename,
        world: worldName,
        createdAt: new Date().toISOString(),
        sizeBytes: size,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'World backup failed' };
  }
}

export async function listWorldBackups(serverId?: string): Promise<WorldBackup[]> {
  const { backups } = await resolvePaths(serverId);
  let entries: string[];
  try {
    entries = fs.readdirSync(backups);
  } catch {
    return [];
  }
  const result: WorldBackup[] = [];
  for (const name of entries) {
    if (!name.startsWith(WORLD_BACKUP_PREFIX) || !name.endsWith('.tar.gz')) continue;
    try {
      const st = fs.statSync(path.join(backups, name));
      result.push({
        id: name,
        world: worldNameOf(name),
        createdAt: st.mtime.toISOString(),
        sizeBytes: st.size,
      });
    } catch {
      /* skip */
    }
  }
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return result;
}

/** The server's primary worlds dir (first existing root, else the default). */
async function primaryWorldsDir(serverId: string | undefined): Promise<string> {
  const roots = worldRoots(await getServerContext(serverId));
  return roots.find((r) => fs.existsSync(r)) ?? roots[0];
}

interface StagedWorlds {
  staging: string;
  worldsDir: string; // real path
  folders: string[];
}

/**
 * Validate and unpack a world archive into a fresh staging dir next to the
 * worlds dir. Only folders are allowed at the top level of the archive. The
 * caller moves the folders on and removes `staging`.
 */
async function stageWorldArchive(
  archive: string,
  format: ArchiveFormat,
  serverId: string | undefined,
): Promise<StagedWorlds> {
  const limits = { maxBytes: archiveExtractMaxBytes(), reserveBytes: EXTRACT_RESERVE_BYTES };
  const declared = await inspectArchive(archive, format, limits);
  const target = await primaryWorldsDir(serverId);
  await fs.promises.mkdir(target, { recursive: true });
  // A worlds dir that was replaced by a link elsewhere is refused.
  const worldsDir = resolveRealPath(target);
  if (!worldsDir || !resolveRealPathWithin(worldsDir, await worldExtractRoots(serverId))) {
    throw new Error(`Refusing to extract: ${target} resolves outside the allowed directories.`);
  }
  const staging = await fs.promises.mkdtemp(
    path.join(path.dirname(worldsDir), WORLD_STAGING_PREFIX),
  );
  try {
    await extractToStaging(archive, format, staging, limits, declared);
    const entries = await fs.promises.readdir(staging, { withFileTypes: true });
    const loose = entries.find((e) => !e.isDirectory());
    if (loose) {
      throw new ArchiveRejectedError(
        `A world archive may only contain world folders; "${loose.name}" is a file.`,
      );
    }
    return { staging, worldsDir, folders: entries.map((e) => e.name) };
  } catch (err) {
    await removeTree(staging, [path.dirname(worldsDir)]).catch(() => undefined);
    throw err;
  }
}

/** Replace `worldsDir/name` with `staging/name`; rolls back on failure. */
async function swapWorldFolder(staged: StagedWorlds, name: string): Promise<void> {
  const live = path.join(staged.worldsDir, name);
  const aside = path.join(staged.staging, `.previous-${name}`);
  const hadLive = fs.existsSync(live);
  if (hadLive) await fs.promises.rename(live, aside);
  try {
    await fs.promises.rename(path.join(staged.staging, name), live);
  } catch (err) {
    if (hadLive && !fs.existsSync(live)) await fs.promises.rename(aside, live);
    throw err;
  }
}

async function performWorldRestore(
  file: string,
  worldName: string,
  serverId: string | undefined,
  actor: string | undefined,
  setStep: (step: string) => void,
): Promise<{ message?: string; error?: string }> {
  setStep('extracting');
  let staged: StagedWorlds;
  try {
    staged = await stageWorldArchive(file, 'tar.gz', serverId);
  } catch (err) {
    return { error: `${err instanceof Error ? err.message : err} No world was changed.` };
  }
  try {
    if (staged.folders.length !== 1) {
      return {
        error: 'A world backup must contain exactly one world folder. No world was changed.',
      };
    }
    const [folder] = staged.folders;
    let safety = '';
    setStep('stopping-server');
    // Lifecycle lock first, then the backup lock (see services/backup.ts).
    await withServerStopped(serverId, { reason: 'restore', actor: actor ?? 'world-restore' }, () =>
      withBackupLock(async () => {
        if (fs.existsSync(path.join(staged.worldsDir, folder))) {
          setStep('safety-backup');
          const copy = await backupWorld(folder, serverId);
          if (!copy.success) throw new Error(`safety backup failed: ${copy.error}`);
          safety = copy.backup?.id ?? '';
        }
        setStep('swapping');
        await swapWorldFolder(staged, folder);
        setStep('starting-server');
      }),
    );
    logger.info(`[Worlds] restored "${folder}" from ${path.basename(file)} (${worldName})`);
    return {
      message: safety
        ? `World "${folder}" restored. The previous state was saved as ${safety}.`
        : `World "${folder}" restored.`,
    };
  } catch (err) {
    return { error: `World restore failed: ${err instanceof Error ? err.message : err}` };
  } finally {
    await removeTree(staged.staging, [path.dirname(staged.worldsDir)]).catch(() => undefined);
  }
}

/**
 * Restore a per-world backup as a background job: unpack while the server
 * runs, then stop it, keep a backup of the current world, replace the world
 * folder and start the server again.
 */
export async function startWorldRestore(
  backupId: string,
  serverId?: string,
  actor?: string,
): Promise<{ ok: true; job: BackupJob } | { ok: false; status: 400 | 404 | 409; error: string }> {
  if (!safeBackupId(backupId)) return { ok: false, status: 400, error: 'Invalid backup id' };
  const { backups } = await resolvePaths(serverId);
  const file = path.join(backups, backupId);
  if (!fs.existsSync(file)) return { ok: false, status: 404, error: 'Backup not found' };
  const running = runningBackupJob();
  if (running) {
    return { ok: false, status: 409, error: `Another backup job is running (${running.type})` };
  }
  const worldName = worldNameOf(backupId);
  const job = startBackupJob(
    { type: 'world-restore', serverId, target: backupId, startedBy: actor },
    (control) => performWorldRestore(file, worldName, serverId, actor, control.setStep),
  );
  return { ok: true, job };
}

/** World restore that waits for the job (for callers that want one call). */
export async function restoreWorld(
  backupId: string,
  serverId?: string,
  actor?: string,
): Promise<{ success: boolean; error?: string; message?: string }> {
  const started = await startWorldRestore(backupId, serverId, actor);
  if (!started.ok) return { success: false, error: started.error };
  const finished = await waitForBackupJob(started.job.id)!;
  return finished.state === 'succeeded'
    ? { success: true, message: finished.message ?? undefined }
    : { success: false, error: finished.error ?? 'World restore failed' };
}

export async function deleteWorldBackup(
  backupId: string,
  serverId?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!safeBackupId(backupId)) return { success: false, error: 'Invalid backup id' };
  const { backups } = await resolvePaths(serverId);
  const file = path.join(backups, backupId);
  try {
    fs.rmSync(file, { force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Delete failed' };
  }
}

/**
 * Extract an uploaded world archive (.tar.gz/.tgz/.zip) into the worlds dir.
 * The archive must contain world folders only, and none of them may exist
 * yet: an import never writes into a world the server may have loaded (use a
 * world backup to roll one back). The caller has already written the upload
 * to `archivePath` (a temp file).
 */
export async function importWorldArchive(
  archivePath: string,
  originalName: string,
  serverId?: string,
): Promise<{ success: boolean; error?: string }> {
  const format = archiveFormatFromName(originalName);
  let staged: StagedWorlds | null = null;
  try {
    if (!format) {
      return { success: false, error: 'Unsupported archive type (use .zip, .tar.gz or .tgz)' };
    }
    // A restore may have moved the worlds dir aside right now.
    const running = runningBackupJob();
    if (running) {
      return {
        success: false,
        error: `A backup job is running (${running.type}); try again later.`,
      };
    }
    const prepared = await stageWorldArchive(archivePath, format, serverId);
    staged = prepared;
    // Under the backup lock, so no restore swaps the data dir in between.
    return await withBackupLock(async () => {
      const existing = prepared.folders.find((f) =>
        fs.existsSync(path.join(prepared.worldsDir, f)),
      );
      if (existing) {
        return {
          success: false,
          error: `A world named "${existing}" already exists. Delete or rename it first.`,
        };
      }
      const moved: string[] = [];
      try {
        for (const folder of prepared.folders) {
          await fs.promises.rename(
            path.join(prepared.staging, folder),
            path.join(prepared.worldsDir, folder),
          );
          moved.push(folder);
        }
      } catch (err) {
        // All or nothing: take back what was already moved in.
        for (const folder of moved) {
          await fs.promises
            .rename(path.join(prepared.worldsDir, folder), path.join(prepared.staging, folder))
            .catch(() => undefined);
        }
        throw err;
      }
      return { success: true };
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'World import failed' };
  } finally {
    fs.rmSync(archivePath, { force: true });
    if (staged)
      await removeTree(staged.staging, [path.dirname(staged.worldsDir)]).catch(() => undefined);
  }
}

// ============================================================
// Chunk pre-generation
// ============================================================
//
// PREGEN COMMANDS ARE ASSUMED — adjust the command strings + the status-parse
// regex below once the Hytale server finalizes its pre-generation command set.
// The manager is built to degrade gracefully: if the server doesn't understand
// the command (no parseable progress within the grace window) the job is marked
// 'unsupported' with a clear message rather than hanging.
//
// Assumed protocol:
//   start:  /pregen start <world> <radius>
//   status: /pregen status   → "Pregen: 42% (1234/2950 chunks)"
//   cancel: /pregen stop
const PREGEN_START = (world: string, radius: number) => `/pregen start ${world} ${radius}`;
const PREGEN_STATUS = '/pregen status';
const PREGEN_STOP = '/pregen stop';
const PREGEN_PROGRESS_RE = /(\d+(?:\.\d+)?)\s*%|\b(\d+)\s*\/\s*(\d+)\b\s*chunks?/i;
const PREGEN_POLL_MS = 4000;
const PREGEN_GRACE_MS = 20000; // time to see *some* parseable progress before declaring unsupported

export type PregenState = 'idle' | 'running' | 'complete' | 'cancelled' | 'error' | 'unsupported';

export interface PregenStatus {
  state: PregenState;
  world: string | null;
  radius: number | null;
  percent: number;
  chunksDone: number | null;
  chunksTotal: number | null;
  startedAt: string | null;
  message?: string;
}

interface PregenJob extends PregenStatus {
  poll: NodeJS.Timeout | null;
  firstProgressSeen: boolean;
  startMs: number;
}

const pregenByServer = new Map<string, PregenJob>();

// Legacy and scoped calls for the same server share one job.
function jobKey(serverId?: string): string {
  return resolveServerIdSync(serverId);
}

function publicStatus(job: PregenJob | undefined): PregenStatus {
  if (!job) {
    return {
      state: 'idle',
      world: null,
      radius: null,
      percent: 0,
      chunksDone: null,
      chunksTotal: null,
      startedAt: null,
    };
  }
  // Strip the internal bookkeeping fields, returning only the public status.
  const { poll: _poll, firstProgressSeen: _fps, startMs: _startMs, ...rest } = job;
  return rest;
}

export function getPregenStatus(serverId?: string): PregenStatus {
  return publicStatus(pregenByServer.get(jobKey(serverId)));
}

function stopPolling(job: PregenJob): void {
  if (job.poll) {
    clearInterval(job.poll);
    job.poll = null;
  }
}

async function pollPregen(serverId: string | undefined, job: PregenJob): Promise<void> {
  let output = '';
  try {
    const res = await dockerService.execCommand(PREGEN_STATUS, serverId);
    output = (res as { message?: string }).message ?? '';
  } catch {
    return; // transient — try next tick
  }

  const m = output.match(PREGEN_PROGRESS_RE);
  if (m) {
    job.firstProgressSeen = true;
    if (m[1]) {
      job.percent = Math.min(100, Math.round(parseFloat(m[1])));
    } else if (m[2] && m[3]) {
      job.chunksDone = parseInt(m[2], 10);
      job.chunksTotal = parseInt(m[3], 10);
      job.percent =
        job.chunksTotal > 0
          ? Math.min(100, Math.round((job.chunksDone / job.chunksTotal) * 100))
          : job.percent;
    }
    if (job.percent >= 100) {
      job.state = 'complete';
      stopPolling(job);
      publish('server.alert', { reason: 'pregen_complete', world: job.world }, serverId);
    }
    return;
  }

  // No parseable progress. If the server reported the command is unknown, or the
  // grace window elapsed without ever seeing progress, declare it unsupported.
  if (
    /unknown command|not recognized|no such command/i.test(output) ||
    (!job.firstProgressSeen && Date.now() - job.startMs > PREGEN_GRACE_MS)
  ) {
    job.state = 'unsupported';
    job.message =
      'The server did not report pre-generation progress. This server build may not support /pregen yet.';
    stopPolling(job);
  }
}

export async function startPregen(
  world: string,
  radius: number,
  serverId?: string,
): Promise<{ success: boolean; error?: string }> {
  const key = jobKey(serverId);
  const existing = pregenByServer.get(key);
  if (existing && existing.state === 'running') {
    return { success: false, error: 'A pre-generation job is already running for this server' };
  }

  const found = await findWorldDir(world, serverId);
  if (!found) return { success: false, error: 'World not found' };
  if (!Number.isFinite(radius) || radius < 1 || radius > 256) {
    return { success: false, error: 'Radius must be between 1 and 256 chunks' };
  }

  // Issue the start command.
  let startOutput = '';
  try {
    const res = await dockerService.execCommand(PREGEN_START(world, Math.floor(radius)), serverId);
    startOutput = (res as { message?: string }).message ?? '';
    if ((res as { success?: boolean }).success === false) {
      return {
        success: false,
        error: (res as { error?: string }).error || 'Server rejected the pre-generation command',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to start pre-generation',
    };
  }

  if (/unknown command|not recognized|no such command/i.test(startOutput)) {
    return { success: false, error: 'This server build does not support the /pregen command yet.' };
  }

  const job: PregenJob = {
    state: 'running',
    world,
    radius: Math.floor(radius),
    percent: 0,
    chunksDone: null,
    chunksTotal: null,
    startedAt: new Date().toISOString(),
    poll: null,
    firstProgressSeen: false,
    startMs: Date.now(),
  };
  job.poll = setInterval(() => {
    void pollPregen(serverId, job);
  }, PREGEN_POLL_MS);
  job.poll.unref?.();
  pregenByServer.set(key, job);
  logger.info(`[Pregen:${key}] started for world "${world}" radius ${job.radius}`);
  return { success: true };
}

export async function cancelPregen(
  serverId?: string,
): Promise<{ success: boolean; error?: string }> {
  const job = pregenByServer.get(jobKey(serverId));
  if (!job || job.state !== 'running')
    return { success: false, error: 'No pre-generation job running' };
  try {
    await dockerService.execCommand(PREGEN_STOP, serverId);
  } catch {
    /* best-effort */
  }
  job.state = 'cancelled';
  stopPolling(job);
  return { success: true };
}
