/**
 * The game server's own (native) backups.
 *
 * Hytale 0.7 writes a consistent zip of the universe on `/backup`: it flushes
 * the universe resources, holds chunk saving and waits for pending saves
 * before it packs. The container starts the server with
 * `--backup-dir /opt/hytale/backups/native`, so the zips land on the shared
 * backups volume:
 *
 *   <backups>/native/<yyyy-MM-dd_HH-mm-ss>.zip      newest (server keeps --backup-max-count)
 *   <backups>/native/archive/<...>.zip              one per 12 h moved aside (--backup-archive-max-count)
 *   <backups>/native/<name>.zip.tmp                 being written
 *
 * The panel lists, downloads, deletes and restores these files; retention is
 * left to the server's own flags.
 */
import fs from 'fs';
import path from 'path';
import { resolveBackupPaths, runBackupHookAsync } from './backupCommon.js';
import { uploadBackupAsync } from './offsiteBackup.js';
import { publish } from './eventBus.js';
import { resolveRealPath } from '../utils/pathSecurity.js';
import * as dockerService from './docker.js';
import { waitForConsoleLine } from './serverConsoleOutput.js';

export type NativeBackupScope = 'recent' | 'archive';

export interface NativeBackupInfo {
  name: string;
  scope: NativeBackupScope;
  size_bytes: number;
  size_mb: number;
  created_at: string;
}

export interface NativeBackupList {
  directory: string;
  available: boolean; // the directory exists (the server was started with --backup-dir)
  inProgress: boolean; // a .zip.tmp is being written
  backups: NativeBackupInfo[];
}

const NATIVE_SUBDIR = 'native';
const ARCHIVE_SUBDIR = 'archive';
const NATIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.zip$/;
const NATIVE_BACKUP_TIMEOUT_MS = 60 * 60 * 1000;
const NATIVE_POLL_MS = 2000;

// Replies of Hytale 0.7's /backup (English server language).
const NOT_CONFIGURED = /must be started with --backup-dir/i;
const STILL_BOOTING = /still booting up/i;
const BACKUP_ERROR = /error has occurred while creating a backup|Backup failed/i;
const BACKUP_COMPLETE = /Backup completed!|Successfully created backup/i;

export function isNativeBackupScope(value: unknown): value is NativeBackupScope {
  return value === 'recent' || value === 'archive';
}

export function isValidNativeBackupName(name: unknown): name is string {
  return typeof name === 'string' && NATIVE_NAME.test(name) && !name.includes('..');
}

export async function nativeBackupDir(serverId?: string): Promise<string> {
  return path.join((await resolveBackupPaths(serverId)).backups, NATIVE_SUBDIR);
}

function scopeDir(nativeDir: string, scope: NativeBackupScope): string {
  return scope === 'archive' ? path.join(nativeDir, ARCHIVE_SUBDIR) : nativeDir;
}

function readZips(dir: string, scope: NativeBackupScope): NativeBackupInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const result: NativeBackupInfo[] = [];
  for (const name of names) {
    if (!isValidNativeBackupName(name)) continue;
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (!st.isFile()) continue;
      result.push({
        name,
        scope,
        size_bytes: st.size,
        size_mb: Math.round((st.size / (1024 * 1024)) * 100) / 100,
        created_at: st.mtime.toISOString(),
      });
    } catch {
      /* vanished while listing (rotated by the server) */
    }
  }
  return result;
}

export async function listNativeBackups(serverId?: string): Promise<NativeBackupList> {
  const directory = await nativeBackupDir(serverId);
  const available = fs.existsSync(directory);
  let inProgress = false;
  try {
    inProgress = fs.readdirSync(directory).some((n) => n.endsWith('.zip.tmp'));
  } catch {
    /* not there yet */
  }
  const backups = [
    ...readZips(directory, 'recent'),
    ...readZips(path.join(directory, ARCHIVE_SUBDIR), 'archive'),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { directory, available, inProgress, backups };
}

/**
 * Absolute path of a native backup, or null if the name is invalid, the file
 * does not exist or it resolves outside the native backup directory.
 */
export async function getNativeBackupPath(
  scope: unknown,
  name: unknown,
  serverId?: string,
): Promise<string | null> {
  if (!isNativeBackupScope(scope) || !isValidNativeBackupName(name)) return null;
  const backupsDir = (await resolveBackupPaths(serverId)).backups;
  const file = path.join(scopeDir(path.join(backupsDir, NATIVE_SUBDIR), scope), name);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  // Anchored at the backups folder, not at `native`: the game server creates
  // `native` (and `archive`), and a link there must not move the root along.
  const realBackups = resolveRealPath(backupsDir);
  return realBackups &&
    resolveRealPath(file) === path.join(realBackups, path.relative(backupsDir, file))
    ? file
    : null;
}

export async function deleteNativeBackup(
  scope: unknown,
  name: unknown,
  serverId?: string,
): Promise<{ success: boolean; error?: string }> {
  const file = await getNativeBackupPath(scope, name, serverId);
  if (!file) return { success: false, error: 'Native backup not found' };
  try {
    fs.unlinkSync(file);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Delete failed' };
  }
}

function newestNewZip(dir: string, known: Set<string>): NativeBackupInfo | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  if (entries.some((n) => n.endsWith('.zip.tmp'))) return null; // still writing
  const fresh = readZips(dir, 'recent').filter((b) => !known.has(b.name));
  fresh.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return fresh[0] ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the running server for a native backup and wait until the new zip is
 * complete. Throws with a user-facing message when the server refuses (not
 * started with --backup-dir, still booting) or reports an error.
 */
export async function createNativeBackup(
  serverId?: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<NativeBackupInfo> {
  const status = await dockerService.getStatus(serverId);
  if (!status.running) {
    throw new Error(
      'The server must be running for a native backup (the server writes it itself). ' +
        'Start it, or create a panel backup instead.',
    );
  }
  const dir = await nativeBackupDir(serverId);
  const known = new Set(readZips(dir, 'recent').map((b) => b.name));
  const since = Date.now();
  const timeoutMs = options.timeoutMs ?? NATIVE_BACKUP_TIMEOUT_MS;
  const pollMs = options.pollMs ?? NATIVE_POLL_MS;

  publish('backup.started', { name: 'native', native: true }, serverId);
  const fail = (error: string): never => {
    publish('backup.failed', { name: 'native', native: true, error }, serverId);
    throw new Error(error);
  };

  const sent = await dockerService.execCommand('/backup', serverId);
  if (!sent.success) fail(sent.error || 'The server did not accept /backup');

  const deadline = since + timeoutMs;
  let reportedComplete = false;
  while (Date.now() < deadline) {
    const created = newestNewZip(dir, known);
    if (created) {
      const file = path.join(dir, created.name);
      runBackupHookAsync(file);
      uploadBackupAsync(file);
      publish(
        'backup.completed',
        { name: created.name, file, sizeMb: created.size_mb, native: true },
        serverId,
      );
      return created;
    }
    const reply = await waitForConsoleLine(
      since,
      { success: [BACKUP_COMPLETE], failure: [NOT_CONFIGURED, STILL_BOOTING, BACKUP_ERROR] },
      { timeoutMs: 0, serverId },
    );
    if (reply.outcome === 'failed') {
      if (NOT_CONFIGURED.test(reply.line)) {
        fail(
          'Native backups are not configured: the server was not started with --backup-dir. ' +
            'Update the container (the panel sets it) and restart the server.',
        );
      }
      if (STILL_BOOTING.test(reply.line)) fail('The server is still starting; try again shortly.');
      fail(`The server reported a backup error: ${reply.line}`);
    }
    if (reply.outcome === 'matched') {
      if (reportedComplete) {
        // Complete for a full poll interval but no new file here: the server
        // writes its backups to another directory.
        fail(
          `The server finished a backup, but no new file appeared in ${dir}. ` +
            'Check the --backup-dir the server was started with.',
        );
      }
      reportedComplete = true;
    }
    await sleep(pollMs);
  }
  return fail('Timed out waiting for the native backup to finish.');
}
