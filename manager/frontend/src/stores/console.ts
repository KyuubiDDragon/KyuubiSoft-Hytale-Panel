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
    clearLogs,
    setConnected,
    toggleAutoScroll,
  }
})
