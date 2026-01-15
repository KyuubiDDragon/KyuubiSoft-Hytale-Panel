import api from './client'

export interface ServerStatus {
  status: string
  running: boolean
  id?: string
  name?: string
  created?: string
  started_at?: string
  error?: string
}

export interface ServerStats {
  cpu_percent?: number
  memory_bytes?: number
  memory_limit_bytes?: number
  memory_percent?: number
  memory_mb?: number
  memory_limit_mb?: number
  error?: string
}

export interface ActionResponse {
  success: boolean
  message?: string
  error?: string
}

export interface ServerMemoryStats {
  available: boolean
  physical?: {
    total: number | null
    free: number | null
  }
  swap?: {
    total: number | null
    free: number | null
  }
  heap?: {
    init: number | null
    used: number | null
    committed: number | null
    max: number | null
  }
  raw?: string
  error?: string
}

export interface ConfigFile {
  name: string
  size: number
  modified: string | null
}

export interface ConfigFilesResponse {
  files: ConfigFile[]
}

export interface ConfigContentResponse {
  filename: string
  content: string
}

export interface QuickSettings {
  serverName: string
  motd: string
  password: string
  maxPlayers: number
  maxViewRadius: number
  defaultGameMode: string
}

export interface UpdateCheckResponse {
  installedVersion: string
  latestVersion: string
  updateAvailable: boolean
  message: string
}

export const serverApi = {
  async getStatus(): Promise<ServerStatus> {
    const response = await api.get<ServerStatus>('/server/status')
    return response.data
  },

  async getStats(): Promise<ServerStats> {
    const response = await api.get<ServerStats>('/server/stats')
    return response.data
  },

  async getMemoryStats(): Promise<ServerMemoryStats> {
    const response = await api.get<ServerMemoryStats>('/server/memory')
    return response.data
  },

  async start(): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>('/server/start')
    return response.data
  },

  async stop(): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>('/server/stop')
    return response.data
  },

  async restart(): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>('/server/restart')
    return response.data
  },

  async getConfigFiles(): Promise<ConfigFilesResponse> {
    const response = await api.get<ConfigFilesResponse>('/server/config/files')
    return response.data
  },

  async getConfigContent(filename: string): Promise<ConfigContentResponse> {
    const response = await api.get<ConfigContentResponse>(`/server/config/${encodeURIComponent(filename)}`)
    return response.data
  },

  async saveConfigContent(filename: string, content: string): Promise<ActionResponse> {
    const response = await api.put<ActionResponse>(`/server/config/${encodeURIComponent(filename)}`, { content })
    return response.data
  },

  async getQuickSettings(): Promise<QuickSettings> {
    const response = await api.get<QuickSettings>('/server/quick-settings')
    return response.data
  },

  async saveQuickSettings(settings: Partial<QuickSettings>): Promise<ActionResponse> {
    const response = await api.put<ActionResponse>('/server/quick-settings', settings)
    return response.data
  },

  async checkForUpdates(): Promise<UpdateCheckResponse> {
    const response = await api.get<UpdateCheckResponse>('/server/check-update')
    return response.data
  },
}
