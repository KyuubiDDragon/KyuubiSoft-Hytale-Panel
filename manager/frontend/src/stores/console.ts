import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { CommandStatus } from '@/api/console'

/** The server's answer to a command typed in the console. */
export interface CommandReply {
  pending: boolean
  success?: boolean
  status?: CommandStatus
  /** 'plugin': real answer; 'stdin': only written to the console, no answer. */
  via?: 'plugin' | 'stdin' | 'demo'
  lines: string[]
  error?: string
  /** i18n key of a panel-side reason the answer is missing. */
  errorKey?: string
}

// Longer than the plugin's command deadline plus transport margin.
const REPLY_TIMEOUT_MS = 20_000

export interface LogEntry {
  id: string
  timestamp: string
  level: string
  message: string
  /** Set on a command the user sent; its answer is shown below it. */
  requestId?: string
  reply?: CommandReply
}

/**
 * Removes ANSI escape codes from text
 */
function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\[0;31m/g, '')
    .replace(/\[33m/g, '')
    .replace(/\[m/g, '')
    .replace(/\[0m/g, '')
}

export const useConsoleStore = defineStore('console', () => {
  // State
  const logs = ref<LogEntry[]>([])
  const connected = ref(false)
  const autoScroll = ref(true)
  const maxLogs = 1000
  // Update counter to force reactivity on log changes
  const updateCounter = ref(0)

  // Getters
  const logCount = computed(() => logs.value.length)
  // Computed that depends on updateCounter to ensure reactivity
  const logsUpdated = computed(() => {
    // Touch updateCounter to create dependency
    void updateCounter.value
    return logs.value.length
  })

  // Actions
  function addLog(entry: Omit<LogEntry, 'id'>) {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // Strip ANSI codes from message
    const cleanMessage = stripAnsiCodes(entry.message)

    logs.value.push({ ...entry, message: cleanMessage, id })

    // Limit log size - use splice to maintain reactivity
    if (logs.value.length > maxLogs) {
      const excess = logs.value.length - maxLogs
      logs.value.splice(0, excess)
    }

    // Increment update counter to trigger watchers
    updateCounter.value++
  }

  function addLogs(entries: Omit<LogEntry, 'id'>[]) {
    entries.forEach((entry) => addLog(entry))
  }

  /** Log a command the user sent; returns the id its answer will carry. */
  function addCommand(command: string): string {
    const requestId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    addLog({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: `> ${command}`,
      requestId,
      reply: { pending: true, lines: [] },
    })
    setTimeout(() => failPendingCommands('console.reply.noAnswer', requestId), REPLY_TIMEOUT_MS)
    return requestId
  }

  /**
   * Give up waiting for answers (connection lost, or no answer in time).
   * The command may still have run; an answer arriving later replaces this.
   */
  function failPendingCommands(errorKey: string, requestId?: string) {
    let changed = false
    const next = logs.value.map((entry) => {
      if (!entry.reply?.pending || (requestId && entry.requestId !== requestId)) return entry
      changed = true
      return { ...entry, reply: { pending: false, success: false, lines: [], errorKey } }
    })
    if (!changed) return
    logs.value = next
    updateCounter.value++
  }

  /** Attach the server's answer to the command line it belongs to. */
  function setCommandReply(requestId: string, reply: Omit<CommandReply, 'pending'>): boolean {
    for (let i = logs.value.length - 1; i >= 0; i--) {
      const entry = logs.value[i]
      if (entry.requestId === requestId) {
        logs.value.splice(i, 1, { ...entry, reply: { ...reply, pending: false } })
        updateCounter.value++
        return true
      }
    }
    return false
  }

  function clearLogs() {
    logs.value = []
  }

  function setConnected(value: boolean) {
    connected.value = value
  }

  function toggleAutoScroll() {
    autoScroll.value = !autoScroll.value
  }

  return {
    // State
    logs,
    connected,
    autoScroll,
    // Getters
    logCount,
    logsUpdated,
    // Actions
    addLog,
    addLogs,
    addCommand,
    setCommandReply,
    failPendingCommands,
    clearLogs,
    setConnected,
    toggleAutoScroll,
  }
})
