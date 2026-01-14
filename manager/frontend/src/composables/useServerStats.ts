import { ref, onMounted, onUnmounted } from 'vue'
import { serverApi, type ServerStatus, type ServerStats } from '@/api/server'
import { playersApi } from '@/api/players'

export function useServerStats(pollInterval = 5000) {
  const status = ref<ServerStatus | null>(null)
  const stats = ref<ServerStats | null>(null)
  const playerCount = ref(0)
  const loading = ref(true)
  const error = ref<string | null>(null)

  let intervalId: ReturnType<typeof setInterval> | null = null

  async function fetchData() {
    try {
      const [statusData, statsData, playersData] = await Promise.all([
        serverApi.getStatus(),
        serverApi.getStats(),
        playersApi.getCount(),
      ])

      status.value = statusData
      stats.value = statsData
      playerCount.value = playersData.count
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
  }
}
