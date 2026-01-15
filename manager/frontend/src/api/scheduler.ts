import api from './client'

export interface ScheduleConfig {
  backups: {
    enabled: boolean
    schedule: string
    retentionDays: number
    beforeRestart: boolean
  }
  announcements: {
    enabled: boolean
    welcome: string
    scheduled: ScheduledAnnouncement[]
  }
  quickCommands: QuickCommand[]
}

export interface ScheduledAnnouncement {
  id: string
  message: string
  intervalMinutes: number
  enabled: boolean
}

export interface QuickCommand {
  id: string
  name: string
  command: string
  icon: string
  category: string
}

export interface SchedulerStatus {
  backups: {
    enabled: boolean
    nextRun: string | null
    lastRun: string | null
  }
  announcements: {
    enabled: boolean
    activeCount: number
  }
}

export interface PlayerStatistics {
  totalPlayers: number
  totalPlaytime: number
  averagePlaytime: number
  averageSessionsPerPlayer: number
  topPlayers: { name: string; playTime: number; sessions: number }[]
  newPlayersLast7Days: number
  activePlayersLast7Days: number
  peakOnlineToday: number
}

export interface DailyActivity {
  date: string
  uniquePlayers: number
  totalSessions: number
}

export const schedulerApi = {
  async getConfig(): Promise<ScheduleConfig> {
    const response = await api.get<ScheduleConfig>('/scheduler/config')
    return response.data
  },

  async saveConfig(config: Partial<ScheduleConfig>): Promise<{ success: boolean }> {
    const response = await api.put('/scheduler/config', config)
    return response.data
  },

  async getStatus(): Promise<SchedulerStatus> {
    const response = await api.get<SchedulerStatus>('/scheduler/status')
    return response.data
  },

  async runBackup(): Promise<{ success: boolean; backup?: object }> {
    const response = await api.post('/scheduler/backup/run')
    return response.data
  },

  async getQuickCommands(): Promise<QuickCommand[]> {
    const response = await api.get<QuickCommand[]>('/scheduler/quick-commands')
    return response.data
  },

  async addQuickCommand(command: Omit<QuickCommand, 'id'>): Promise<QuickCommand> {
    const response = await api.post<QuickCommand>('/scheduler/quick-commands', command)
    return response.data
  },

  async updateQuickCommand(id: string, updates: Partial<QuickCommand>): Promise<{ success: boolean }> {
    const response = await api.put(`/scheduler/quick-commands/${id}`, updates)
    return response.data
  },

  async deleteQuickCommand(id: string): Promise<{ success: boolean }> {
    const response = await api.delete(`/scheduler/quick-commands/${id}`)
    return response.data
  },

  async executeQuickCommand(id: string): Promise<{ success: boolean; output?: string }> {
    const response = await api.post(`/scheduler/quick-commands/${id}/execute`)
    return response.data
  },

  async broadcast(message: string): Promise<{ success: boolean }> {
    const response = await api.post('/scheduler/broadcast', { message })
    return response.data
  },
}

export const statisticsApi = {
  async getPlayerStatistics(): Promise<PlayerStatistics> {
    const response = await api.get<PlayerStatistics>('/players/statistics')
    return response.data
  },

  async getDailyActivity(days: number = 7): Promise<DailyActivity[]> {
    const response = await api.get<DailyActivity[]>(`/players/activity?days=${days}`)
    return response.data
  },
}
