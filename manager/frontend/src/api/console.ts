import api from './client'

export interface LogEntry {
  timestamp: string
  level: string
  message: string
  raw?: string
}

export interface LogsResponse {
  logs: LogEntry[]
  count: number
}

export interface CommandResponse {
  success: boolean
  command: string
  output?: string
  error?: string
}

export const consoleApi = {
  async getLogs(tail: number = 100): Promise<LogsResponse> {
    const response = await api.get<LogsResponse>('/console/logs', {
      params: { tail },
    })
    return response.data
  },

  async sendCommand(command: string): Promise<CommandResponse> {
    const response = await api.post<CommandResponse>('/console/command', {
      command,
    })
    return response.data
  },
}
