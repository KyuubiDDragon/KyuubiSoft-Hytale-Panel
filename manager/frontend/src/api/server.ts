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

// KyuubiSoft API Plugin interfaces
export interface PluginStatus {
  installed: boolean
  running: boolean
  version: string | null
  port: number
  error?: string
}

export interface PluginUpdateCheck {
  available: boolean
  currentVersion: string | null
  latestVersion: string
}

export interface PluginInstallResponse {
  success: boolean
  message?: string
  version?: string
  error?: string
}

// Plugin API data interfaces
export interface PluginServerInfo {
  version: string
  patchline: string
  onlinePlayers: number
  maxPlayers: number
  worldCount: number
  uptimeSeconds: number
  startedAt: string
  tps: number
  mspt: number
}

export interface PluginPlayer {
  uuid: string
  name: string
  position?: { x: number; y: number; z: number }
  world?: string
  health?: number
  gameMode?: string
  ping?: number
  joinedAt?: string
}

export interface PluginPlayersResponse {
  players: PluginPlayer[]
  count: number
}

export interface PluginMemoryInfo {
  heapUsed: number
  heapMax: number
  heapFree: number
  heapUsagePercent: number
}

export interface PluginApiResponse<T> {
  success: boolean
  data?: T
  error?: string
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

  // KyuubiSoft API Plugin methods
  async getPluginStatus(): Promise<PluginStatus> {
    const response = await api.get<PluginStatus>('/server/plugin/status')
    return response.data
  },

  async checkPluginUpdate(): Promise<PluginUpdateCheck> {
    const response = await api.get<PluginUpdateCheck>('/server/plugin/update-check')
    return response.data
  },

  async installPlugin(): Promise<PluginInstallResponse> {
    const response = await api.post<PluginInstallResponse>('/server/plugin/install')
    return response.data
  },

  async uninstallPlugin(): Promise<PluginInstallResponse> {
    const response = await api.delete<PluginInstallResponse>('/server/plugin/uninstall')
    return response.data
  },

  // Plugin API data methods
  async getPluginServerInfo(): Promise<PluginApiResponse<PluginServerInfo>> {
    const response = await api.get<PluginApiResponse<PluginServerInfo>>('/server/plugin/info')
    return response.data
  },

  async getPluginPlayers(): Promise<PluginApiResponse<PluginPlayersResponse>> {
    const response = await api.get<PluginApiResponse<PluginPlayersResponse>>('/server/plugin/players')
    return response.data
  },

  async getPluginMemory(): Promise<PluginApiResponse<PluginMemoryInfo>> {
    const response = await api.get<PluginApiResponse<PluginMemoryInfo>>('/server/plugin/memory')
    return response.data
  },
}
