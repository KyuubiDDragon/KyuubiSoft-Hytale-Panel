/**
 * Status registry for long backup operations (restores, native backups).
 *
 * These run for minutes, longer than an HTTP request should stay open, so
 * the route starts them and returns a job id; the UI polls the job. Jobs live
 * in memory only: after a manager restart the history is gone, while a
 * restore that was interrupted is recovered from its on-disk journal.
 */
import crypto from 'crypto';

export type BackupJobType = 'restore' | 'native-restore' | 'native-create' | 'world-restore';
export type BackupJobState = 'running' | 'succeeded' | 'failed';

export interface BackupJob {
  id: string;
  type: BackupJobType;
  serverId: string | null;
  target: string; // backup id / native file the job works on
  state: BackupJobState;
  /** Current step, e.g. 'validating', 'extracting', 'stopping', 'safety-backup', 'swapping'. */
  step: string;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string | null;
  message: string | null;
  error: string | null;
}

export interface JobControl {
  setStep(step: string): void;
}

const MAX_FINISHED_JOBS = 20;
const jobs = new Map<string, BackupJob>();
const completions = new Map<string, Promise<BackupJob>>();

function pruneFinished(): void {
  const finished = [...jobs.values()].filter((j) => j.state !== 'running');
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    jobs.delete(job.id);
    completions.delete(job.id);
  }
}

export function getBackupJob(id: string): BackupJob | null {
  const job = jobs.get(id);
  return job ? { ...job } : null;
}

/** Newest first. */
export function listBackupJobs(): BackupJob[] {
  return [...jobs.values()].reverse().map((j) => ({ ...j }));
}

export function runningBackupJob(): BackupJob | null {
  const job = [...jobs.values()].find((j) => j.state === 'running');
  return job ? { ...job } : null;
}

/** Resolves with the final job once it has finished (never rejects). */
export function waitForBackupJob(id: string): Promise<BackupJob> | null {
  return completions.get(id) ?? null;
}

/**
 * Register a job and run `work` in the background. `work` resolves with the
 * success message; a throw or `{ error }` marks the job failed.
 */
export function startBackupJob(
  init: { type: BackupJobType; serverId?: string; target: string; startedBy?: string },
  work: (control: JobControl) => Promise<{ message?: string; error?: string }>,
): BackupJob {
  const job: BackupJob = {
    id: crypto.randomUUID(),
    type: init.type,
    serverId: init.serverId ?? null,
    target: init.target,
    state: 'running',
    step: 'queued',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    startedBy: init.startedBy ?? null,
    message: null,
    error: null,
  };
  jobs.set(job.id, job);
  pruneFinished();
  const control: JobControl = {
    setStep(step) {
      job.step = step;
    },
  };
  const done = (async () => {
    try {
      const result = await work(control);
      if (result.error) {
        job.state = 'failed';
        job.error = result.error;
      } else {
        job.state = 'succeeded';
        job.message = result.message ?? null;
      }
    } catch (err) {
      job.state = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    }
    job.step = 'done';
    job.finishedAt = new Date().toISOString();
    return { ...job };
  })();
  completions.set(job.id, done);
  return { ...job };
}
