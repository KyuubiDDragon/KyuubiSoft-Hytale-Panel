import api from './client'

// ============== WHITELIST ==============

export interface WhitelistData {
  enabled: boolean
  list: string[]
}

export const whitelistApi = {
  async get(): Promise<WhitelistData> {
    const response = await api.get<WhitelistData>('/management/whitelist')
    return response.data
  },

  async setEnabled(enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
    const response = await api.put<{ success: boolean; enabled: boolean }>('/management/whitelist/enabled', { enabled })
    return response.data
  },

  async addPlayer(player: string): Promise<{ success: boolean; list: string[] }> {
    const response = await api.post<{ success: boolean; list: string[] }>('/management/whitelist/add', { player })
    return response.data
  },

  async removePlayer(player: string): Promise<{ success: boolean; list: string[] }> {
    const response = await api.delete<{ success: boolean; list: string[] }>(`/management/whitelist/${encodeURIComponent(player)}`)
    return response.data
  },
}

// ============== BANS ==============

export interface BanEntry {
  player: string
  target?: string // UUID from Hytale
  reason?: string
  bannedAt: string
  bannedBy?: string
}

export const bansApi = {
  async get(): Promise<{ bans: BanEntry[] }> {
    const response = await api.get<{ bans: BanEntry[] }>('/management/bans')
    return response.data
  },

  async add(player: string, reason?: string): Promise<{ success: boolean; bans: BanEntry[] }> {
    const response = await api.post<{ success: boolean; bans: BanEntry[] }>('/management/bans/add', { player, reason })
    return response.data
  },

  async remove(player: string): Promise<{ success: boolean; bans: BanEntry[] }> {
    const response = await api.delete<{ success: boolean; bans: BanEntry[] }>(`/management/bans/${encodeURIComponent(player)}`)
    return response.data
  },
}

// ============== PERMISSIONS ==============

export interface PermissionGroup {
  name: string
  permissions: string[]
  inherits?: string[]
}

export interface PermissionUser {
  uuid: string
  name: string
  groups: string[]
}

export interface PermissionsData {
  users: PermissionUser[]
  groups: PermissionGroup[]
  availablePermissions?: { name: string; description?: string }[]
}

export const permissionsApi = {
  async get(): Promise<PermissionsData> {
    const response = await api.get<PermissionsData>('/management/permissions')
    return response.data
  },

  async addUser(name: string, groups: string[]): Promise<{ success: boolean; users: PermissionUser[] }> {
    const response = await api.post<{ success: boolean; users: PermissionUser[] }>('/management/permissions/users', { name, groups })
    return response.data
  },

  async removeUser(name: string): Promise<{ success: boolean; users: PermissionUser[] }> {
    const response = await api.delete<{ success: boolean; users: PermissionUser[] }>(`/management/permissions/users/${encodeURIComponent(name)}`)
    return response.data
  },

  async addGroup(name: string, permissions: string[], inherits?: string[]): Promise<{ success: boolean; groups: PermissionGroup[] }> {
    const response = await api.post<{ success: boolean; groups: PermissionGroup[] }>('/management/permissions/groups', { name, permissions, inherits })
    return response.data
  },

  async removeGroup(name: string): Promise<{ success: boolean; groups: PermissionGroup[] }> {
    const response = await api.delete<{ success: boolean; groups: PermissionGroup[] }>(`/management/permissions/groups/${encodeURIComponent(name)}`)
    return response.data
  },
}

// ============== WORLDS ==============

export interface WorldInfo {
  name: string
  hasConfig: boolean
}

export interface WorldClientEffects {
  sunHeightPercent?: number
  sunAngleDegrees?: number
  bloomIntensity?: number
  bloomPower?: number
  sunIntensity?: number
  sunshaftIntensity?: number
  sunshaftScaleFactor?: number
}

export interface WorldConfig {
  name: string
  displayName?: string
  seed?: number
  isTicking: boolean
  isBlockTicking: boolean
  isPvpEnabled: boolean
  isFallDamageEnabled: boolean
  isGameTimePaused: boolean
  gameTime?: string
  isSpawningNPC: boolean
  isAllNPCFrozen: boolean
  isSpawnMarkersEnabled: boolean
  isObjectiveMarkersEnabled: boolean
  isSavingPlayers: boolean
  isSavingChunks: boolean
  saveNewChunks: boolean
  isUnloadingChunks: boolean
  daytimeDurationSecondsOverride?: number | null
  nighttimeDurationSecondsOverride?: number | null
  clientEffects?: WorldClientEffects
  raw?: Record<string, unknown>
}

export const worldsApi = {
  async get(): Promise<{ worlds: WorldInfo[] }> {
    const response = await api.get<{ worlds: WorldInfo[] }>('/management/worlds')
    return response.data
  },

  async getConfig(worldName: string): Promise<WorldConfig> {
    const response = await api.get<WorldConfig>(`/management/worlds/${encodeURIComponent(worldName)}/config`)
    return response.data
  },

  async updateConfig(worldName: string, updates: Partial<WorldConfig>): Promise<{ success: boolean; message?: string }> {
    const response = await api.put<{ success: boolean; message?: string }>(`/management/worlds/${encodeURIComponent(worldName)}/config`, updates)
    return response.data
  },
}

// ============== MODS & PLUGINS ==============

export interface ModInfo {
  name: string
  filename: string
  size: number
  lastModified: string
  enabled: boolean
}

export interface ConfigFile {
  name: string
  path: string
}

export const modsApi = {
  async get(): Promise<{ mods: ModInfo[]; path: string }> {
    const response = await api.get<{ mods: ModInfo[]; path: string }>('/management/mods')
    return response.data
  },

  async toggle(filename: string): Promise<{ success: boolean }> {
    const response = await api.put<{ success: boolean }>(`/management/mods/${encodeURIComponent(filename)}/toggle`)
    return response.data
  },

  async upload(file: File): Promise<{ success: boolean; filename: string; size: number }> {
    const formData = new FormData()
    formData.append('file', file)
    const response = await api.post<{ success: boolean; filename: string; size: number }>('/management/mods/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response.data
  },

  async delete(filename: string): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>(`/management/mods/${encodeURIComponent(filename)}`)
    return response.data
  },

  async getConfigs(filename: string): Promise<{ configs: ConfigFile[] }> {
    const response = await api.get<{ configs: ConfigFile[] }>(`/management/mods/${encodeURIComponent(filename)}/configs`)
    return response.data
  },
}

export const pluginsApi = {
  async get(): Promise<{ plugins: ModInfo[]; path: string }> {
    const response = await api.get<{ plugins: ModInfo[]; path: string }>('/management/plugins')
    return response.data
  },

  async toggle(filename: string): Promise<{ success: boolean }> {
    const response = await api.put<{ success: boolean }>(`/management/plugins/${encodeURIComponent(filename)}/toggle`)
    return response.data
  },

  async upload(file: File): Promise<{ success: boolean; filename: string; size: number }> {
    const formData = new FormData()
    formData.append('file', file)
    const response = await api.post<{ success: boolean; filename: string; size: number }>('/management/plugins/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response.data
  },

  async delete(filename: string): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>(`/management/plugins/${encodeURIComponent(filename)}`)
    return response.data
  },

  async getConfigs(filename: string): Promise<{ configs: ConfigFile[] }> {
    const response = await api.get<{ configs: ConfigFile[] }>(`/management/plugins/${encodeURIComponent(filename)}/configs`)
    return response.data
  },
}

export const configApi = {
  async read(path: string): Promise<{ content: string; path: string }> {
    const response = await api.get<{ content: string; path: string }>('/management/config/read', { params: { path } })
    return response.data
  },

  async write(path: string, content: string): Promise<{ success: boolean }> {
    const response = await api.put<{ success: boolean }>('/management/config/write', { path, content })
    return response.data
  },
}

// ============== STATS HISTORY ==============

export interface StatsEntry {
  timestamp: string
  cpu: number
  memory: number
  players: number
}

export const statsApi = {
  async getHistory(): Promise<{ history: StatsEntry[] }> {
    const response = await api.get<{ history: StatsEntry[] }>('/management/stats/history')
    return response.data
  },
}

// ============== ACTIVITY LOG ==============

export interface ActivityLogEntry {
  id: string
  timestamp: string
  user: string
  action: string
  target?: string
  details?: string
  category: 'player' | 'server' | 'backup' | 'config' | 'mod' | 'user' | 'system'
  success: boolean
}

export const activityApi = {
  async get(options?: { limit?: number; offset?: number; category?: string; user?: string }): Promise<{ entries: ActivityLogEntry[]; total: number }> {
    const response = await api.get<{ entries: ActivityLogEntry[]; total: number }>('/management/activity', { params: options })
    return response.data
  },

  async clear(): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>('/management/activity')
    return response.data
  },
}

// ============== MOD STORE ==============

export interface ModStoreEntry {
  id: string
  name: string
  description: string
  author: string
  github: string
  category: 'map' | 'utility' | 'gameplay' | 'admin' | 'other'
  installed: boolean
  installedFilename?: string
  installedVersion?: string
  latestVersion?: string
  hasUpdate?: boolean
  configPath?: string
  ports?: { name: string; default: number; env: string }[]
}

export interface ModReleaseInfo {
  version: string
  name: string
  publishedAt: string
  assets: { name: string; size: number }[]
}

export interface InstallResult {
  success: boolean
  error?: string
  filename?: string
  version?: string
  configCreated?: boolean
}

export const modStoreApi = {
  async getAvailable(): Promise<{ mods: ModStoreEntry[] }> {
    const response = await api.get<{ mods: ModStoreEntry[] }>('/management/modstore')
    return response.data
  },

  async getRelease(modId: string): Promise<ModReleaseInfo> {
    const response = await api.get<ModReleaseInfo>(`/management/modstore/${modId}/release`)
    return response.data
  },

  async install(modId: string): Promise<InstallResult> {
    const response = await api.post<InstallResult>(`/management/modstore/${modId}/install`)
    return response.data
  },

  async uninstall(modId: string): Promise<{ success: boolean; error?: string }> {
    const response = await api.delete<{ success: boolean; error?: string }>(`/management/modstore/${modId}/uninstall`)
    return response.data
  },

  async update(modId: string): Promise<InstallResult> {
    const response = await api.post<InstallResult>(`/management/modstore/${modId}/update`)
    return response.data
  },
}
