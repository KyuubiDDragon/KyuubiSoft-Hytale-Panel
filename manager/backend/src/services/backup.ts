import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { config } from '../config.js';
import type { BackupInfo, StorageInfo, ActionResponse } from '../types/index.js';
import { isValidBackupName } from '../utils/sanitize.js';
import { isPathSafe } from '../utils/pathSecurity.js';
import { getDefaultId, getServer, listServers } from './servers.js';
import { publish } from './eventBus.js';
import { uploadBackupAsync } from './offsiteBackup.js';
import { getDb } from '../db/index.js';

// The manager's own data (panel.sqlite + config/users/servers JSON) lives here.
const MANAGER_DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
// How many panel self-backups to keep in the _panel subdir.
const PANEL_BACKUP_KEEP = 14;

/** Free bytes on the filesystem holding `dir`, or null if statfs is unsupported. */
function freeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/**
 * Resolve the backup/data paths for a specific server id. Falls back to the
 * default server (or the legacy env-var config if the registry isn't loaded
 * yet on fresh boot). Multi-server callers pass an explicit id; legacy
 * callers omit it.
 */
async function resolvePaths(serverId?: string): Promise<{ backups: string; data: string }> {
  try {
    const id = serverId ?? (await getDefaultId());
    const s = await getServer(id);
    if (s) return { backups: s.paths.backups, data: s.paths.data };
  } catch { /* registry not ready */ }
  return { backups: config.backupsPath, data: config.dataPath };
}

// Path to the off-host backup hook **inside the manager container**.
// createBackup() runs tar itself (execSync), so the resulting tarball is
// already visible to the manager process — invoking a sibling container's
// /opt/hytale/backup-hook.sh would require a `docker exec`, which we don't
// want to take a dependency on. The hook ships from manager/backup-hook.sh
// (kept in sync with scripts/backup-hook.sh) at /app/backup-hook.sh.
const BACKUP_HOOK_PATH = process.env.BACKUP_HOOK_PATH || '/app/backup-hook.sh';

function runBackupHookAsync(absolutePath: string): void {
  if (!fs.existsSync(BACKUP_HOOK_PATH)) return;
  try {
    const child = spawn(BACKUP_HOOK_PATH, [absolutePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    console.warn('[Backup] Failed to spawn backup-hook:', err instanceof Error ? err.message : err);
  }
}

function prunePanelBackups(panelDir: string): void {
  try {
    const files = fs.readdirSync(panelDir)
      .filter((f) => f.startsWith('panel-config_') && f.endsWith('.tar.gz'))
      .map((f) => ({ f, t: fs.statSync(path.join(panelDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(PANEL_BACKUP_KEEP)) {
      fs.rmSync(path.join(panelDir, f), { force: true });
    }
  } catch { /* non-fatal */ }
}

/**
 * Snapshot the panel's OWN state — a consistent online copy of panel.sqlite
 * (audit log, API keys, webhooks, punishments, …) plus the config/users/servers
 * JSON — into `<backupsDir>/_panel/panel-config_<ts>.tar.gz`. Kept in a subdir
 * so it never appears in (or is restored as) a game-data backup. Without this a
 * manager-volume loss is unrecoverable.
 */
export async function backupPanelData(backupsDir: string): Promise<{ success: boolean; file?: string; error?: string }> {
  try {
    const panelDir = path.join(backupsDir, '_panel');
    fs.mkdirSync(panelDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
    const stage = path.join(panelDir, `.stage_${ts}`);
    fs.mkdirSync(stage, { recursive: true });
    try {
      // Online snapshot — safe to take while the DB is in use (WAL).
      await getDb().backup(path.join(stage, 'panel.sqlite'));
      for (const name of ['config.json', 'users.json', 'servers.json']) {
        const src = path.join(MANAGER_DATA_DIR, name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, name));
      }
      const outFile = path.join(panelDir, `panel-config_${ts}.tar.gz`);
      execSync(`tar -czf '${outFile}' -C '${stage}' .`, { timeout: 300000, maxBuffer: 1024 * 1024 * 10 });
      prunePanelBackups(panelDir);
      return { success: true, file: outFile };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'panel backup failed' };
  }
}

/**
 * Remove leftover restore staging dirs (`_restore_temp_*`, `_restore_old_*`)
 * next to each server's data dir — these only linger after a restore that
 * crashed mid-swap. Best-effort; runs on boot.
 */
export async function sweepOrphanedRestoreDirs(): Promise<void> {
  const parents = new Set<string>();
  try {
    parents.add(path.dirname(config.dataPath));
    for (const s of await listServers()) parents.add(path.dirname(s.paths.data));
  } catch { /* registry not ready — fall back to the default path already added */ }
  for (const parent of parents) {
    try {
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent)) {
        if (/^_restore_(temp|old)_/.test(entry)) {
          fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
          console.log(`[Backup] swept orphaned restore dir: ${path.join(parent, entry)}`);
        }
      }
    } catch { /* ignore per-parent failures */ }
  }
}

// In-process lock to prevent concurrent backup/restore operations.
// Two parallel HTTP requests can otherwise corrupt each other's tarball or
// race the retention cleanup.
let backupOperationLock: Promise<unknown> | null = null;

async function withBackupLock<T>(fn: () => T | Promise<T>): Promise<T> {
  while (backupOperationLock) {
    try { await backupOperationLock; } catch { /* prior op failed, that's fine */ }
  }
  const op = (async () => fn())();
  backupOperationLock = op.finally(() => {
    if (backupOperationLock === op) backupOperationLock = null;
  });
  return op;
}

// SECURITY: Validate backup ID to prevent path traversal
function validateBackupId(backupId: string): boolean {
  if (!backupId || typeof backupId !== 'string') return false;
  // Only allow alphanumeric, underscore, hyphen, and dot
  const safePattern = /^[a-zA-Z0-9_.-]+$/;
  return safePattern.test(backupId) && !backupId.includes('..');
}

export async function listBackups(serverId?: string): Promise<BackupInfo[]> {
  const backups: BackupInfo[] = [];
  const paths = await resolvePaths(serverId);

  if (!fs.existsSync(paths.backups)) {
    return backups;
  }

  const files = fs.readdirSync(paths.backups);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    // Support common backup extensions and Hytale server backup format
    const isBackupFile = ['.gz', '.tar', '.zip', '.bak', '.backup'].includes(ext) ||
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

      // Determine type: auto if includes 'auto', 'scheduled', or created by Hytale server
      const isAuto = file.includes('auto') ||
                     file.includes('scheduled') ||
                     file.startsWith('backup_'); // Hytale server format

      backups.push({
        id,
        filename: file,
        size_bytes: stat.size,
        size_mb: displaySizeMb,
        created_at: stat.mtime.toISOString(),
        type: isAuto ? 'auto' : 'manual',
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
  if (!validateBackupId(backupId)) {
    return null;
  }
  const paths = await resolvePaths(serverId);
  const extensions = ['.tar.gz', '.tar', '.zip'];

  for (const ext of extensions) {
    const filePath = path.join(paths.backups, `${backupId}${ext}`);

    // SECURITY: Verify path is within backups directory
    if (!isPathSafe(filePath, [paths.backups])) {
      return null;
    }

    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

export function createBackup(name?: string, serverId?: string): Promise<ActionResponse & { backup?: BackupInfo }> {
  return withBackupLock(async () => {
    const paths = await resolvePaths(serverId);
    if (!fs.existsSync(paths.data)) {
      return { success: false, error: 'Data directory not found' };
    }

    // SECURITY: Validate name if provided
    if (name && !isValidBackupName(name)) {
      return { success: false, error: 'Invalid backup name. Use only letters, numbers, underscores and hyphens.' };
    }

    // Ensure backups directory exists
    if (!fs.existsSync(paths.backups)) {
      fs.mkdirSync(paths.backups, { recursive: true });
    }

    // Generate backup name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
    const backupName = name ? `manual_${name}_${timestamp}` : `manual_${timestamp}`;
    const backupFile = path.join(paths.backups, `${backupName}.tar.gz`);

    // SECURITY: Double-check path is safe
    if (!isPathSafe(backupFile, [paths.backups])) {
      return { success: false, error: 'Invalid backup path' };
    }

    publish('backup.started', { name: backupName, file: backupFile }, serverId);
    try {
      // Create tarball using tar command (paths are validated, using single quotes for safety)
      // Timeout increased to 30 minutes for large backups (1GB+)
      execSync(`tar -czf '${backupFile}' -C '${paths.data}' .`, {
        timeout: 1800000, // 30 minutes
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer for command output
      });

      const stat = fs.statSync(backupFile);

      // Fire-and-forget off-host backup. The hook is a no-op stub by default;
      // see scripts/backup-hook.sh for restic / rclone / borg / s3 examples.
      runBackupHookAsync(backupFile);

      // Fire-and-forget off-site upload to S3-compatible storage (no-op unless
      // config.offsiteBackup is enabled with uploadOnBackup on).
      uploadBackupAsync(backupFile);

      // Snapshot the panel's own DB/config too so a manager-volume loss is
      // recoverable, and push that off-site as well. Best-effort.
      void backupPanelData(paths.backups).then((r) => {
        if (r.success && r.file) uploadBackupAsync(r.file);
        else if (!r.success) console.warn('[Backup] panel self-backup failed:', r.error);
      });

      publish('backup.completed', {
        name: backupName, file: backupFile, sizeMb: Math.round(stat.size / (1024 * 1024) * 100) / 100,
      }, serverId);
      return {
        success: true,
        backup: {
          id: backupName,
          filename: `${backupName}.tar.gz`,
          size_bytes: stat.size,
          size_mb: Math.round(stat.size / (1024 * 1024) * 100) / 100,
          created_at: new Date().toISOString(),
          type: 'manual',
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown';
      publish('backup.failed', { name: backupName, error: msg }, serverId);
      // Surface a disk-full failure plainly instead of a raw tar error.
      if (/ENOSPC|No space left/i.test(msg)) {
        const free = freeBytes(paths.backups);
        const freeMb = free !== null ? ` (${Math.round(free / (1024 * 1024))} MB free on the backups volume)` : '';
        return { success: false, error: `Backup failed: not enough disk space${freeMb}.` };
      }
      return { success: false, error: error instanceof Error ? error.message : 'Backup failed' };
    }
  });
}

export function deleteBackup(backupId: string, serverId?: string): Promise<ActionResponse> {
  return withBackupLock(async () => {
    // SECURITY: Validate backup ID first
    if (!validateBackupId(backupId)) {
      return { success: false, error: 'Invalid backup ID' };
    }

    const paths = await resolvePaths(serverId);
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

export function restoreBackup(backupId: string, serverId?: string): Promise<ActionResponse> {
  return withBackupLock(async () => {
    // SECURITY: Validate backup ID first
    if (!validateBackupId(backupId)) {
      return { success: false, error: 'Invalid backup ID' };
    }

    const paths = await resolvePaths(serverId);
    const filePath = await getBackupPath(backupId, serverId);

    if (!filePath) {
      return { success: false, error: 'Backup not found' };
    }

    // SECURITY: Verify path is safe
    if (!isPathSafe(filePath, [paths.backups])) {
      return { success: false, error: 'Invalid backup path' };
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
    // Stage temp + sidelined dirs NEXT TO paths.data so the final swap is an
    // atomic same-filesystem rename. (The old code staged under paths.backups,
    // which is often a different mount → cross-device rename.) safeMove falls
    // back to copy+remove on EXDEV regardless.
    const dataParent = path.dirname(paths.data);
    const tempDir = path.join(dataParent, `_restore_temp_${ts}`);
    const oldDir = path.join(dataParent, `_restore_old_${ts}`);

    // Integrity gate: confirm the archive is a readable gzip tar BEFORE we take
    // the pre-restore backup or touch live data. A corrupt/truncated archive
    // fails here with nothing changed, instead of silently swapping in garbage.
    try {
      execSync(`tar -tzf '${filePath}' > /dev/null`, { timeout: 300000, maxBuffer: 1024 * 1024 * 10 });
    } catch {
      return { success: false, error: 'Backup archive is unreadable or corrupted; restore aborted (no data changed).' };
    }

    // Disk preflight: the pre-restore backup (~data size) plus the extraction
    // (~uncompressed backup) both need space. Require a margin of 4× the
    // compressed archive on the data volume. Skipped if statfs is unavailable.
    try {
      const archiveSize = fs.statSync(filePath).size;
      const free = freeBytes(dataParent);
      if (free !== null && free < archiveSize * 4) {
        const mb = (n: number) => Math.round(n / (1024 * 1024));
        return {
          success: false,
          error: `Not enough disk space to restore safely: need ~${mb(archiveSize * 4)} MB free, only ${mb(free)} MB available. Restore aborted (no data changed).`,
        };
      }
    } catch { /* stat/statfs issue — proceed; the operation will surface real errors */ }

    // Move src→dst atomically when possible, else copy across devices.
    const safeMove = (src: string, dst: string): void => {
      try {
        fs.renameSync(src, dst);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
          fs.cpSync(src, dst, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
    };

    try {
      // MANDATORY pre-restore backup. We can't call createBackup() here (it would
      // deadlock on the lock we already hold) so inline the tar. If this fails we
      // ABORT — proceeding would risk leaving no way back if the restore breaks.
      const preFile = path.join(paths.backups, `manual_pre_restore_${ts}.tar.gz`);
      if (!isPathSafe(preFile, [paths.backups])) {
        return { success: false, error: 'Could not compute a safe pre-restore backup path' };
      }
      try {
        execSync(`tar -czf '${preFile}' -C '${paths.data}' .`, { timeout: 1800000, maxBuffer: 1024 * 1024 * 10 });
      } catch (preErr) {
        return {
          success: false,
          error: `Aborted: pre-restore safety backup failed (${preErr instanceof Error ? preErr.message : 'unknown'}). No data was changed.`,
        };
      }

      // Extract the backup into a temp dir.
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      fs.mkdirSync(tempDir, { recursive: true });
      execSync(`tar -xzf '${filePath}' -C '${tempDir}'`, { timeout: 1800000, maxBuffer: 1024 * 1024 * 10 });

      // Sanity: a valid backup extracts to a non-empty tree. An empty result
      // means a bad/empty archive — abort before swapping out live data.
      if (fs.readdirSync(tempDir).length === 0) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return { success: false, error: 'Backup extracted to an empty directory; restore aborted (no data changed).' };
      }

      // Swap WITHOUT a destructive delete first: move current data aside, move
      // the restored data in, and only then drop the sidelined copy. If the
      // swap fails midway the original data is rolled back into place.
      let movedAside = false;
      if (fs.existsSync(paths.data)) {
        safeMove(paths.data, oldDir);
        movedAside = true;
      }
      try {
        safeMove(tempDir, paths.data);
      } catch (swapErr) {
        // Roll back: restore the original data so a failed swap isn't data loss.
        if (movedAside && !fs.existsSync(paths.data)) {
          try { safeMove(oldDir, paths.data); } catch { /* leave oldDir for manual recovery */ }
        }
        return {
          success: false,
          error: `Restore failed during swap; original data preserved (${swapErr instanceof Error ? swapErr.message : 'unknown'}).`,
        };
      }

      // Success — discard the sidelined original.
      if (movedAside) {
        try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* non-fatal leftover */ }
      }

      return {
        success: true,
        message: `Restored from backup ${backupId}. Server restart required.`,
      };
    } catch (error) {
      // Best-effort cleanup of the temp dir on any failure before the swap.
      try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return { success: false, error: error instanceof Error ? error.message : 'Restore failed' };
    }
  });
}

export async function getStorageInfo(serverId?: string): Promise<StorageInfo> {
  let totalSize = 0;
  let count = 0;
  const paths = await resolvePaths(serverId);

  if (fs.existsSync(paths.backups)) {
    const files = fs.readdirSync(paths.backups);
    for (const file of files) {
      const filePath = path.join(paths.backups, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        totalSize += stat.size;
        count++;
      }
    }
  }

  return {
    total_size_bytes: totalSize,
    total_size_mb: Math.round(totalSize / (1024 * 1024) * 100) / 100,
    backup_count: count,
  };
}
