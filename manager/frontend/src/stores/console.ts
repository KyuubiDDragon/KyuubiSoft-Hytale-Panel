import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { CommandStatus, LiveLogEntry } from '@/api/console'

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
  /** The server's logger name, shown in front of the message. */
  logger?: string
  /** Set on a command the user sent; its answer is shown below it. */
  requestId?: string
  reply?: CommandReply
}

// Entries kept while following the live log, and at most after "load all".
const DEFAULT_MAX_LOGS = 1000
const MAX_LOADED_LOGS = 10_000

/**
 * Removes ANSI escape codes from text
 */
function stripAnsiCodes(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\[0;31m/g, '')
      .replace(/\[33m/g, '')
      .replace(/\[m/g, '')
      .replace(/\[0m/g, '')
  )
}

/** Nanosecond cursors are decimal strings; compare them as numbers. */
function cursorAfter(cursor: string, last: string): boolean {
  return cursor.length !== last.length ? cursor.length > last.length : cursor > last
}

export const useConsoleStore = defineStore('console', () => {
  // State
  const logs = ref<LogEntry[]>([])
  const connected = ref(false)
  const autoScroll = ref(true)
  const maxLogs = ref(DEFAULT_MAX_LOGS)
  // Newest live entry seen per stream, so a reconnect's history does not repeat entries.
  const lastCursor: Record<'stdout' | 'stderr', string | null> = { stdout: null, stderr: null }
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

  function newId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  function trim() {
    // Limit log size - use splice to maintain reactivity
    if (logs.value.length > maxLogs.value) {
      logs.value.splice(0, logs.value.length - maxLogs.value)
    }
  }

  // Actions
  function addLog(entry: Omit<LogEntry, 'id'>) {
    // Strip ANSI codes from message
    const cleanMessage = stripAnsiCodes(entry.message)
    logs.value.push({ ...entry, message: cleanMessage, id: newId() })
    trim()
    // Increment update counter to trigger watchers
    updateCounter.value++
  }

  function addLogs(entries: Omit<LogEntry, 'id'>[]) {
    if (entries.length === 0) return
    logs.value.push(
      ...entries.map((entry) => ({
        ...entry,
        message: stripAnsiCodes(entry.message),
        id: newId(),
      })),
    )
    trim()
    updateCounter.value++
  }

  /**
   * Entries of the console WebSocket, in one batch. After a reconnect the
   * server sends the end of the log again (`history`); of that, entries at or
   * before the newest one already shown of the same stream are left out.
   * Docker stamps stdout and stderr separately, so each has its own cursor.
   */
  function addServerEntries(entries: LiveLogEntry[], history = false) {
    const fresh = entries.filter((e) => {
      if (!e.cursor) return true
      const stream = e.stream ?? 'stdout'
      const last = lastCursor[stream]
      const newer = last === null || cursorAfter(e.cursor, last)
      if (newer) lastCursor[stream] = e.cursor
      return newer || !history
    })
    addLogs(
      fresh.map((e) => ({
        timestamp: e.timestamp,
        level: e.level,
        message: e.message,
        logger: e.logger,
      })),
    )
  }

  /** The view replaced by loaded entries ("load all"), keeping up to all of them. */
  function replaceLogs(entries: Omit<LogEntry, 'id'>[]) {
    maxLogs.value = Math.min(Math.max(DEFAULT_MAX_LOGS, entries.length), MAX_LOADED_LOGS)
    logs.value = []
    addLogs(entries)
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
  function failPendingCommands(
    errorKey: string,
    requestId?: string,
    keep?: (requestId: string) => boolean,
  ) {
    let changed = false
    const next = logs.value.map((entry) => {
      if (!entry.reply?.pending || (requestId && entry.requestId !== requestId)) return entry
      if (keep && entry.requestId && keep(entry.requestId)) return entry
      changed = true
      return { ...entry, reply: { pending: false, success: false, lines: [], errorKey } }
    })
    if (!changed) return
    logs.value = next
    updateCounter.value++
  }

  /** Whether the command with this id still waits for its answer. */
  function isCommandPending(requestId: string): boolean {
    return logs.value.some((entry) => entry.requestId === requestId && entry.reply?.pending)
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
    maxLogs.value = DEFAULT_MAX_LOGS
  }

  /** Back to the empty state, e.g. when the panel switches to another server. */
  function reset() {
    logs.value = []
    maxLogs.value = DEFAULT_MAX_LOGS
    lastCursor.stdout = null
    lastCursor.stderr = null
    connected.value = false
    updateCounter.value++
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
    addServerEntries,
    replaceLogs,
    addCommand,
    setCommandReply,
    failPendingCommands,
    isCommandPending,
    clearLogs,
    reset,
    setConnected,
    toggleAutoScroll,
  }
})
