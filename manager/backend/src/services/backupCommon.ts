/**
 * Pieces shared by the panel backups (services/backup.ts) and the server's
 * native backups (services/nativeBackups.ts): path resolution, the off-host
 * hook and the configurable extraction cap.
 */
import fs from 'fs';
import { spawn } from 'child_process';
import { config } from '../config.js';
import { getDefaultId, getServer } from './servers.js';

export interface BackupPaths {
  backups: string;
  data: string;
}

/**
 * Resolve the backup/data paths for a specific server id. Falls back to the
 * default server (or the legacy env-var config if the registry isn't loaded
 * yet on fresh boot). Multi-server callers pass an explicit id; legacy
 * callers omit it.
 */
export async function resolveBackupPaths(serverId?: string): Promise<BackupPaths> {
  try {
    const id = serverId ?? (await getDefaultId());
    const s = await getServer(id);
    if (s) return { backups: s.paths.backups, data: s.paths.data };
  } catch {
    /* registry not ready */
  }
  return { backups: config.backupsPath, data: config.dataPath };
}

/** Free bytes on the filesystem holding `dir`, or null if statfs is unsupported. */
export function freeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

const MAX_NAME_ATTEMPTS = 60;

/**
 * Backup names carry a timestamp with one-second resolution. Two backups in
 * the same second (a scheduled one next to a manual one, a restore's safety
 * copy right after a backup) must not overwrite each other, so the time is
 * moved forward until the name is free.
 */
export function freeTimestampedPath(makePath: (at: Date) => string, start = new Date()): string {
  for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
    const candidate = makePath(new Date(start.getTime() + i * 1000));
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find a free backup file name');
}

const GIB = 1024 * 1024 * 1024;
const DEFAULT_EXTRACT_MAX_GB = 50;

/**
 * Upper bound for the unpacked size of a restored or imported archive
 * (ARCHIVE_EXTRACT_MAX_GB, default 50). Read per call so tests and operators
 * can change it without a restart of the module.
 */
export function archiveExtractMaxBytes(): number {
  const raw = Number(process.env.ARCHIVE_EXTRACT_MAX_GB);
  const gb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXTRACT_MAX_GB;
  return Math.floor(gb * GIB);
}

/** Free space that must remain on the data volume after unpacking. */
export const EXTRACT_RESERVE_BYTES = 512 * 1024 * 1024;

// Path to the off-host backup hook **inside the manager container**. The
// archives the hook gets are written to the shared backups volume, so they
// are visible to the manager process; invoking a sibling container's
// /opt/hytale/backup-hook.sh would require a `docker exec`, which we don't
// want to take a dependency on. The hook ships from manager/backup-hook.sh
// (kept in sync with scripts/backup-hook.sh) at /app/backup-hook.sh.
const BACKUP_HOOK_PATH = process.env.BACKUP_HOOK_PATH || '/app/backup-hook.sh';

export function runBackupHookAsync(absolutePath: string): void {
  if (!fs.existsSync(BACKUP_HOOK_PATH)) return;
  try {
    const child = spawn(BACKUP_HOOK_PATH, [absolutePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => console.warn('[Backup] backup-hook failed:', err.message));
    child.unref();
  } catch (err) {
    console.warn('[Backup] Failed to spawn backup-hook:', err instanceof Error ? err.message : err);
  }
}
