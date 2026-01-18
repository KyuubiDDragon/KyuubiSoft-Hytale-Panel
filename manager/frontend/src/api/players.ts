import api from './client'

export interface PlayerInfo {
  name: string
  joined_at: string
  session_duration_seconds: number
  session_duration: string
}

export interface PlayerHistoryEntry {
  name: string
  uuid?: string
  firstSeen: string
  lastSeen: string
  playTime: number // Total playtime in seconds
  sessionCount: number
}

// Unified player entry from JSON files with online status
export interface UnifiedPlayerEntry {
  name: string
  uuid: string
  online: boolean
  world?: string
  gameMode?: string
  position?: { x: number; y: number; z: number }
  health?: number
  maxHealth?: number
  lastSeen?: string
  playTime?: number
  sessionCount?: number
}

export interface PlayersResponse {
  players: PlayerInfo[]
  count: number
}

export interface UnifiedPlayersResponse {
  players: UnifiedPlayerEntry[]
  count: number
  onlineCount: number
}

export interface PlayerHistoryResponse {
  players: PlayerHistoryEntry[]
  count: number
}

export interface ActionResponse {
  success: boolean
  message?: string
  error?: string
}

export interface DeathPosition {
  id: string
  timestamp: string
  player: string
  world: string
  x: number
  y: number
  z: number
}

export interface DeathPositionResponse {
  success: boolean
  player: string
  position?: DeathPosition
  error?: string
}

export const playersApi = {
  async getOnline(): Promise<PlayersResponse> {
    const response = await api.get<PlayersResponse>('/players')
    return response.data
  },

  async getCount(): Promise<{ count: number }> {
    const response = await api.get<{ count: number }>('/players/count')
    return response.data
  },

  async getHistory(): Promise<PlayerHistoryResponse> {
    const response = await api.get<PlayerHistoryResponse>('/players/history')
    return response.data
  },

  async getOffline(): Promise<PlayerHistoryResponse> {
    const response = await api.get<PlayerHistoryResponse>('/players/offline')
    return response.data
  },

  async getAll(): Promise<UnifiedPlayersResponse> {
    const response = await api.get<UnifiedPlayersResponse>('/players/all')
    return response.data
  },

  async kick(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/kick`)
    return response.data
  },

  async ban(playerName: string, reason?: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/ban`, { reason })
    return response.data
  },

  async unban(playerName: string): Promise<ActionResponse> {
    const response = await api.delete<ActionResponse>(`/players/${playerName}/ban`)
    return response.data
  },

  async addToWhitelist(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/whitelist`)
    return response.data
  },

  async removeFromWhitelist(playerName: string): Promise<ActionResponse> {
    const response = await api.delete<ActionResponse>(`/players/${playerName}/whitelist`)
    return response.data
  },

  async op(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/op`)
    return response.data
  },

  async deop(playerName: string): Promise<ActionResponse> {
    const response = await api.delete<ActionResponse>(`/players/${playerName}/op`)
    return response.data
  },

  async sendMessage(playerName: string, message: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/message`, { message })
    return response.data
  },

  async teleport(playerName: string, options: { target?: string; x?: number; y?: number; z?: number }): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/teleport`, options)
    return response.data
  },

  async kill(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/kill`)
    return response.data
  },

  async respawn(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/respawn`)
    return response.data
  },

  async gamemode(playerName: string, gamemode: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/gamemode`, { gamemode })
    return response.data
  },

  async give(playerName: string, item: string, amount?: number): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/give`, { item, amount })
    return response.data
  },

  async heal(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/heal`)
    return response.data
  },

  async clearEffects(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/effect`, { effect: 'all', action: 'clear' })
    return response.data
  },

  async clearInventory(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/inventory/clear`)
    return response.data
  },

  async getLastDeathPosition(playerName: string): Promise<DeathPositionResponse> {
    const response = await api.get<DeathPositionResponse>(`/players/${playerName}/deaths/last`)
    return response.data
  },

  async teleportToDeath(playerName: string): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>(`/players/${playerName}/teleport/death`)
    return response.data
  },
}
