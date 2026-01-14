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
  path: string
  size: number
  lastModified: string
}

export const worldsApi = {
  async get(): Promise<{ worlds: WorldInfo[] }> {
    const response = await api.get<{ worlds: WorldInfo[] }>('/management/worlds')
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
