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
  patchline?: string
  versions?: {
    release: string
    preRelease: string
  }
  message: string
}

export interface PatchlineResponse {
  patchline: string
  options: string[]
}

export interface PatchlineUpdateResponse {
  success: boolean
  patchline: string
  changed?: boolean
  message: string
}

export interface AcceptEarlyPluginsResponse {
  acceptEarlyPlugins: boolean
}

export interface AcceptEarlyPluginsUpdateResponse {
  success: boolean
  acceptEarlyPlugins: boolean
  changed?: boolean
  message: string
}

export interface DisableSentryResponse {
  disableSentry: boolean
}

export interface DisableSentryUpdateResponse {
  success: boolean
  disableSentry: boolean
  changed?: boolean
  message: string
}

export interface AllowOpResponse {
  allowOp: boolean
}

export interface AllowOpUpdateResponse {
  success: boolean
  allowOp: boolean
  changed?: boolean
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

// Extended TPS metrics from Prometheus endpoint
export interface PluginTpsMetrics {
  current: number
  average: number
  min: number
  max: number
  target: number
  msptCurrent: number
  msptAverage: number
}

// Prometheus metrics response
export interface PrometheusMetrics {
  raw: string
  parsed?: {
    tps: PluginTpsMetrics
    players: {
      online: number
      max: number
      joins: number
      leaves: number
    }
    memory: {
      heapUsed: number
      heapMax: number
      heapPercent: number
    }
    cpu: {
      process: number
      system: number
    }
    uptime: number
    threads: number
  }
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

// Player detail interfaces
export interface PluginPlayerDetails {
  uuid: string
  name: string
  world?: string
  position?: { x: number; y: number; z: number }
  yaw?: number
  pitch?: number
  gamemode?: string
  health?: number
  maxHealth?: number
}

export interface PluginInventoryItem {
  slot: number
  itemId: string
  displayName?: string
  amount: number
  durability?: number
  maxDurability?: number
  enchantments?: string[]
  nbt?: Record<string, unknown>
}

export interface PluginPlayerInventory {
  uuid: string
  name: string
  items: PluginInventoryItem[]
  totalSlots: number
  usedSlots: number
}

export interface PluginAppearanceCustomization {
  hairStyle?: string
  hairColor?: string
  eyeColor?: string
  skinTone?: string
  bodyType?: string
  accessories?: string[]
  colors?: Record<string, string>
}

export interface PluginPlayerAppearance {
  uuid: string
  name: string
  skinId?: string
  skinUrl?: string
  modelType?: string
  capeId?: string
  capeUrl?: string
  customization?: PluginAppearanceCustomization
}

// File-based player data interfaces (from server/universe/players/)
export interface FileInventoryItem {
  slot: number
  itemId: string
  displayName: string
  amount: number
  durability: number
  maxDurability: number
}

export interface FilePlayerInventory {
  uuid: string
  name: string
  storage: FileInventoryItem[]
  armor: FileInventoryItem[]
  hotbar: FileInventoryItem[]
  utility: FileInventoryItem[]
  backpack: FileInventoryItem[]
  tools: FileInventoryItem[]
  activeHotbarSlot: number
  totalSlots: number
  usedSlots: number
}

export interface FilePlayerStats {
  health: number
  maxHealth: number
  stamina: number
  maxStamina: number
  oxygen: number
  mana: number
  immunity: number
}

export interface FilePlayerDetails {
  uuid: string
  name: string
  world: string
  gameMode: string
  position: { x: number; y: number; z: number } | null
  rotation: { pitch: number; yaw: number; roll: number } | null
  stats: FilePlayerStats
  discoveredZones: string[]
  memoriesCount: number
  uniqueItemsUsed: string[]
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

  async getPatchline(): Promise<PatchlineResponse> {
    const response = await api.get<PatchlineResponse>('/server/patchline')
    return response.data
  },

  async setPatchline(patchline: string): Promise<PatchlineUpdateResponse> {
    const response = await api.put<PatchlineUpdateResponse>('/server/patchline', { patchline })
    return response.data
  },

  async getAcceptEarlyPlugins(): Promise<AcceptEarlyPluginsResponse> {
    const response = await api.get<AcceptEarlyPluginsResponse>('/server/accept-early-plugins')
    return response.data
  },

  async setAcceptEarlyPlugins(acceptEarlyPlugins: boolean): Promise<AcceptEarlyPluginsUpdateResponse> {
    const response = await api.put<AcceptEarlyPluginsUpdateResponse>('/server/accept-early-plugins', { acceptEarlyPlugins })
    return response.data
  },

  async getDisableSentry(): Promise<DisableSentryResponse> {
    const response = await api.get<DisableSentryResponse>('/server/disable-sentry')
    return response.data
  },

  async setDisableSentry(disableSentry: boolean): Promise<DisableSentryUpdateResponse> {
    const response = await api.put<DisableSentryUpdateResponse>('/server/disable-sentry', { disableSentry })
    return response.data
  },

  async getAllowOp(): Promise<AllowOpResponse> {
    const response = await api.get<AllowOpResponse>('/server/allow-op')
    return response.data
  },

  async setAllowOp(allowOp: boolean): Promise<AllowOpUpdateResponse> {
    const response = await api.put<AllowOpUpdateResponse>('/server/allow-op', { allowOp })
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

  async getPluginPrometheusMetrics(): Promise<PluginApiResponse<PrometheusMetrics>> {
    const response = await api.get<PluginApiResponse<PrometheusMetrics>>('/server/plugin/metrics')
    return response.data
  },

  async getPluginTpsMetrics(): Promise<PluginApiResponse<PluginTpsMetrics>> {
    const response = await api.get<PluginApiResponse<PluginTpsMetrics>>('/server/plugin/tps')
    return response.data
  },

  // Player detail methods
  async getPluginPlayerDetails(playerName: string): Promise<PluginApiResponse<PluginPlayerDetails>> {
    const response = await api.get<PluginApiResponse<PluginPlayerDetails>>(`/server/plugin/players/${encodeURIComponent(playerName)}/details`)
    return response.data
  },

  async getPluginPlayerInventory(playerName: string): Promise<PluginApiResponse<PluginPlayerInventory>> {
    const response = await api.get<PluginApiResponse<PluginPlayerInventory>>(`/server/plugin/players/${encodeURIComponent(playerName)}/inventory`)
    return response.data
  },

  async getPluginPlayerAppearance(playerName: string): Promise<PluginApiResponse<PluginPlayerAppearance>> {
    const response = await api.get<PluginApiResponse<PluginPlayerAppearance>>(`/server/plugin/players/${encodeURIComponent(playerName)}/appearance`)
    return response.data
  },

  // File-based player data methods (reads from server/universe/players/)
  async getFilePlayerDetails(playerName: string): Promise<PluginApiResponse<FilePlayerDetails>> {
    const response = await api.get<PluginApiResponse<FilePlayerDetails>>(`/server/players/${encodeURIComponent(playerName)}/file/details`)
    return response.data
  },

  async getFilePlayerInventory(playerName: string): Promise<PluginApiResponse<FilePlayerInventory>> {
    const response = await api.get<PluginApiResponse<FilePlayerInventory>>(`/server/players/${encodeURIComponent(playerName)}/file/inventory`)
    return response.data
  },
}
