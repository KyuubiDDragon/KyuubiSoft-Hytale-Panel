import api from './client'

// Extended timeout for long-running backup operations (30 minutes)
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
  backup?: BackupInfo
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
    const response = await api.post<ActionResponse>('/backups', { name }, {
      timeout: BACKUP_TIMEOUT,
    })
    return response.data
  },

  async delete(backupId: string): Promise<ActionResponse> {
    const response = await api.delete<ActionResponse>(`/backups/${backupId}`)
    return response.data
  },

  async restore(backupId: string): Promise<ActionResponse> {
    // Use extended timeout for backup restoration (can take 30+ minutes for large backups)
    const response = await api.post<ActionResponse>(`/backups/${backupId}/restore`, {}, {
      timeout: BACKUP_TIMEOUT,
    })
    return response.data
  },

  getDownloadUrl(backupId: string): string {
    return `/api/backups/${backupId}/download`
  },

  async download(backupId: string): Promise<{ blob: Blob; filename: string }> {
    const response = await api.get(`/backups/${backupId}/download`, {
      responseType: 'blob',
      timeout: BACKUP_TIMEOUT,
    })

    // Extract filename from Content-Disposition header or use default
    const contentDisposition = response.headers['content-disposition']
    let filename = `backup-${backupId}.tar.gz`
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^";\n]+)"?/)
      if (match) {
        filename = match[1]
      }
    }

    return { blob: response.data, filename }
  },
}
