import { ref, onMounted, onUnmounted } from 'vue'
import { serverApi, type ServerStatus, type ServerStats, type PluginServerInfo } from '@/api/server'
import { playersApi } from '@/api/players'

export function useServerStats(pollInterval = 5000) {
  const status = ref<ServerStatus | null>(null)
  const stats = ref<ServerStats | null>(null)
  const playerCount = ref(0)
  const loading = ref(true)
  const error = ref<string | null>(null)

  // Plugin-specific data
  const pluginAvailable = ref(false)
  const tps = ref<number | null>(null)
  const mspt = ref<number | null>(null)
  const maxPlayers = ref<number | null>(null)
  const serverVersion = ref<string | null>(null)

  let intervalId: ReturnType<typeof setInterval> | null = null

  async function fetchData() {
    try {
      // First, get basic status and stats
      const [statusData, statsData] = await Promise.all([
        serverApi.getStatus(),
        serverApi.getStats(),
      ])

      status.value = statusData
      stats.value = statsData

      // Try to get data from plugin API (more accurate)
      if (statusData.running) {
        try {
          const pluginInfo = await serverApi.getPluginServerInfo()
          if (pluginInfo.success && pluginInfo.data) {
            pluginAvailable.value = true
            playerCount.value = pluginInfo.data.onlinePlayers
            tps.value = pluginInfo.data.tps
            mspt.value = pluginInfo.data.mspt
            maxPlayers.value = pluginInfo.data.maxPlayers
            serverVersion.value = pluginInfo.data.version
          } else {
            // Plugin not available, fall back to old method
            pluginAvailable.value = false
            const playersData = await playersApi.getCount()
            playerCount.value = playersData.count
            tps.value = null
            mspt.value = null
          }
        } catch {
          // Plugin API failed, fall back to old method
          pluginAvailable.value = false
          const playersData = await playersApi.getCount()
          playerCount.value = playersData.count
          tps.value = null
          mspt.value = null
        }
      } else {
        // Server not running
        pluginAvailable.value = false
        playerCount.value = 0
        tps.value = null
        mspt.value = null
      }

      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch server data'
    } finally {
      loading.value = false
    }
  }

  function startPolling() {
    fetchData()
    intervalId = setInterval(fetchData, pollInterval)
  }

  function stopPolling() {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  onMounted(() => {
    startPolling()
  })

  onUnmounted(() => {
    stopPolling()
  })

  return {
    status,
    stats,
    playerCount,
    loading,
    error,
    refresh: fetchData,
    // Plugin-specific data
    pluginAvailable,
    tps,
    mspt,
    maxPlayers,
    serverVersion,
  }
}
