import { ref, onMounted, onUnmounted } from 'vue'
import { serverApi, type ServerStatus, type ServerStats } from '@/api/server'
import { playersApi } from '@/api/players'
import { HYTALE_TARGET_TPS, LEGACY_PLUGIN_TARGET_TPS } from '@/utils/tps'

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
  // Scale for tps: the world's target (plugin 2.1+), 20 for older plugins
  // whose readings were capped there.
  const targetTps = ref<number>(HYTALE_TARGET_TPS)
  // World the headline TPS belongs to (the slowest one), plugin 2.1+
  const tpsWorld = ref<string | null>(null)
  const maxPlayers = ref<number | null>(null)
  const serverVersion = ref<string | null>(null)
  const patchline = ref<string | null>(null)
  const worldCount = ref<number | null>(null)
  const uptimeSeconds = ref<number | null>(null)

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
            tps.value = typeof pluginInfo.data.tps === 'number' ? pluginInfo.data.tps : null
            mspt.value = typeof pluginInfo.data.mspt === 'number' ? pluginInfo.data.mspt : null
            targetTps.value = pluginInfo.data.targetTps ?? LEGACY_PLUGIN_TARGET_TPS
            tpsWorld.value = pluginInfo.data.tpsWorld ?? null
            maxPlayers.value = pluginInfo.data.maxPlayers
            serverVersion.value = pluginInfo.data.version
            patchline.value = pluginInfo.data.patchline
            worldCount.value = pluginInfo.data.worldCount
            uptimeSeconds.value = pluginInfo.data.uptimeSeconds
          } else {
            // Plugin not available, fall back to old method
            pluginAvailable.value = false
            const playersData = await playersApi.getCount()
            playerCount.value = playersData.count
            tps.value = null
            mspt.value = null
            patchline.value = null
            worldCount.value = null
            uptimeSeconds.value = null
            // Get maxPlayers from config as fallback
            try {
              const quickSettings = await serverApi.getQuickSettings()
              maxPlayers.value = quickSettings.maxPlayers
            } catch {
              maxPlayers.value = null
            }
          }
        } catch {
          // Plugin API failed, fall back to old method
          pluginAvailable.value = false
          const playersData = await playersApi.getCount()
          playerCount.value = playersData.count
          tps.value = null
          mspt.value = null
          patchline.value = null
          worldCount.value = null
          uptimeSeconds.value = null
          // Get maxPlayers from config as fallback
          try {
            const quickSettings = await serverApi.getQuickSettings()
            maxPlayers.value = quickSettings.maxPlayers
          } catch {
            maxPlayers.value = null
          }
        }
      } else {
        // Server not running
        pluginAvailable.value = false
        playerCount.value = 0
        tps.value = null
        mspt.value = null
        patchline.value = null
        worldCount.value = null
        uptimeSeconds.value = null
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
    targetTps,
    tpsWorld,
    maxPlayers,
    serverVersion,
    patchline,
    worldCount,
    uptimeSeconds,
  }
}
