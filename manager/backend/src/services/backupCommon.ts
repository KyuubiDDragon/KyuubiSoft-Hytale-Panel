/**
 * Pieces shared by the panel backups (services/backup.ts) and the server's
 * native backups (services/nativeBackups.ts): path resolution, the off-host
 * hook, the configurable extraction cap and writing tar archives.
 */
import fs from 'fs';
import { spawn } from 'child_process';
import { getServerContext } from './serverContext.js';

export interface BackupPaths {
  backups: string;
  data: string;
}

/**
 * Backup/data paths of a server id; omitted means the default server. An
 * unknown id throws instead of falling back to another server's folders.
 */
export async function resolveBackupPaths(serverId?: string): Promise<BackupPaths> {
  const { paths } = await getServerContext(serverId);
  return { backups: paths.backups, data: paths.data };
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

const TAR_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TAR_STDERR_MAX = 64 * 1024;

/**
 * Run tar with an argv array; rejects with tar's stderr on a non-zero exit.
 * `stdoutFd` receives tar's output (for `-f -`).
 */
function runTar(args: string[], timeoutMs = TAR_TIMEOUT_MS, stdoutFd?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', stdoutFd ?? 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < TAR_STDERR_MAX) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const detail = stderr.trim().slice(-500) || (signal ? `killed by ${signal}` : `exit ${code}`);
      reject(new Error(`tar failed: ${detail}`));
    });
  });
}

/**
 * Writes a gzipped tar of `sources` (tar arguments after `-f`) to `outFile`,
 * which must not exist yet. The backups folder is shared with the game
 * server: `tar -f <name>` would follow a link it planted under the name of the
 * next backup and overwrite whatever that points to. So the file is created
 * here (O_EXCL never follows a link) and tar writes into it through stdout.
 * A failed archive is removed.
 */
export async function createTarArchive(
  outFile: string,
  sources: string[],
  timeoutMs = TAR_TIMEOUT_MS,
): Promise<void> {
  const fh = await fs.promises.open(
    outFile,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o666,
  );
  try {
    await runTar(['-c', '-z', '-f', '-', ...sources], timeoutMs, fh.fd);
  } catch (err) {
    await fh.close().catch(() => undefined);
    await fs.promises.rm(outFile, { force: true }).catch(() => undefined);
    throw err;
  }
  await fh.close();
}
