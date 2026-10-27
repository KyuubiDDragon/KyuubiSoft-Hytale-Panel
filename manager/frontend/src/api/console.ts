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

/** How a command ended; only known when the KyuubiSoft API plugin ran it. */
export type CommandStatus = 'DONE' | 'RUNNING' | 'NOT_FOUND' | 'REJECTED' | 'FAILED'

export interface CommandResponse {
  success: boolean
  command: string
  output?: string
  /** The server's answer, line by line (plugin only). */
  lines?: string[]
  status?: CommandStatus
  /** 'plugin': real answer; 'stdin': only written to the console. */
  via?: 'plugin' | 'stdin' | 'demo'
  error?: string
}

export interface CommandArg {
  name: string
  type?: string
  description?: string
}

export interface CommandOption extends CommandArg {
  kind: 'optional' | 'default' | 'flag'
  permission?: string
  aliases?: string[]
  defaultValue?: string
}

export interface CommandNode {
  name: string
  aliases?: string[]
  description?: string
  permission?: string
  owner?: string
  builtin?: boolean
  usage?: string
  requiredArgs?: CommandArg[]
  optionalArgs?: CommandOption[]
  variants?: { usage: string; description?: string; requiredArgs?: CommandArg[] }[]
  subcommands?: CommandNode[]
  /** Root commands only: what the panel's whitelist does with it. */
  panel?: { allowed: boolean; permission: 'console.execute' | 'console.execute.admin' | null }
}

export interface CommandRegistryResponse {
  available: boolean
  revision?: string
  stale?: boolean
  source?: 'plugin' | 'snapshot'
  commands: CommandNode[]
}

export interface CompletionResponse {
  available: boolean
  wordIndex?: number
  prefix?: string
  suggestions: string[]
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

  /** The server's registered commands (vanilla and mods) for autocomplete. */
  async getCommands(): Promise<CommandRegistryResponse> {
    const response = await api.get<CommandRegistryResponse>('/console/commands')
    return response.data
  },

  /** The server's own completion for the last word of `line`. */
  async complete(line: string): Promise<CompletionResponse> {
    const response = await api.get<CompletionResponse>('/console/commands/complete', {
      params: { line },
    })
    return response.data
  },
}
