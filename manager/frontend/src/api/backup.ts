import api from './client'

// Extended timeout for long-running backup requests (creation, downloads: 30 minutes).
// Restores and native backups run as jobs on the server and are polled instead.
const BACKUP_TIMEOUT = 30 * 60 * 1000

export interface BackupInfo {
  id: string
  filename: string
  size_bytes: number
  size_mb: number
  created_at: string
  type: 'manual' | 'auto'
}

export interface StorageInfo {
  total_size_bytes: number
  total_size_mb: number
  backup_count: number
}

export interface BackupListResponse {
  backups: BackupInfo[]
  storage: StorageInfo
}

export interface ActionResponse {
  success: boolean
  message?: string
  error?: string
  /** Backup created, but e.g. the running server did not confirm the world save. */
  warning?: string
  backup?: BackupInfo
}

export type BackupJobType = 'restore' | 'native-restore' | 'native-create' | 'world-restore'

/** A long backup operation running in the background (restore, native backup). */
export interface BackupJob {
  id: string
  type: BackupJobType
  serverId: string | null
  target: string
  state: 'running' | 'succeeded' | 'failed'
  step: string
  startedAt: string
  finishedAt: string | null
  startedBy: string | null
  message: string | null
  error: string | null
}

export interface JobStartResponse {
  success: boolean
  message?: string
  error?: string
  job?: BackupJob
}

export type NativeBackupScope = 'recent' | 'archive'

/** A zip written by the game server itself (`/backup`). */
export interface NativeBackupInfo {
  name: string
  scope: NativeBackupScope
  size_bytes: number
  size_mb: number
  created_at: string
}

export interface NativeBackupList {
  directory: string
  available: boolean
  inProgress: boolean
  backups: NativeBackupInfo[]
}

function nativePath(backup: Pick<NativeBackupInfo, 'scope' | 'name'>): string {
  return `/backups/native/${backup.scope}/${encodeURIComponent(backup.name)}`
}

async function downloadBlob(
  url: string,
  fallbackName: string,
): Promise<{ blob: Blob; filename: string }> {
  const response = await api.get(url, { responseType: 'blob', timeout: BACKUP_TIMEOUT })
  // Extract filename from Content-Disposition header or use default
  const contentDisposition = response.headers['content-disposition']
  let filename = fallbackName
  if (contentDisposition) {
    const match = contentDisposition.match(/filename="?([^";\n]+)"?/)
    if (match) {
      filename = match[1]
    }
  }
  return { blob: response.data, filename }
}

export const backupApi = {
  async list(): Promise<BackupListResponse> {
    const response = await api.get<BackupListResponse>('/backups')
    return response.data
  },

  async get(backupId: string): Promise<BackupInfo> {
    const response = await api.get<BackupInfo>(`/backups/${backupId}`)
    return response.data
  },

  async create(name?: string): Promise<ActionResponse> {
    // Use extended timeout for backup creation (can take 30+ minutes for large servers)
    const response = await api.post<ActionResponse>(
      '/backups',
      { name },
      {
        timeout: BACKUP_TIMEOUT,
      },
    )
    return response.data
  },

  async delete(backupId: string): Promise<ActionResponse> {
    const response = await api.delete<ActionResponse>(`/backups/${backupId}`)
    return response.data
  },

  /** Starts a restore job; poll it with getJob(). */
  async restore(backupId: string): Promise<JobStartResponse> {
    const response = await api.post<JobStartResponse>(`/backups/${backupId}/restore`, {})
    return response.data
  },

  getDownloadUrl(backupId: string): string {
    return `/api/backups/${backupId}/download`
  },

  async download(backupId: string): Promise<{ blob: Blob; filename: string }> {
    return downloadBlob(`/backups/${backupId}/download`, `backup-${backupId}.tar.gz`)
  },

  async getJob(jobId: string): Promise<BackupJob> {
    const response = await api.get<BackupJob>(`/backups/jobs/${encodeURIComponent(jobId)}`)
    return response.data
  },

  async listJobs(): Promise<{ jobs: BackupJob[]; running: BackupJob | null }> {
    const response = await api.get<{ jobs: BackupJob[]; running: BackupJob | null }>(
      '/backups/jobs',
    )
    return response.data
  },

  // ----- Native (server-written) backups -----

  async listNative(): Promise<NativeBackupList> {
    const response = await api.get<NativeBackupList>('/backups/native')
    return response.data
  },

  /** Asks the running server for a backup (`/backup`); returns a job. */
  async createNative(): Promise<JobStartResponse> {
    const response = await api.post<JobStartResponse>('/backups/native', {})
    return response.data
  },

  async deleteNative(backup: NativeBackupInfo): Promise<ActionResponse> {
    const response = await api.delete<ActionResponse>(nativePath(backup))
    return response.data
  },

  async restoreNative(backup: NativeBackupInfo): Promise<JobStartResponse> {
    const response = await api.post<JobStartResponse>(`${nativePath(backup)}/restore`, {})
    return response.data
  },

  async downloadNative(backup: NativeBackupInfo): Promise<{ blob: Blob; filename: string }> {
    return downloadBlob(`${nativePath(backup)}/download`, backup.name)
  },
}

const JOB_POLL_MS = 2000
const JOB_MAX_FAILED_POLLS = 5

export interface WaitForJobOptions {
  /** Sees every state, for a progress display. */
  onUpdate?: (job: BackupJob) => void
  /** Checked before every poll; returning true ends the wait (e.g. the view was left). */
  shouldStop?: () => boolean
  fetchJob?: (id: string) => Promise<BackupJob>
}

/**
 * Poll a backup job until it has finished. Resolves with the last known
 * state, which is still 'running' when the wait was stopped or a few polls
 * in a row failed (e.g. while the panel restarts).
 */
export async function waitForBackupJob(
  job: BackupJob,
  options: WaitForJobOptions = {},
): Promise<BackupJob> {
  const fetchJob = options.fetchJob ?? backupApi.getJob
  let current = job
  let failures = 0
  options.onUpdate?.(current)
  while (current.state === 'running' && !options.shouldStop?.()) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS))
    if (options.shouldStop?.()) break
    try {
      current = await fetchJob(current.id)
      failures = 0
      options.onUpdate?.(current)
    } catch {
      if (++failures >= JOB_MAX_FAILED_POLLS) break
    }
  }
  return current
}

/**
 * Error text of a failed request. A download (responseType 'blob') carries
 * its JSON error body as a Blob, which is read first.
 */
export async function requestErrorText(err: unknown, fallback: string): Promise<string> {
  let data = (err as { response?: { data?: unknown } }).response?.data
  if (data instanceof Blob) {
    try {
      data = JSON.parse(await data.text())
    } catch {
      return fallback
    }
  }
  const body = data as { error?: string; detail?: string } | undefined
  return body?.error || body?.detail || fallback
}
