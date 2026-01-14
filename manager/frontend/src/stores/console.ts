import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface LogEntry {
  id: string
  timestamp: string
  level: string
  message: string
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
    logs.value.push({ ...entry, id })

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
