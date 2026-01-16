import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface LogEntry {
  id: string
  timestamp: string
  level: string
  message: string
}

/**
 * Removes ANSI escape codes from text
 */
function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
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

  // Getters
  const logCount = computed(() => logs.value.length)

  // Actions
  function addLog(entry: Omit<LogEntry, 'id'>) {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // Strip ANSI codes from message
    const cleanMessage = stripAnsiCodes(entry.message)

    logs.value.push({ ...entry, message: cleanMessage, id })

    // Limit log size
    if (logs.value.length > maxLogs) {
      logs.value = logs.value.slice(-maxLogs)
    }
  }

  function addLogs(entries: Omit<LogEntry, 'id'>[]) {
    entries.forEach((entry) => addLog(entry))
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
    // Actions
    addLog,
    addLogs,
    clearLogs,
    setConnected,
    toggleAutoScroll,
  }
})
