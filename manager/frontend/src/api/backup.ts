import api from './client'

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
    const response = await api.post<ActionResponse>('/backups', { name })
    return response.data
  },

  async delete(backupId: string): Promise<ActionResponse> {
    const response = await api.delete<ActionResponse>(`/backups/${backupId}`)
    return response.data
  },

  async restore(backupId: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/backups/${backupId}/restore`)
    return response.data
  },

  getDownloadUrl(backupId: string): string {
    return `/api/backups/${backupId}/download`
  },
}
