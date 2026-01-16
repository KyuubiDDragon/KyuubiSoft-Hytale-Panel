import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { config } from '../config.js';
import type { BackupInfo, StorageInfo, ActionResponse } from '../types/index.js';
import { isValidBackupName } from '../utils/sanitize.js';
import { isPathSafe } from '../utils/pathSecurity.js';

// SECURITY: Validate backup ID to prevent path traversal
function validateBackupId(backupId: string): boolean {
  if (!backupId || typeof backupId !== 'string') return false;
  // Only allow alphanumeric, underscore, hyphen, and dot
  const safePattern = /^[a-zA-Z0-9_.-]+$/;
  return safePattern.test(backupId) && !backupId.includes('..');
}

export function listBackups(): BackupInfo[] {
  const backups: BackupInfo[] = [];

  if (!fs.existsSync(config.backupsPath)) {
    return backups;
  }

  const files = fs.readdirSync(config.backupsPath);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!['.gz', '.tar', '.zip'].includes(ext) && !file.endsWith('.tar.gz')) {
      continue;
    }

    const filePath = path.join(config.backupsPath, file);
    const stat = fs.statSync(filePath);

    // Extract ID from filename
    let id = file;
    if (file.endsWith('.tar.gz')) {
      id = file.replace('.tar.gz', '');
    } else {
      id = path.basename(file, ext);
    }

    backups.push({
      id,
      filename: file,
      size_bytes: stat.size,
      size_mb: Math.round(stat.size / (1024 * 1024) * 100) / 100,
      created_at: stat.mtime.toISOString(),
      type: file.includes('auto') ? 'auto' : 'manual',
    });
  }

  // Sort by creation time (newest first)
  backups.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return backups;
}

export function getBackup(backupId: string): BackupInfo | null {
  const backups = listBackups();
  return backups.find((b) => b.id === backupId) || null;
}

export function getBackupPath(backupId: string): string | null {
  // SECURITY: Validate backup ID
  if (!validateBackupId(backupId)) {
    return null;
  }

  const extensions = ['.tar.gz', '.tar', '.zip'];

  for (const ext of extensions) {
    const filePath = path.join(config.backupsPath, `${backupId}${ext}`);

    // SECURITY: Verify path is within backups directory
    if (!isPathSafe(filePath, [config.backupsPath])) {
      return null;
    }

    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

export function createBackup(name?: string): ActionResponse & { backup?: BackupInfo } {
  if (!fs.existsSync(config.dataPath)) {
    return { success: false, error: 'Data directory not found' };
  }

  // SECURITY: Validate name if provided
  if (name && !isValidBackupName(name)) {
    return { success: false, error: 'Invalid backup name. Use only letters, numbers, underscores and hyphens.' };
  }

  // Ensure backups directory exists
  if (!fs.existsSync(config.backupsPath)) {
    fs.mkdirSync(config.backupsPath, { recursive: true });
  }

  // Generate backup name
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
  const backupName = name ? `manual_${name}_${timestamp}` : `manual_${timestamp}`;
  const backupFile = path.join(config.backupsPath, `${backupName}.tar.gz`);

  // SECURITY: Double-check path is safe
  if (!isPathSafe(backupFile, [config.backupsPath])) {
    return { success: false, error: 'Invalid backup path' };
  }

  try {
    // Create tarball using tar command (paths are validated, using single quotes for safety)
    // Timeout increased to 30 minutes for large backups (1GB+)
    execSync(`tar -czf '${backupFile}' -C '${config.dataPath}' .`, {
      timeout: 1800000, // 30 minutes
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer for command output
    });

    const stat = fs.statSync(backupFile);

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
    return { success: false, error: error instanceof Error ? error.message : 'Backup failed' };
  }
}

export function deleteBackup(backupId: string): ActionResponse {
  // SECURITY: Validate backup ID first
  if (!validateBackupId(backupId)) {
    return { success: false, error: 'Invalid backup ID' };
  }

  const filePath = getBackupPath(backupId);

  if (!filePath) {
    return { success: false, error: 'Backup not found' };
  }

  // SECURITY: Verify path is safe before deletion
  if (!isPathSafe(filePath, [config.backupsPath])) {
    return { success: false, error: 'Invalid backup path' };
  }

  try {
    fs.unlinkSync(filePath);
    return { success: true, message: `Backup ${backupId} deleted` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Delete failed' };
  }
}

export function restoreBackup(backupId: string): ActionResponse {
  // SECURITY: Validate backup ID first
  if (!validateBackupId(backupId)) {
    return { success: false, error: 'Invalid backup ID' };
  }

  const filePath = getBackupPath(backupId);

  if (!filePath) {
    return { success: false, error: 'Backup not found' };
  }

  // SECURITY: Verify path is safe
  if (!isPathSafe(filePath, [config.backupsPath])) {
    return { success: false, error: 'Invalid backup path' };
  }

  try {
    // Create a pre-restore backup
    createBackup('pre_restore');

    // Create temp directory
    const tempDir = path.join(config.backupsPath, '_restore_temp');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Extract backup (paths are validated, using single quotes for safety)
    // Timeout increased to 30 minutes for large backups (1GB+)
    execSync(`tar -xzf '${filePath}' -C '${tempDir}'`, {
      timeout: 1800000, // 30 minutes
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer for command output
    });

    // Clear current data and move restored data
    if (fs.existsSync(config.dataPath)) {
      fs.rmSync(config.dataPath, { recursive: true });
    }
    fs.renameSync(tempDir, config.dataPath);

    return {
      success: true,
      message: `Restored from backup ${backupId}. Server restart required.`,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Restore failed' };
  }
}

export function getStorageInfo(): StorageInfo {
  let totalSize = 0;
  let count = 0;

  if (fs.existsSync(config.backupsPath)) {
    const files = fs.readdirSync(config.backupsPath);
    for (const file of files) {
      const filePath = path.join(config.backupsPath, file);
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
