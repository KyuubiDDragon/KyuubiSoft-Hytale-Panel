/**
 * Restore of a panel backup (tar.gz/zip) or a native server backup (zip).
 *
 * Runs as a background job (services/backupJobs.ts):
 *   1. validate the archive: no links/special files/absolute paths, unpacked
 *      size within ARCHIVE_EXTRACT_MAX_GB, enough free space on the data volume
 *   2. unpack it into a staging dir INSIDE the data dir while the server is
 *      still running (failures up to here cost no downtime)
 *   3. stop the server gracefully (serverLifecycle.withServerStopped)
 *   4. write a safety backup of the current state (manual_pre_restore_<ts>)
 *   5. swap the directory contents (services/restoreSwap.ts); the panel's own
 *      files in the data dir are kept
 *   6. start the server again if it was running
 */
import fs from 'fs';
import path from 'path';
import type { ActionResponse } from '../types/index.js';
import { isPathSafe } from '../utils/pathSecurity.js';
import {
  ArchiveRejectedError,
  ArchiveSpaceError,
  archiveFormatFromName,
  extractToStaging,
  inspectArchive,
  type ArchiveFormat,
} from '../utils/archiveSafety.js';
import {
  EXTRACT_RESERVE_BYTES,
  archiveExtractMaxBytes,
  freeTimestampedPath,
  resolveBackupPaths,
} from './backupCommon.js';
import {
  archiveDataDir,
  backupTimestamp,
  getBackupPath,
  isValidBackupId,
  safetyBackupName,
  withBackupLock,
} from './backup.js';
import {
  createRestoreStage,
  isPanelOwnedDataEntry,
  recoverInterruptedRestore,
  RestoreRollbackError,
  stagedEntries,
  swapDataContents,
} from './restoreSwap.js';
import {
  getNativeBackupPath,
  isNativeBackupScope,
  isValidNativeBackupName,
  type NativeBackupScope,
} from './nativeBackups.js';
import {
  runningBackupJob,
  startBackupJob,
  waitForBackupJob,
  type BackupJob,
  type JobControl,
} from './backupJobs.js';
import { withServerStopped } from './serverLifecycle.js';

export type RestoreSource =
  { kind: 'panel'; backupId: string } | { kind: 'native'; scope: NativeBackupScope; name: string };

export type StartRestoreResult =
  { ok: true; job: BackupJob } | { ok: false; status: 400 | 404 | 409; error: string };

interface ResolvedArchive {
  file: string;
  format: ArchiveFormat;
  label: string;
  native: boolean;
}

const UNCHANGED = 'Restore aborted, no data was changed.';

async function resolveRestoreArchive(
  source: RestoreSource,
  serverId?: string,
): Promise<ResolvedArchive | { status: 400 | 404; error: string }> {
  if (source.kind === 'native') {
    if (!isNativeBackupScope(source.scope) || !isValidNativeBackupName(source.name)) {
      return { status: 400, error: 'Invalid native backup' };
    }
    const file = await getNativeBackupPath(source.scope, source.name, serverId);
    if (!file) return { status: 404, error: 'Native backup not found' };
    return { file, format: 'zip', label: `native backup ${source.name}`, native: true };
  }
  if (!isValidBackupId(source.backupId)) return { status: 400, error: 'Invalid backup ID' };
  const file = await getBackupPath(source.backupId, serverId);
  if (!file) return { status: 404, error: 'Backup not found' };
  const format = archiveFormatFromName(file);
  if (!format) return { status: 400, error: 'Only .tar.gz and .zip backups can be restored' };
  return { file, format, label: `backup ${source.backupId}`, native: false };
}

function userMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Safety copy of the current state; the server is stopped at this point. */
async function writeSafetyBackup(dataDir: string, backupsDir: string): Promise<string> {
  fs.mkdirSync(backupsDir, { recursive: true });
  const file = freeTimestampedPath((at) =>
    path.join(backupsDir, `${safetyBackupName(backupTimestamp(at))}.tar.gz`),
  );
  const name = path.basename(file, '.tar.gz');
  if (!isPathSafe(file, [backupsDir])) throw new Error('Could not compute a safe backup path');
  return (await archiveDataDir(dataDir, file)) ? name : '(data directory was empty)';
}

async function performRestore(
  archive: ResolvedArchive,
  serverId: string | undefined,
  actor: string | undefined,
  control: JobControl,
): Promise<{ message?: string; error?: string }> {
  const paths = await resolveBackupPaths(serverId);
  if (!fs.existsSync(paths.data)) return { error: 'Data directory not found' };
  const limits = { maxBytes: archiveExtractMaxBytes(), reserveBytes: EXTRACT_RESERVE_BYTES };

  control.setStep('validating');
  let declared;
  try {
    declared = await inspectArchive(archive.file, archive.format, limits);
  } catch (err) {
    return { error: `${userMessage(err)} ${UNCHANGED}` };
  }
  if (declared.files === 0) {
    // e.g. a native zip written while the universe folder was a symlink
    return { error: `The backup does not contain any files. ${UNCHANGED}` };
  }

  const ts = backupTimestamp();
  control.setStep('extracting');
  const stage = await createRestoreStage(paths.data, ts);
  let swapped = false;
  let safetyBackup = '';
  let cleanupWarning: string | undefined;
  try {
    try {
      await extractToStaging(archive.file, archive.format, stage, limits, declared);
    } catch (err) {
      const known = err instanceof ArchiveRejectedError || err instanceof ArchiveSpaceError;
      return {
        error: `${known ? userMessage(err) : `Unpacking failed: ${userMessage(err)}`} ${UNCHANGED}`,
      };
    }
    const gameEntries = (await stagedEntries(stage)).filter((n) => !isPanelOwnedDataEntry(n));
    if (gameEntries.length === 0) {
      return { error: `The backup contains no world data. ${UNCHANGED}` };
    }
    // A native zip replaces the whole data dir, so it has to be a backup of
    // that dir (the universe) and not of a folder inside it.
    if (archive.native && !gameEntries.includes('worlds')) {
      return {
        error: `The zip has no "worlds" folder at the top, so it is no universe backup. ${UNCHANGED}`,
      };
    }

    control.setStep('stopping-server');
    // Lock order: server lifecycle first, then the backup lock (the same order
    // a scheduled restart uses when it backs up a stopped server).
    await withServerStopped(serverId, { reason: 'restore', actor: actor ?? 'backup-restore' }, () =>
      withBackupLock(async () => {
        // A swap interrupted earlier must be undone before a new one starts.
        await recoverInterruptedRestore(paths.data, { keep: stage });
        control.setStep('safety-backup');
        safetyBackup = await writeSafetyBackup(paths.data, paths.backups);
        control.setStep('swapping');
        cleanupWarning = (await swapDataContents(paths.data, stage, ts)).cleanupWarning;
        swapped = true;
        control.setStep('starting-server');
      }),
    );
    const note = cleanupWarning ? ` Note: ${cleanupWarning}.` : '';
    return {
      message: `Restored ${archive.label}. The previous state was saved as ${safetyBackup}.${note}`,
    };
  } catch (err) {
    if (swapped) {
      // The data is restored; only bringing the server back up failed.
      return {
        message:
          `Restored ${archive.label} (previous state saved as ${safetyBackup}), ` +
          `but the server could not be started again: ${userMessage(err)}`,
      };
    }
    if (err instanceof RestoreRollbackError) return { error: `Restore failed: ${err.message}` };
    const safety = safetyBackup ? ` (safety backup: ${safetyBackup})` : '';
    return { error: `Restore failed: ${userMessage(err)} ${UNCHANGED}${safety}` };
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Start a restore as a background job. Fails fast (without a job) when the
 * backup does not exist or another backup job is running.
 */
export async function startRestore(
  source: RestoreSource,
  serverId?: string,
  actor?: string,
): Promise<StartRestoreResult> {
  const archive = await resolveRestoreArchive(source, serverId);
  if ('error' in archive) return { ok: false, status: archive.status, error: archive.error };
  const running = runningBackupJob();
  if (running) {
    return { ok: false, status: 409, error: `Another backup job is running (${running.type})` };
  }
  const job = startBackupJob(
    {
      type: source.kind === 'native' ? 'native-restore' : 'restore',
      serverId,
      target: source.kind === 'native' ? `${source.scope}/${source.name}` : source.backupId,
      startedBy: actor,
    },
    (control) => performRestore(archive, serverId, actor, control),
  );
  return { ok: true, job };
}

/** Restore and wait for the result (for callers that want a single call). */
export async function restoreBackup(
  backupId: string,
  serverId?: string,
  actor?: string,
): Promise<ActionResponse> {
  const started = await startRestore({ kind: 'panel', backupId }, serverId, actor);
  if (!started.ok) return { success: false, error: started.error };
  const finished = await waitForBackupJob(started.job.id)!;
  return finished.state === 'succeeded'
    ? { success: true, message: finished.message ?? 'Restored' }
    : { success: false, error: finished.error ?? 'Restore failed' };
}
