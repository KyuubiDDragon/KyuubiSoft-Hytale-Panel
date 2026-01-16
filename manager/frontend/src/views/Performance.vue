<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useServerStats } from '@/composables/useServerStats'
import { statsApi, type StatsEntry } from '@/api/management'
import { serverApi, type PluginMemoryInfo } from '@/api/server'
import Card from '@/components/ui/Card.vue'

const { t } = useI18n()
const { stats, status, playerCount, refresh, pluginAvailable, tps, mspt, maxPlayers: pluginMaxPlayers } = useServerStats()

// Plugin memory data
const pluginMemory = ref<PluginMemoryInfo | null>(null)

// Historical data
const history = ref<StatsEntry[]>([])
const loading = ref(true)

// Local history for current session (updated live)
const localHistory = ref<{ timestamp: Date; cpu: number; memory: number; players: number; tps: number | null }[]>([])
const maxLocalHistory = 60 // 60 data points

// Refresh interval
let refreshInterval: ReturnType<typeof setInterval> | null = null

async function loadHistory() {
  try {
    const data = await statsApi.getHistory()
    history.value = data.history
  } catch (e) {
    // Ignore - use local history
  } finally {
    loading.value = false
  }
}

async function fetchPluginMemory() {
  try {
    const response = await serverApi.getPluginMemory()
    if (response.success && response.data) {
      pluginMemory.value = response.data
    }
  } catch {
    // Plugin memory not available
  }
}

function addLocalEntry() {
  localHistory.value.push({
    timestamp: new Date(),
    cpu: stats.value?.cpu_percent || 0,
    memory: stats.value?.memory_percent || 0,
    players: playerCount.value,
    tps: tps.value,
  })

  // Keep only last maxLocalHistory entries
  while (localHistory.value.length > maxLocalHistory) {
    localHistory.value.shift()
  }
}

// Compute graph data
const cpuData = computed(() => localHistory.value.map(h => h.cpu))
const memoryData = computed(() => localHistory.value.map(h => h.memory))
const playersData = computed(() => localHistory.value.map(h => h.players))
const tpsData = computed(() => localHistory.value.map(h => h.tps ?? 20))

const avgCpu = computed(() => {
  if (cpuData.value.length === 0) return 0
  return cpuData.value.reduce((a, b) => a + b, 0) / cpuData.value.length
})

const avgMemory = computed(() => {
  if (memoryData.value.length === 0) return 0
  return memoryData.value.reduce((a, b) => a + b, 0) / memoryData.value.length
})

const avgTps = computed(() => {
  const validTps = localHistory.value.filter(h => h.tps !== null).map(h => h.tps as number)
  if (validTps.length === 0) return null
  return validTps.reduce((a, b) => a + b, 0) / validTps.length
})

const maxCpu = computed(() => Math.max(...cpuData.value, 0))
const maxMemory = computed(() => Math.max(...memoryData.value, 0))
const maxPlayers = computed(() => Math.max(...playersData.value, 1))
const minTps = computed(() => {
  const validTps = localHistory.value.filter(h => h.tps !== null).map(h => h.tps as number)
  if (validTps.length === 0) return null
  return Math.min(...validTps)
})

// TPS status color
const tpsStatus = computed(() => {
  if (tps.value === null) return 'gray'
  if (tps.value >= 19) return 'green'
  if (tps.value >= 15) return 'yellow'
  return 'red'
})

// JVM Heap memory display
const heapUsed = computed(() => pluginMemory.value?.heapUsed ?? null)
const heapMax = computed(() => pluginMemory.value?.heapMax ?? null)
const heapPercent = computed(() => pluginMemory.value?.heapUsagePercent ?? null)

// Generate SVG path for a graph
function generatePath(data: number[], maxValue: number, width: number, height: number): string {
  if (data.length < 2) return ''

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width
    const y = height - (value / Math.max(maxValue, 1)) * height
    return `${x},${y}`
  })

  return `M ${points.join(' L ')}`
}

// Generate area path for filled graph
function generateAreaPath(data: number[], maxValue: number, width: number, height: number): string {
  if (data.length < 2) return ''

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width
    const y = height - (value / Math.max(maxValue, 1)) * height
    return `${x},${y}`
  })

  return `M 0,${height} L ${points.join(' L ')} L ${width},${height} Z`
}

onMounted(async () => {
  await loadHistory()
  await refresh()
  await fetchPluginMemory()
  addLocalEntry()

  // Update every 5 seconds
  refreshInterval = setInterval(async () => {
    await refresh()
    await fetchPluginMemory()
    addLocalEntry()
  }, 5000)
})

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval)
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">{{ t('performance.title') }}</h1>
      <div class="flex items-center gap-2 text-sm text-gray-400">
        <span class="w-2 h-2 bg-status-success rounded-full animate-pulse"></span>
        {{ t('performance.liveUpdates') }}
      </div>
    </div>

    <!-- Current Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
      <!-- CPU Card -->
      <Card>
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center">
            <svg class="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          </div>
          <div>
            <p class="text-sm text-gray-400">{{ t('performance.cpu') }}</p>
            <p class="text-2xl font-bold text-white">{{ (stats?.cpu_percent || 0).toFixed(1) }}%</p>
          </div>
        </div>
      </Card>

      <!-- Memory Card (JVM Heap when plugin available) -->
      <Card>
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center">
            <svg class="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <div>
            <p class="text-sm text-gray-400">
              {{ pluginAvailable && heapUsed !== null ? 'JVM Heap' : t('performance.memory') }}
            </p>
            <template v-if="pluginAvailable && heapUsed !== null && heapMax !== null">
              <p class="text-2xl font-bold text-white">{{ (heapUsed / 1024 / 1024).toFixed(0) }} MB</p>
              <p class="text-xs text-gray-500">/ {{ (heapMax / 1024 / 1024).toFixed(0) }} MB ({{ heapPercent?.toFixed(0) }}%)</p>
            </template>
            <template v-else>
              <p class="text-2xl font-bold text-white">{{ (stats?.memory_mb || 0).toFixed(0) }} MB</p>
              <p class="text-xs text-gray-500">/ {{ (stats?.memory_limit_mb || 0).toFixed(0) }} MB</p>
            </template>
          </div>
        </div>
      </Card>

      <!-- TPS Card (only when plugin available) -->
      <Card v-if="pluginAvailable">
        <div class="flex items-center gap-4">
          <div :class="[
            'w-12 h-12 rounded-xl flex items-center justify-center',
            tpsStatus === 'green' ? 'bg-green-500/20' : tpsStatus === 'yellow' ? 'bg-yellow-500/20' : tpsStatus === 'red' ? 'bg-red-500/20' : 'bg-gray-500/20'
          ]">
            <svg :class="[
              'w-6 h-6',
              tpsStatus === 'green' ? 'text-green-400' : tpsStatus === 'yellow' ? 'text-yellow-400' : tpsStatus === 'red' ? 'text-red-400' : 'text-gray-400'
            ]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <p class="text-sm text-gray-400">TPS</p>
            <p :class="[
              'text-2xl font-bold',
              tpsStatus === 'green' ? 'text-green-400' : tpsStatus === 'yellow' ? 'text-yellow-400' : tpsStatus === 'red' ? 'text-red-400' : 'text-gray-400'
            ]">
              {{ tps?.toFixed(1) ?? '-' }}
            </p>
            <p v-if="mspt !== null" class="text-xs text-gray-500">{{ mspt.toFixed(1) }} ms/tick</p>
          </div>
        </div>
      </Card>

      <!-- Players Card -->
      <Card>
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 bg-hytale-orange/20 rounded-xl flex items-center justify-center">
            <svg class="w-6 h-6 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          </div>
          <div>
            <p class="text-sm text-gray-400">{{ t('performance.players') }}</p>
            <p class="text-2xl font-bold text-white">{{ playerCount }}</p>
            <p v-if="pluginMaxPlayers" class="text-xs text-gray-500">/ {{ pluginMaxPlayers }}</p>
          </div>
        </div>
      </Card>

      <!-- Status Card -->
      <Card>
        <div class="flex items-center gap-4">
          <div :class="[
            'w-12 h-12 rounded-xl flex items-center justify-center',
            status?.running ? 'bg-status-success/20' : 'bg-status-error/20'
          ]">
            <svg :class="[
              'w-6 h-6',
              status?.running ? 'text-status-success' : 'text-status-error'
            ]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
          </div>
          <div>
            <p class="text-sm text-gray-400">{{ t('performance.status') }}</p>
            <p :class="[
              'text-2xl font-bold',
              status?.running ? 'text-status-success' : 'text-status-error'
            ]">
              {{ status?.running ? t('dashboard.online') : t('dashboard.offline') }}
            </p>
          </div>
        </div>
      </Card>
    </div>

    <!-- Graphs -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- CPU Graph -->
      <Card>
        <div class="mb-4 flex items-center justify-between">
          <h3 class="font-semibold text-white">{{ t('performance.cpuUsage') }}</h3>
          <div class="flex items-center gap-4 text-sm">
            <span class="text-gray-400">{{ t('performance.avg') }}: <span class="text-blue-400">{{ avgCpu.toFixed(1) }}%</span></span>
            <span class="text-gray-400">{{ t('performance.max') }}: <span class="text-blue-400">{{ maxCpu.toFixed(1) }}%</span></span>
          </div>
        </div>
        <div class="relative h-48 bg-dark-100 rounded-lg overflow-hidden">
          <svg class="w-full h-full" preserveAspectRatio="none">
            <!-- Grid lines -->
            <line x1="0" y1="25%" x2="100%" y2="25%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />
            <line x1="0" y1="50%" x2="100%" y2="50%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />
            <line x1="0" y1="75%" x2="100%" y2="75%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />

            <!-- Area -->
            <path
              :d="generateAreaPath(cpuData, 100, 400, 192)"
              fill="url(#cpuGradient)"
              class="transition-all duration-300"
            />

            <!-- Line -->
            <path
              :d="generatePath(cpuData, 100, 400, 192)"
              fill="none"
              stroke="#3b82f6"
              stroke-width="2"
              class="transition-all duration-300"
            />

            <!-- Gradient definitions -->
            <defs>
              <linearGradient id="cpuGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.3" />
                <stop offset="100%" stop-color="#3b82f6" stop-opacity="0" />
              </linearGradient>
            </defs>
          </svg>

          <!-- Y-axis labels -->
          <div class="absolute left-2 top-0 h-full flex flex-col justify-between py-2 text-xs text-gray-500">
            <span>100%</span>
            <span>75%</span>
            <span>50%</span>
            <span>25%</span>
            <span>0%</span>
          </div>
        </div>
      </Card>

      <!-- Memory Graph -->
      <Card>
        <div class="mb-4 flex items-center justify-between">
          <h3 class="font-semibold text-white">{{ t('performance.memoryUsage') }}</h3>
          <div class="flex items-center gap-4 text-sm">
            <span class="text-gray-400">{{ t('performance.avg') }}: <span class="text-purple-400">{{ avgMemory.toFixed(1) }}%</span></span>
            <span class="text-gray-400">{{ t('performance.max') }}: <span class="text-purple-400">{{ maxMemory.toFixed(1) }}%</span></span>
          </div>
        </div>
        <div class="relative h-48 bg-dark-100 rounded-lg overflow-hidden">
          <svg class="w-full h-full" preserveAspectRatio="none">
            <!-- Grid lines -->
            <line x1="0" y1="25%" x2="100%" y2="25%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />
            <line x1="0" y1="50%" x2="100%" y2="50%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />
            <line x1="0" y1="75%" x2="100%" y2="75%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />

            <!-- Area -->
            <path
              :d="generateAreaPath(memoryData, 100, 400, 192)"
              fill="url(#memoryGradient)"
              class="transition-all duration-300"
            />

            <!-- Line -->
            <path
              :d="generatePath(memoryData, 100, 400, 192)"
              fill="none"
              stroke="#a855f7"
              stroke-width="2"
              class="transition-all duration-300"
            />

            <!-- Gradient definitions -->
            <defs>
              <linearGradient id="memoryGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#a855f7" stop-opacity="0.3" />
                <stop offset="100%" stop-color="#a855f7" stop-opacity="0" />
              </linearGradient>
            </defs>
          </svg>

          <!-- Y-axis labels -->
          <div class="absolute left-2 top-0 h-full flex flex-col justify-between py-2 text-xs text-gray-500">
            <span>100%</span>
            <span>75%</span>
            <span>50%</span>
            <span>25%</span>
            <span>0%</span>
          </div>
        </div>
      </Card>

      <!-- Players Graph -->
      <Card class="lg:col-span-2">
        <div class="mb-4 flex items-center justify-between">
          <h3 class="font-semibold text-white">{{ t('performance.playersHistory') }}</h3>
          <div class="flex items-center gap-4 text-sm">
            <span class="text-gray-400">{{ t('performance.current') }}: <span class="text-hytale-orange">{{ playerCount }}</span></span>
            <span class="text-gray-400">{{ t('performance.max') }}: <span class="text-hytale-orange">{{ maxPlayers }}</span></span>
          </div>
        </div>
        <div class="relative h-32 bg-dark-100 rounded-lg overflow-hidden">
          <svg class="w-full h-full" preserveAspectRatio="none">
            <!-- Grid lines -->
            <line x1="0" y1="50%" x2="100%" y2="50%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />

            <!-- Area -->
            <path
              :d="generateAreaPath(playersData, maxPlayers + 1, 800, 128)"
              fill="url(#playersGradient)"
              class="transition-all duration-300"
            />

            <!-- Line -->
            <path
              :d="generatePath(playersData, maxPlayers + 1, 800, 128)"
              fill="none"
              stroke="#f97316"
              stroke-width="2"
              class="transition-all duration-300"
            />

            <!-- Gradient definitions -->
            <defs>
              <linearGradient id="playersGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#f97316" stop-opacity="0.3" />
                <stop offset="100%" stop-color="#f97316" stop-opacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      </Card>

      <!-- TPS Graph (only when plugin available) -->
      <Card v-if="pluginAvailable" class="lg:col-span-2">
        <div class="mb-4 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <h3 class="font-semibold text-white">TPS History</h3>
            <span class="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
              Plugin
            </span>
          </div>
          <div class="flex items-center gap-4 text-sm">
            <span class="text-gray-400">{{ t('performance.current') }}: <span :class="tpsStatus === 'green' ? 'text-green-400' : tpsStatus === 'yellow' ? 'text-yellow-400' : 'text-red-400'">{{ tps?.toFixed(1) ?? '-' }}</span></span>
            <span class="text-gray-400">{{ t('performance.avg') }}: <span class="text-green-400">{{ avgTps?.toFixed(1) ?? '-' }}</span></span>
            <span class="text-gray-400">Min: <span class="text-green-400">{{ minTps?.toFixed(1) ?? '-' }}</span></span>
          </div>
        </div>
        <div class="relative h-32 bg-dark-100 rounded-lg overflow-hidden">
          <svg class="w-full h-full" preserveAspectRatio="none">
            <!-- Grid lines for TPS (20 = max, 15 = warning threshold) -->
            <line x1="0" y1="25%" x2="100%" y2="25%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />
            <line x1="0" y1="50%" x2="100%" y2="50%" stroke="#374151" stroke-width="1" stroke-dasharray="4" />
            <line x1="0" y1="75%" x2="100%" y2="75%" stroke="#ef4444" stroke-width="1" stroke-dasharray="4" opacity="0.3" />

            <!-- Area -->
            <path
              :d="generateAreaPath(tpsData, 20, 800, 128)"
              fill="url(#tpsGradient)"
              class="transition-all duration-300"
            />

            <!-- Line -->
            <path
              :d="generatePath(tpsData, 20, 800, 128)"
              fill="none"
              stroke="#22c55e"
              stroke-width="2"
              class="transition-all duration-300"
            />

            <!-- Gradient definitions -->
            <defs>
              <linearGradient id="tpsGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#22c55e" stop-opacity="0.3" />
                <stop offset="100%" stop-color="#22c55e" stop-opacity="0" />
              </linearGradient>
            </defs>
          </svg>

          <!-- Y-axis labels for TPS -->
          <div class="absolute left-2 top-0 h-full flex flex-col justify-between py-2 text-xs text-gray-500">
            <span>20</span>
            <span>15</span>
            <span>10</span>
            <span>5</span>
            <span>0</span>
          </div>
        </div>
      </Card>
    </div>

    <!-- Statistics Summary -->
    <Card>
      <h3 class="font-semibold text-white mb-4">{{ t('performance.summary') }}</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-sm text-gray-400 mb-1">{{ t('performance.containerName') }}</p>
          <p class="text-white font-mono">{{ status?.name || '-' }}</p>
        </div>
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-sm text-gray-400 mb-1">{{ t('performance.containerId') }}</p>
          <p class="text-white font-mono text-sm">{{ status?.id || '-' }}</p>
        </div>
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-sm text-gray-400 mb-1">{{ t('performance.memoryLimit') }}</p>
          <p class="text-white">{{ (stats?.memory_limit_mb || 0).toFixed(0) }} MB</p>
        </div>
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-sm text-gray-400 mb-1">{{ t('performance.dataPoints') }}</p>
          <p class="text-white">{{ localHistory.length }} / {{ maxLocalHistory }}</p>
        </div>
      </div>
    </Card>
  </div>
</template>
