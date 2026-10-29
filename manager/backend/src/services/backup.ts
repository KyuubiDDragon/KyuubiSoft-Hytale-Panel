/**
 * Panel backups: tar.gz snapshots of a server's data directory. Restores of
 * these and of the server's native zips live in services/backupRestore.ts,
 * the native backups themselves in services/nativeBackups.ts.
 *
 *  - Consistency: tar can only read what is on disk. A stopped server is
 *    archived as is; for a running one the panel first asks it to write all
 *    worlds (`/world save --all --confirm`) and waits for the confirmation.
 *    The server's native /backup additionally holds saving while it packs and
 *    is the better choice for a running server.
 *  - Every external tool runs through spawn with an argv array: no shell and
 *    no blocking of the event loop.
 *  - Naming: `manual_[<name>_]<ts>` for backups an operator asked for,
 *    `auto_<label>_<ts>` for scheduled and rule-driven ones. Only the latter
 *    are subject to retention (isAutomaticBackupId).
 */
import fs from 'fs';
import path from 'path';
import type { BackupInfo, StorageInfo, ActionResponse } from '../types/index.js';
import { isValidBackupName } from '../utils/sanitize.js';
import { isPathSafe, resolveRealPathWithin } from '../utils/pathSecurity.js';
import { config } from '../config.js';
import { listServers } from './servers.js';
import { publish } from './eventBus.js';
import { uploadBackupAsync } from './offsiteBackup.js';
import { getDb } from '../db/index.js';
import * as dockerService from './docker.js';
import { waitForConsoleLine } from './serverConsoleOutput.js';
import {
  freeBytes,
  createTarArchive,
  freeTimestampedPath,
  resolveBackupPaths,
  runBackupHookAsync,
} from './backupCommon.js';
import {
  hasInterruptedRestore,
  isInternalDataEntry,
  recoverInterruptedRestore,
} from './restoreSwap.js';
import { ensurePanelBackupDir } from './panelBackups.js';

// The manager's own data (panel.sqlite + config/users/servers JSON) lives here.
const MANAGER_DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
// How many panel self-backups to keep (see services/panelBackups.ts).
const PANEL_BACKUP_KEEP = 14;

const MANUAL_PREFIX = 'manual_';
const AUTO_PREFIX = 'auto_';
// YYYY-MM-DD_HHMMSS, or YYYY-MM-DD_HHMM for names written before seconds were added.
const TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}_\d{4}(?:\d{2})?`;
const AUTO_BACKUP_ID = new RegExp(`^${AUTO_PREFIX}[A-Za-z0-9_-]+_${TIMESTAMP}$`);
// Names the scheduler used before automatic backups got their own prefix.
const LEGACY_AUTO_LABELS: ReadonlySet<string> = new Set(['auto', 'scheduled_restart']);
const LEGACY_AUTO_BACKUP_ID = new RegExp(
  `^${MANUAL_PREFIX}(${[...LEGACY_AUTO_LABELS].join('|')})_${TIMESTAMP}$`,
);

// Hytale 0.7: `world save` requires --confirm; --all saves every loaded world.
const WORLD_SAVE_COMMAND = '/world save --all --confirm';
const WORLD_SAVE_DONE = /Finished saving all worlds/i;
const WORLD_SAVE_TIMEOUT_MS = 60_000;
// Give the region files a moment after the confirmation before tar reads them.
const WORLD_SAVE_SETTLE_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type BackupKind = 'manual' | 'auto';

export interface CreateBackupOptions {
  kind?: BackupKind;
  /** Free-form part of the name (letters, digits, `_`, `-`). */
  label?: string;
}

/**
 * YYYY-MM-DD_HHMMSS (UTC), the timestamp part of every backup name. Seconds
 * keep two backups taken within the same minute from overwriting each other.
 */
export function backupTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 17);
}

/** Name of the copy a restore takes of the state it replaces (kept until deleted by hand). */
export function safetyBackupName(ts: string): string {
  return `${MANUAL_PREFIX}pre_restore_${ts}`;
}

/**
 * True for backups the panel created automatically (scheduler, event rules,
 * scheduled restarts). Retention only ever deletes these; a manual backup
 * whose name merely contains "auto" is not one of them.
 */
export function isAutomaticBackupId(id: string): boolean {
  return AUTO_BACKUP_ID.test(id) || LEGACY_AUTO_BACKUP_ID.test(id);
}

function backupType(id: string): BackupInfo['type'] {
  // backup_* is what older server builds wrote into the backups folder.
  return isAutomaticBackupId(id) || id.startsWith('backup_') ? 'auto' : 'manual';
}

/**
 * First symbolic link below `dir` (relative path), or null. tar stores links
 * as links, and a restore refuses any archive that contains one, so the
 * operator should learn about it when the backup is made, not when it's needed.
 */
async function findSymlink(dir: string, rel = ''): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!rel && isInternalDataEntry(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return child;
    if (entry.isDirectory()) {
      const found = await findSymlink(dir, child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Archive the game data of `dataDir` into `outFile`. The panel's own working
 * directories (restore/extract staging) are left out; each top-level entry is
 * passed as "./<name>" so a name starting with "-" can't become an option.
 * Returns false when there is nothing to archive.
 */
export async function archiveDataDir(dataDir: string, outFile: string): Promise<boolean> {
  const entries = (await fs.promises.readdir(dataDir)).filter((n) => !isInternalDataEntry(n));
  if (entries.length === 0) return false;
  await createTarArchive(outFile, ['-C', dataDir, ...entries.map((n) => `./${n}`)]);
  return true;
}

// ============================================================
// Panel self-backup
// ============================================================

// Not "panel-config_" as on the backups volume before: the move of those old
// copies (panelBackups.ts) must never find a name of its own here.
const PANEL_BACKUP_PREFIX = 'panel-backup_';

function prunePanelBackups(panelDir: string): void {
  try {
    const files = fs
      .readdirSync(panelDir)
      .filter((f) => f.startsWith(PANEL_BACKUP_PREFIX) && f.endsWith('.tar.gz'))
      .map((f) => ({ f, t: fs.statSync(path.join(panelDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(PANEL_BACKUP_KEEP)) {
      fs.rmSync(path.join(panelDir, f), { force: true });
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Snapshot the panel's OWN state — a consistent online copy of panel.sqlite
 * (audit log, API keys, webhooks, punishments, …) plus the config/users/servers/
 * setup-config JSON — into `<manager data>/panel-backups/panel-backup_<ts>.tar.gz`. It holds
 * password hashes and secrets, so it stays in the manager's own volume, never
 * on the backups volume the game server can read. Against the loss of that
 * volume only the off-site upload (when configured) helps.
 */
export async function backupPanelData(): Promise<{
  success: boolean;
  file?: string;
  error?: string;
}> {
  try {
    const panelDir = await ensurePanelBackupDir();
    const ts = backupTimestamp();
    const stage = path.join(panelDir, `.stage_${ts}`);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
      // Online snapshot — safe to take while the DB is in use (WAL).
      await getDb().backup(path.join(stage, 'panel.sqlite'));
      for (const name of ['config.json', 'users.json', 'servers.json', 'setup-config.json']) {
        const src = path.join(MANAGER_DATA_DIR, name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, name));
      }
      const outFile = freeTimestampedPath((at) =>
        path.join(panelDir, `${PANEL_BACKUP_PREFIX}${backupTimestamp(at)}.tar.gz`),
      );
      await createTarArchive(outFile, ['-C', stage, '.'], 5 * 60 * 1000);
      fs.chmodSync(outFile, 0o600);
      prunePanelBackups(panelDir);
      return { success: true, file: outFile };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'panel backup failed' };
  }
}

// ============================================================
// Boot recovery
// ============================================================

/**
 * Run on boot: remove the staging dirs older panel versions left NEXT TO the
 * data dir (`_restore_temp_*`, `_restore_old_*`), and finish or roll back a
 * restore that was interrupted inside a data dir. The latter only happens
 * while the server is stopped; otherwise it waits for the next restore.
 *
 * Runs under the backup lock: a restore started right after boot swaps (and
 * recovers its own journal) under that lock, so the two never move the same
 * entries at once.
 */
export function sweepOrphanedRestoreDirs(): Promise<void> {
  return withBackupLock(sweepRestoreLeftovers);
}

async function sweepRestoreLeftovers(): Promise<void> {
  const servers: Array<{ id?: string; data: string }> = [{ data: config.dataPath }];
  try {
    for (const s of await listServers()) servers.push({ id: s.id, data: s.paths.data });
  } catch {
    /* registry not ready — fall back to the default path already added */
  }
  const seen = new Set<string>();
  for (const { id, data } of servers) {
    if (seen.has(data)) continue;
    seen.add(data);
    const parent = path.dirname(data);
    try {
      if (fs.existsSync(parent)) {
        for (const entry of fs.readdirSync(parent)) {
          if (/^_restore_(temp|old)_/.test(entry)) {
            fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
            console.log(`[Backup] swept orphaned restore dir: ${path.join(parent, entry)}`);
          }
        }
      }
      if (!fs.existsSync(data)) continue;
      if (await hasInterruptedRestore(data)) {
        const status = await dockerService.getStatus(id);
        if (status.running) {
          console.error(
            `[Backup] ${data} holds an interrupted restore, but the server is running; ` +
              'it is rolled back before the next restore (or stop the server and restart the panel).',
          );
          continue;
        }
      }
      // Only what an earlier process left behind: this sweep runs unawaited
      // at boot, and a restore started meanwhile must not be touched.
      const bootedAt = Date.now() - process.uptime() * 1000;
      const outcome = await recoverInterruptedRestore(data, { startedBefore: bootedAt });
      if (outcome !== 'none') console.warn(`[Backup] interrupted restore in ${data}: ${outcome}`);
    } catch (err) {
      console.error(
        `[Backup] restore recovery for ${data} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ============================================================
// Lock
// ============================================================

// In-process lock to prevent concurrent backup/restore operations.
// Two parallel HTTP requests can otherwise corrupt each other's tarball or
// race the retention cleanup. Not re-entrant. Code that also needs the server
// stopped takes the lifecycle lock (withServerStopped) first, then this one.
// A promise chain: each operation starts after the previous one settled (FIFO).
// (The earlier "while (lock) await lock" version compared the lock with the
// wrong promise, never released it, and the second operation then spun in a
// microtask loop that froze the whole manager.)
let backupLockTail: Promise<void> = Promise.resolve();

export function withBackupLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const op = backupLockTail.then(() => fn());
  backupLockTail = op.then(
    () => undefined,
    () => undefined, // a failed operation releases the lock, too
  );
  return op;
}

// ============================================================
// Listing
// ============================================================

// SECURITY: Validate backup ID to prevent path traversal
export function isValidBackupId(backupId: string): boolean {
  if (!backupId || typeof backupId !== 'string') return false;
  // Only allow alphanumeric, underscore, hyphen, and dot
  const safePattern = /^[a-zA-Z0-9_.-]+$/;
  return safePattern.test(backupId) && !backupId.includes('..');
}

export async function listBackups(serverId?: string): Promise<BackupInfo[]> {
  const backups: BackupInfo[] = [];
  const paths = await resolveBackupPaths(serverId);

  if (!fs.existsSync(paths.backups)) {
    return backups;
  }

  const files = fs.readdirSync(paths.backups);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    // Support common backup extensions and Hytale server backup format
    const isBackupFile =
      ['.gz', '.tar', '.zip', '.bak', '.backup'].includes(ext) ||
      file.endsWith('.tar.gz') ||
      file.startsWith('backup_') ||
      file.startsWith('hytale_');
    if (!isBackupFile) {
      continue;
    }

    const filePath = path.join(paths.backups, file);
    try {
      const stat = fs.statSync(filePath);

      // Skip if not a file or still being written (0 bytes)
      if (!stat.isFile()) {
        continue;
      }

      // Extract ID from filename
      let id = file;
      if (file.endsWith('.tar.gz')) {
        id = file.replace('.tar.gz', '');
      } else if (ext) {
        id = path.basename(file, ext);
      }

      // Calculate size - show at least 0.01 MB for small files
      const sizeMb = stat.size / (1024 * 1024);
      const displaySizeMb = stat.size > 0 ? Math.max(0.01, Math.round(sizeMb * 100) / 100) : 0;

      backups.push({
        id,
        filename: file,
        size_bytes: stat.size,
        size_mb: displaySizeMb,
        created_at: stat.mtime.toISOString(),
        type: backupType(id),
      });
    } catch (err) {
      // Skip files that can't be read (permission issues, etc.)
      console.warn(`[Backup] Could not read file ${file}:`, err);
      continue;
    }
  }

  // Sort by creation time (newest first)
  backups.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return backups;
}

export async function getBackup(backupId: string, serverId?: string): Promise<BackupInfo | null> {
  const backups = await listBackups(serverId);
  return backups.find((b) => b.id === backupId) || null;
}

export async function getBackupPath(backupId: string, serverId?: string): Promise<string | null> {
  // SECURITY: Validate backup ID
  if (!isValidBackupId(backupId)) {
    return null;
  }
  const paths = await resolveBackupPaths(serverId);
  const extensions = ['.tar.gz', '.tar', '.zip'];

  for (const ext of extensions) {
    const filePath = path.join(paths.backups, `${backupId}${ext}`);

    // SECURITY: Verify path is within backups directory
    if (!isPathSafe(filePath, [paths.backups])) {
      return null;
    }

    if (fs.existsSync(filePath)) {
      // A "backup" that is a symlink out of the backups dir is refused, so
      // download/restore/delete can't be pointed at panel files.
      return resolveRealPathWithin(filePath, [paths.backups]) ? filePath : null;
    }
  }

  return null;
}

// ============================================================
// Create / delete
// ============================================================

/**
 * Make the on-disk state of a running server as complete as possible before
 * tar reads it: `/world save --all --confirm`, then wait for the server's
 * confirmation (bounded) and a short settle time. A stopped server needs
 * nothing. Never throws; the returned note explains a missing confirmation.
 */
export async function flushWorldsIfRunning(
  serverId?: string,
): Promise<{ running: boolean; note?: string }> {
  const status = await dockerService.getStatus(serverId);
  if (!status.running) return { running: false };
  const since = Date.now();
  // Not on the operator whitelist (/world has destructive subcommands); the
  // panel sends this exact command through the lifecycle channel.
  const sent = await dockerService.sendLifecycleCommand(WORLD_SAVE_COMMAND, serverId);
  if (!sent.success) return { running: true, note: `world save not sent: ${sent.error}` };
  const reply = await waitForConsoleLine(
    since,
    { success: [WORLD_SAVE_DONE] },
    { timeoutMs: WORLD_SAVE_TIMEOUT_MS, serverId },
  );
  await sleep(WORLD_SAVE_SETTLE_MS);
  return reply.outcome === 'matched'
    ? { running: true }
    : { running: true, note: 'the server did not confirm the world save in time' };
}

/**
 * Create a panel backup. A string argument is the legacy form: a manual
 * backup with that name. Automatic callers pass `{ kind: 'auto', label }`.
 */
export function createBackup(
  options: string | CreateBackupOptions = {},
  serverId?: string,
): Promise<ActionResponse & { backup?: BackupInfo; warning?: string }> {
  const opts: CreateBackupOptions = typeof options === 'string' ? { label: options } : options;
  const kind: BackupKind = opts.kind ?? 'manual';
  return withBackupLock(async () => {
    const paths = await resolveBackupPaths(serverId);
    if (!fs.existsSync(paths.data)) {
      return { success: false, error: 'Data directory not found' };
    }

    // SECURITY: Validate name if provided
    if (opts.label && !isValidBackupName(opts.label)) {
      return {
        success: false,
        error: 'Invalid backup name. Use only letters, numbers, underscores and hyphens.',
      };
    }
    if (kind === 'auto' && !opts.label) {
      return { success: false, error: 'Automatic backups need a label' };
    }
    // manual_auto_<ts> / manual_scheduled_restart_<ts> are the old names of
    // automatic backups; a manual one named like that would be pruned.
    if (kind === 'manual' && opts.label && LEGACY_AUTO_LABELS.has(opts.label.toLowerCase())) {
      return { success: false, error: `"${opts.label}" is reserved; choose another backup name.` };
    }

    // Ensure backups directory exists
    if (!fs.existsSync(paths.backups)) {
      fs.mkdirSync(paths.backups, { recursive: true });
    }

    const nameAt = (at: Date): string => {
      const timestamp = backupTimestamp(at);
      if (kind === 'auto') return `${AUTO_PREFIX}${opts.label}_${timestamp}`;
      return opts.label
        ? `${MANUAL_PREFIX}${opts.label}_${timestamp}`
        : `${MANUAL_PREFIX}${timestamp}`;
    };
    const backupFile = freeTimestampedPath((at) =>
      path.join(paths.backups, `${nameAt(at)}.tar.gz`),
    );
    const backupName = path.basename(backupFile, '.tar.gz');

    // SECURITY: Double-check path is safe
    if (!isPathSafe(backupFile, [paths.backups])) {
      return { success: false, error: 'Invalid backup path' };
    }

    publish('backup.started', { name: backupName, file: backupFile }, serverId);
    try {
      const flush = await flushWorldsIfRunning(serverId);
      if (flush.note) console.warn(`[Backup] ${backupName}: ${flush.note}`);
      if (!(await archiveDataDir(paths.data, backupFile))) {
        throw new Error('The data directory is empty; nothing to back up.');
      }
      const link = await findSymlink(paths.data);
      const linkNote = link
        ? `it contains the symbolic link "${link}"; a restore refuses archives with links, ` +
          'so replace the link with the real folder'
        : undefined;
      const warning = [flush.note, linkNote].filter(Boolean).join('; ') || undefined;
      if (linkNote) console.warn(`[Backup] ${backupName}: ${linkNote}`);

      const stat = fs.statSync(backupFile);

      // Fire-and-forget off-host backup. The hook is a no-op stub by default;
      // see scripts/backup-hook.sh for restic / rclone / borg / s3 examples.
      runBackupHookAsync(backupFile);

      // Fire-and-forget off-site upload to S3-compatible storage (no-op unless
      // config.offsiteBackup is enabled with uploadOnBackup on).
      uploadBackupAsync(backupFile);

      // Snapshot the panel's own DB/config too so a manager-volume loss is
      // recoverable, and push that off-site as well. Best-effort.
      void backupPanelData().then((r) => {
        if (r.success && r.file) uploadBackupAsync(r.file);
        else if (!r.success) console.warn('[Backup] panel self-backup failed:', r.error);
      });

      publish(
        'backup.completed',
        {
          name: backupName,
          file: backupFile,
          sizeMb: Math.round((stat.size / (1024 * 1024)) * 100) / 100,
          serverRunning: flush.running,
        },
        serverId,
      );
      return {
        success: true,
        message: 'Backup created',
        // e.g. the running server did not confirm the world save in time
        warning,
        backup: {
          id: backupName,
          filename: `${backupName}.tar.gz`,
          size_bytes: stat.size,
          size_mb: Math.round((stat.size / (1024 * 1024)) * 100) / 100,
          created_at: new Date().toISOString(),
          type: kind,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown';
      publish('backup.failed', { name: backupName, error: msg }, serverId);
      // Surface a disk-full failure plainly instead of a raw tar error.
      if (/ENOSPC|No space left/i.test(msg)) {
        const free = freeBytes(paths.backups);
        const freeMb =
          free !== null
            ? ` (${Math.round(free / (1024 * 1024))} MB free on the backups volume)`
            : '';
        return { success: false, error: `Backup failed: not enough disk space${freeMb}.` };
      }
      return { success: false, error: error instanceof Error ? error.message : 'Backup failed' };
    }
  });
}

export function deleteBackup(backupId: string, serverId?: string): Promise<ActionResponse> {
  return withBackupLock(async () => {
    // SECURITY: Validate backup ID first
    if (!isValidBackupId(backupId)) {
      return { success: false, error: 'Invalid backup ID' };
    }

    const paths = await resolveBackupPaths(serverId);
    const filePath = await getBackupPath(backupId, serverId);

    if (!filePath) {
      return { success: false, error: 'Backup not found' };
    }

    // SECURITY: Verify path is safe before deletion
    if (!isPathSafe(filePath, [paths.backups])) {
      return { success: false, error: 'Invalid backup path' };
    }

    try {
      fs.unlinkSync(filePath);
      return { success: true, message: `Backup ${backupId} deleted` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Delete failed' };
    }
  });
}

export async function getStorageInfo(serverId?: string): Promise<StorageInfo> {
  let totalSize = 0;
  let count = 0;
  const paths = await resolveBackupPaths(serverId);

  if (fs.existsSync(paths.backups)) {
    const files = fs.readdirSync(paths.backups);
    for (const file of files) {
      const filePath = path.join(paths.backups, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          totalSize += stat.size;
          count++;
        }
      } catch {
        /* vanished or unreadable */
      }
    }
  }

  return {
    total_size_bytes: totalSize,
    total_size_mb: Math.round((totalSize / (1024 * 1024)) * 100) / 100,
    backup_count: count,
  };
}
