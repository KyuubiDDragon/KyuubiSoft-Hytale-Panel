import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { config } from '../config.js';
import type { BackupInfo, StorageInfo, ActionResponse } from '../types/index.js';
import { isValidBackupName } from '../utils/sanitize.js';
import { isPathSafe } from '../utils/pathSecurity.js';
import { getDefaultId, getServer } from './servers.js';
import { publish } from './eventBus.js';
import { uploadBackupAsync } from './offsiteBackup.js';

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
      publish('backup.failed', { name: backupName, error: error instanceof Error ? error.message : 'unknown' }, serverId);
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
