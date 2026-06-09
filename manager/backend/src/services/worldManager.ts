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
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';
import { getServer, getDefaultId } from './servers.js';
import { getWorldsPaths } from './managementHelpers.js';
import * as dockerService from './docker.js';
import { logger } from '../utils/logger.js';
import { publish } from './eventBus.js';

const execFileAsync = promisify(execFile);

const WORLD_BACKUP_PREFIX = 'world_';

export interface WorldBackup {
  id: string;          // the tar.gz filename
  world: string;       // world name parsed from the filename
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
  try {
    const id = serverId ?? (await getDefaultId());
    const s = await getServer(id);
    if (s) return { backups: s.paths.backups, serverPath: s.paths.server };
  } catch { /* registry not ready */ }
  return { backups: config.backupsPath, serverPath: config.serverPath };
}

/**
 * Find a world directory by name across the known world roots. Returns the
 * absolute path + its parent (the worlds dir) or null if not found. The name
 * is matched against real directory entries, so traversal/encoded names can't
 * escape — we never build a path from raw user input.
 */
async function findWorldDir(worldName: string): Promise<{ worldPath: string; parentDir: string } | null> {
  for (const worldsPath of getWorldsPaths()) {
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
    } catch { /* skip */ }
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
  } catch { /* no config or unreadable */ }
  return null;
}

export async function getWorldDetails(worldName: string, _serverId?: string): Promise<WorldDetails | null> {
  const found = await findWorldDir(worldName);
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

function safeBackupId(id: string): boolean {
  // Only our own generated world backup filenames.
  return /^world_[A-Za-z0-9_.\- ]+_\d{8}-\d{6}\.tar\.gz$/.test(id);
}

export async function backupWorld(worldName: string, serverId?: string): Promise<{ success: boolean; backup?: WorldBackup; error?: string }> {
  const found = await findWorldDir(worldName);
  if (!found) return { success: false, error: 'World not found' };

  const { backups } = await resolvePaths(serverId);
  fs.mkdirSync(backups, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15); // YYYYMMDD-HHMMSS
  // Keep the world name readable but strip characters that don't belong in our id pattern.
  const safeName = worldName.replace(/[^A-Za-z0-9_.\- ]/g, '_');
  const filename = `${WORLD_BACKUP_PREFIX}${safeName}_${ts}.tar.gz`;
  const outFile = path.join(backups, filename);

  try {
    // No shell: tar gets an argv array. -C parent + the directory name means the
    // archive contains the world folder itself (restore recreates it by name).
    await execFileAsync('tar', ['-czf', outFile, '-C', found.parentDir, path.basename(found.worldPath)], {
      maxBuffer: 1024 * 1024 * 10,
    });
    const size = fs.statSync(outFile).size;
    publish('backup.completed', { name: filename, world: worldName, sizeMb: Math.round(size / 1024 / 1024) }, serverId);
    return {
      success: true,
      backup: { id: filename, world: worldName, createdAt: new Date().toISOString(), sizeBytes: size },
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
      // world_<name>_<YYYYMMDD-HHMMSS>.tar.gz → recover <name>
      const middle = name.slice(WORLD_BACKUP_PREFIX.length, -'.tar.gz'.length);
      const world = middle.replace(/_\d{8}-\d{6}$/, '');
      result.push({ id: name, world, createdAt: st.mtime.toISOString(), sizeBytes: st.size });
    } catch { /* skip */ }
  }
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return result;
}

export async function restoreWorld(backupId: string, serverId?: string): Promise<{ success: boolean; error?: string }> {
  if (!safeBackupId(backupId)) return { success: false, error: 'Invalid backup id' };
  const { backups } = await resolvePaths(serverId);
  const file = path.join(backups, backupId);
  if (!fs.existsSync(file)) return { success: false, error: 'Backup not found' };

  // Restore into the primary worlds dir (first existing root, else the default).
  const roots = getWorldsPaths();
  const target = roots.find(r => fs.existsSync(r)) ?? roots[0];
  fs.mkdirSync(target, { recursive: true });

  try {
    await execFileAsync('tar', ['-xzf', file, '-C', target], { maxBuffer: 1024 * 1024 * 10 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'World restore failed' };
  }
}

export async function deleteWorldBackup(backupId: string, serverId?: string): Promise<{ success: boolean; error?: string }> {
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
 * The archive is expected to contain a single top-level world folder. The
 * caller has already written the upload to `archivePath` (a temp file).
 */
export async function importWorldArchive(archivePath: string, originalName: string, _serverId?: string): Promise<{ success: boolean; error?: string }> {
  const roots = getWorldsPaths();
  const target = roots.find(r => fs.existsSync(r)) ?? roots[0];
  fs.mkdirSync(target, { recursive: true });

  const lower = originalName.toLowerCase();
  try {
    if (lower.endsWith('.zip')) {
      await execFileAsync('unzip', ['-o', archivePath, '-d', target], { maxBuffer: 1024 * 1024 * 10 });
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', target], { maxBuffer: 1024 * 1024 * 10 });
    } else {
      return { success: false, error: 'Unsupported archive type (use .zip, .tar.gz or .tgz)' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'World import failed' };
  } finally {
    fs.rmSync(archivePath, { force: true });
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

function jobKey(serverId?: string): string {
  return serverId ?? '__default__';
}

function publicStatus(job: PregenJob | undefined): PregenStatus {
  if (!job) {
    return { state: 'idle', world: null, radius: null, percent: 0, chunksDone: null, chunksTotal: null, startedAt: null };
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
      job.percent = job.chunksTotal > 0 ? Math.min(100, Math.round((job.chunksDone / job.chunksTotal) * 100)) : job.percent;
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
  if (/unknown command|not recognized|no such command/i.test(output) ||
      (!job.firstProgressSeen && Date.now() - job.startMs > PREGEN_GRACE_MS)) {
    job.state = 'unsupported';
    job.message = 'The server did not report pre-generation progress. This server build may not support /pregen yet.';
    stopPolling(job);
  }
}

export async function startPregen(world: string, radius: number, serverId?: string): Promise<{ success: boolean; error?: string }> {
  const key = jobKey(serverId);
  const existing = pregenByServer.get(key);
  if (existing && existing.state === 'running') {
    return { success: false, error: 'A pre-generation job is already running for this server' };
  }

  const found = await findWorldDir(world);
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
      return { success: false, error: (res as { error?: string }).error || 'Server rejected the pre-generation command' };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to start pre-generation' };
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
  job.poll = setInterval(() => { void pollPregen(serverId, job); }, PREGEN_POLL_MS);
  job.poll.unref?.();
  pregenByServer.set(key, job);
  logger.info(`[Pregen:${key}] started for world "${world}" radius ${job.radius}`);
  return { success: true };
}

export async function cancelPregen(serverId?: string): Promise<{ success: boolean; error?: string }> {
  const job = pregenByServer.get(jobKey(serverId));
  if (!job || job.state !== 'running') return { success: false, error: 'No pre-generation job running' };
  try {
    await dockerService.execCommand(PREGEN_STOP, serverId);
  } catch { /* best-effort */ }
  job.state = 'cancelled';
  stopPolling(job);
  return { success: true };
}
