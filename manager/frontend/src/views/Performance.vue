<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useServerStats } from '@/composables/useServerStats'
import { statsApi, type StatsEntry } from '@/api/management'
import { serverApi, type PluginMemoryInfo, type PluginTpsMetrics, type PrometheusMetrics } from '@/api/server'
import Card from '@/components/ui/Card.vue'

const { t } = useI18n()
const { stats, status, playerCount, refresh, pluginAvailable, tps, mspt, maxPlayers: pluginMaxPlayers } = useServerStats()

// Plugin memory data
const pluginMemory = ref<PluginMemoryInfo | null>(null)

// Extended TPS metrics from Prometheus endpoint
const tpsMetrics = ref<PluginTpsMetrics | null>(null)

// Full Prometheus metrics (includes JVM, threads, GC, etc.)
const prometheusData = ref<PrometheusMetrics['parsed'] | null>(null)

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

async function fetchTpsMetrics() {
  try {
    const response = await serverApi.getPluginTpsMetrics()
    if (response.success && response.data) {
      tpsMetrics.value = response.data
    }
  } catch {
    // TPS metrics not available
  }
}

async function fetchPrometheusMetrics() {
  try {
    const response = await serverApi.getPluginPrometheusMetrics()
    if (response.success && response.data?.parsed) {
      prometheusData.value = response.data.parsed
    }
  } catch {
    // Prometheus metrics not available
  }
}

// Helper to format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
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

// Local fallback TPS stats (from client-side tracking)
const localMinTps = computed(() => {
  const validTps = localHistory.value.filter(h => h.tps !== null).map(h => h.tps as number)
  if (validTps.length === 0) return null
  return Math.min(...validTps)
})
const localMaxTps = computed(() => {
  const validTps = localHistory.value.filter(h => h.tps !== null).map(h => h.tps as number)
  if (validTps.length === 0) return null
  return Math.max(...validTps)
})

// Server-side TPS metrics (from Prometheus, more accurate 60s window)
const serverTpsMin = computed(() => tpsMetrics.value?.min ?? null)
const serverTpsMax = computed(() => tpsMetrics.value?.max ?? null)
const serverTpsAvg = computed(() => tpsMetrics.value?.average ?? null)
const serverMsptAvg = computed(() => tpsMetrics.value?.msptAverage ?? null)

// Use server metrics if available, otherwise fall back to local
const displayTpsMin = computed(() => serverTpsMin.value ?? localMinTps.value)
const displayTpsMax = computed(() => serverTpsMax.value ?? localMaxTps.value)
const displayTpsAvg = computed(() => serverTpsAvg.value ?? avgTps.value)

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

// Check if JVM heap data is valid (available and has real values > 0)
// This prevents the race condition where pluginAvailable is true but heap values are still 0
const hasValidJvmHeap = computed(() =>
  pluginAvailable.value &&
  heapUsed.value !== null &&
  heapMax.value !== null &&
  heapUsed.value > 0 &&
  heapMax.value > 0
)

// Generate SVG path for a graph using percentage-based coordinates (0-100)
function generatePath(data: number[], maxValue: number): string {
  if (data.length < 2) return ''

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * 100
    const y = 100 - (value / Math.max(maxValue, 1)) * 100
    return `${x},${y}`
  })

  return `M ${points.join(' L ')}`
}

// Generate area path for filled graph using percentage-based coordinates (0-100)
function generateAreaPath(data: number[], maxValue: number): string {
  if (data.length < 2) return ''

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * 100
    const y = 100 - (value / Math.max(maxValue, 1)) * 100
    return `${x},${y}`
  })

  return `M 0,100 L ${points.join(' L ')} L 100,100 Z`
}

onMounted(async () => {
  await loadHistory()
  await refresh()
  await fetchPluginMemory()
  await fetchTpsMetrics()
  await fetchPrometheusMetrics()
  addLocalEntry()

  // Update every 5 seconds
  refreshInterval = setInterval(async () => {
    await refresh()
    await fetchPluginMemory()
    await fetchTpsMetrics()
    await fetchPrometheusMetrics()
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
              {{ hasValidJvmHeap ? 'JVM Heap' : t('performance.memory') }}
            </p>
            <template v-if="hasValidJvmHeap">
              <p class="text-2xl font-bold text-white">{{ heapUsed?.toFixed(0) }} MB</p>
              <p class="text-xs text-gray-500">/ {{ heapMax?.toFixed(0) }} MB ({{ heapPercent?.toFixed(0) }}%)</p>
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
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <p class="text-sm text-gray-400">TPS</p>
              <span v-if="tpsMetrics" class="px-1.5 py-0.5 text-[10px] rounded bg-green-500/20 text-green-400 border border-green-500/30">
                Prometheus
              </span>
            </div>
            <p :class="[
              'text-2xl font-bold',
              tpsStatus === 'green' ? 'text-green-400' : tpsStatus === 'yellow' ? 'text-yellow-400' : tpsStatus === 'red' ? 'text-red-400' : 'text-gray-400'
            ]">
              {{ tps?.toFixed(1) ?? '-' }}
            </p>
            <div class="flex items-center gap-2 text-xs text-gray-500">
              <span v-if="mspt !== null">{{ mspt.toFixed(1) }} ms/tick</span>
              <span v-if="displayTpsMin !== null" class="text-gray-600">|</span>
              <span v-if="displayTpsMin !== null" class="text-yellow-500">Min: {{ displayTpsMin.toFixed(1) }}</span>
            </div>
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
        <div class="relative h-64 bg-dark-100 rounded-lg overflow-hidden">
          <svg class="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <!-- Grid lines -->
            <line x1="0" y1="25" x2="100" y2="25" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />
            <line x1="0" y1="50" x2="100" y2="50" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />
            <line x1="0" y1="75" x2="100" y2="75" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />

            <!-- Area -->
            <path
              :d="generateAreaPath(cpuData, 100)"
              fill="url(#cpuGradient)"
              class="transition-all duration-300"
            />

            <!-- Line -->
            <path
              :d="generatePath(cpuData, 100)"
              fill="none"
              stroke="#3b82f6"
              stroke-width="0.5"
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
        <div class="relative h-64 bg-dark-100 rounded-lg overflow-hidden">
          <svg class="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <!-- Grid lines -->
            <line x1="0" y1="25" x2="100" y2="25" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />
            <line x1="0" y1="50" x2="100" y2="50" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />
            <line x1="0" y1="75" x2="100" y2="75" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />

            <!-- Area -->
            <path
              :d="generateAreaPath(memoryData, 100)"
              fill="url(#memoryGradient)"
              class="transition-all duration-300"
            />

            <!-- Line -->
            <path
              :d="generatePath(memoryData, 100)"
              fill="none"
              stroke="#a855f7"
              stroke-width="0.5"
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
        <div class="relative h-48 bg-dark-100 rounded-lg overflow-hidden">
          <svg class="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <!-- Grid lines -->
            <line x1="0" y1="50" x2="100" y2="50" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />

            <!-- Area -->
            <path
              :d="generateAreaPath(playersData, maxPlayers + 1)"
              fill="url(#playersGradient)"
              class="transition-all duration-300"
            />

            <!-- Line -->
            <path
              :d="generatePath(playersData, maxPlayers + 1)"
              fill="none"
              stroke="#f97316"
              stroke-width="0.5"
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
              Prometheus
            </span>
          </div>
          <div class="flex items-center gap-4 text-sm flex-wrap">
            <span class="text-gray-400">{{ t('performance.current') }}: <span :class="tpsStatus === 'green' ? 'text-green-400' : tpsStatus === 'yellow' ? 'text-yellow-400' : 'text-red-400'">{{ tps?.toFixed(1) ?? '-' }}</span></span>
            <span class="text-gray-400">{{ t('performance.avg') }}: <span class="text-green-400">{{ displayTpsAvg?.toFixed(1) ?? '-' }}</span></span>
            <span class="text-gray-400">Min: <span class="text-yellow-400">{{ displayTpsMin?.toFixed(1) ?? '-' }}</span></span>
            <span class="text-gray-400">Max: <span class="text-blue-400">{{ displayTpsMax?.toFixed(1) ?? '-' }}</span></span>
            <span v-if="serverMsptAvg !== null" class="text-gray-400">MSPT Avg: <span class="text-purple-400">{{ serverMsptAvg.toFixed(1) }}ms</span></span>
          </div>
        </div>
        <div class="relative h-48 bg-dark-100 rounded-lg overflow-hidden">
          <svg class="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <!-- Grid lines for TPS (20 = max, 15 = warning threshold) -->
            <line x1="0" y1="25" x2="100" y2="25" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />
            <line x1="0" y1="50" x2="100" y2="50" stroke="#374151" stroke-width="0.5" stroke-dasharray="2" />
            <line x1="0" y1="75" x2="100" y2="75" stroke="#ef4444" stroke-width="0.5" stroke-dasharray="2" opacity="0.3" />

            <!-- Area -->
            <path
              :d="generateAreaPath(tpsData, 20)"
              fill="url(#tpsGradient)"
              class="transition-all duration-300"
            />

            <!-- Line -->
            <path
              :d="generatePath(tpsData, 20)"
              fill="none"
              stroke="#22c55e"
              stroke-width="0.5"
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

      <!-- TPS Metrics Summary (when Prometheus available) -->
      <div v-if="tpsMetrics" class="mt-4 pt-4 border-t border-dark-100">
        <h4 class="text-sm font-medium text-gray-400 mb-3">Prometheus TPS Metrics (60s Window)</h4>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div class="p-3 bg-dark-100 rounded-lg text-center">
            <p class="text-xs text-gray-500 mb-1">Current</p>
            <p class="text-lg font-bold text-green-400">{{ tpsMetrics.current.toFixed(1) }}</p>
          </div>
          <div class="p-3 bg-dark-100 rounded-lg text-center">
            <p class="text-xs text-gray-500 mb-1">Average</p>
            <p class="text-lg font-bold text-blue-400">{{ tpsMetrics.average.toFixed(1) }}</p>
          </div>
          <div class="p-3 bg-dark-100 rounded-lg text-center">
            <p class="text-xs text-gray-500 mb-1">Minimum</p>
            <p class="text-lg font-bold text-yellow-400">{{ tpsMetrics.min.toFixed(1) }}</p>
          </div>
          <div class="p-3 bg-dark-100 rounded-lg text-center">
            <p class="text-xs text-gray-500 mb-1">Maximum</p>
            <p class="text-lg font-bold text-purple-400">{{ tpsMetrics.max.toFixed(1) }}</p>
          </div>
          <div class="p-3 bg-dark-100 rounded-lg text-center">
            <p class="text-xs text-gray-500 mb-1">MSPT Avg</p>
            <p class="text-lg font-bold text-orange-400">{{ tpsMetrics.msptAverage.toFixed(1) }}ms</p>
          </div>
        </div>
      </div>
    </Card>

    <!-- JVM Details (when Prometheus available) -->
    <Card v-if="prometheusData">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-white">JVM Details</h3>
        <span class="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
          Prometheus
        </span>
      </div>

      <!-- Main JVM Stats -->
      <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        <!-- Heap Memory -->
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-xs text-gray-500 mb-1">Heap Memory</p>
          <p class="text-lg font-bold text-purple-400">{{ formatBytes(prometheusData.memory.heapUsed) }}</p>
          <p class="text-xs text-gray-500">/ {{ formatBytes(prometheusData.memory.heapMax) }}</p>
          <div class="mt-2 h-1.5 bg-dark-200 rounded-full overflow-hidden">
            <div class="h-full bg-purple-500 rounded-full" :style="{ width: prometheusData.memory.heapPercent + '%' }"></div>
          </div>
        </div>

        <!-- Non-Heap Memory -->
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-xs text-gray-500 mb-1">Non-Heap Memory</p>
          <p class="text-lg font-bold text-cyan-400">{{ formatBytes(prometheusData.memory.nonHeapUsed) }}</p>
          <p class="text-xs text-gray-500">committed: {{ formatBytes(prometheusData.memory.nonHeapCommitted) }}</p>
        </div>

        <!-- Threads -->
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-xs text-gray-500 mb-1">Threads</p>
          <p class="text-lg font-bold text-green-400">{{ prometheusData.threads.current }}</p>
          <p class="text-xs text-gray-500">{{ prometheusData.threads.daemon }} daemon / {{ prometheusData.threads.peak }} peak</p>
        </div>

        <!-- CPU -->
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-xs text-gray-500 mb-1">CPU Usage</p>
          <p class="text-lg font-bold text-blue-400">{{ prometheusData.cpu.process.toFixed(1) }}%</p>
          <p class="text-xs text-gray-500">System: {{ prometheusData.cpu.system.toFixed(1) }}%</p>
        </div>

        <!-- Session Stats -->
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-xs text-gray-500 mb-1">Session Stats</p>
          <div class="flex items-center gap-2">
            <span class="text-lg font-bold text-green-400">+{{ prometheusData.players.joins }}</span>
            <span class="text-gray-500">/</span>
            <span class="text-lg font-bold text-red-400">-{{ prometheusData.players.leaves }}</span>
          </div>
          <p class="text-xs text-gray-500">joins / leaves</p>
        </div>

        <!-- Worlds -->
        <div class="p-4 bg-dark-100 rounded-lg">
          <p class="text-xs text-gray-500 mb-1">Worlds Loaded</p>
          <p class="text-lg font-bold text-orange-400">{{ prometheusData.worlds }}</p>
          <p class="text-xs text-gray-500">active worlds</p>
        </div>
      </div>

      <!-- Memory Pools -->
      <div v-if="prometheusData.memory.pools.length > 0" class="mb-6">
        <h4 class="text-sm font-medium text-gray-400 mb-3">Memory Pools</h4>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <div v-for="pool in prometheusData.memory.pools" :key="pool.name" class="p-3 bg-dark-100 rounded-lg">
            <p class="text-xs text-gray-500 mb-1 truncate" :title="pool.name">{{ pool.name }}</p>
            <p class="text-sm font-bold text-white">{{ formatBytes(pool.used) }}</p>
            <div class="mt-1.5 h-1 bg-dark-200 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-300"
                :class="pool.percent > 80 ? 'bg-red-500' : pool.percent > 60 ? 'bg-yellow-500' : 'bg-blue-500'"
                :style="{ width: Math.min(pool.percent, 100) + '%' }"
              ></div>
            </div>
            <p class="text-[10px] text-gray-600 mt-1">{{ pool.max > 0 ? formatBytes(pool.max) : 'unlimited' }}</p>
          </div>
        </div>
      </div>

      <!-- GC Stats -->
      <div v-if="prometheusData.gc.length > 0">
        <h4 class="text-sm font-medium text-gray-400 mb-3">Garbage Collection</h4>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div v-for="gc in prometheusData.gc" :key="gc.name" class="p-3 bg-dark-100 rounded-lg">
            <p class="text-xs text-gray-500 mb-1 truncate" :title="gc.name">{{ gc.name }}</p>
            <div class="flex items-baseline gap-2">
              <p class="text-lg font-bold text-yellow-400">{{ gc.count }}</p>
              <p class="text-xs text-gray-500">collections</p>
            </div>
            <p class="text-xs text-gray-500">{{ (gc.timeSeconds * 1000).toFixed(0) }}ms total</p>
          </div>
        </div>
      </div>

      <!-- Players per World -->
      <div v-if="Object.keys(prometheusData.players.perWorld).length > 0" class="mt-6">
        <h4 class="text-sm font-medium text-gray-400 mb-3">Players per World</h4>
        <div class="flex flex-wrap gap-2">
          <div v-for="(count, world) in prometheusData.players.perWorld" :key="world" class="px-3 py-2 bg-dark-100 rounded-lg flex items-center gap-2">
            <span class="text-sm text-gray-400">{{ world }}:</span>
            <span class="text-sm font-bold text-hytale-orange">{{ count }}</span>
          </div>
        </div>
      </div>
    </Card>
  </div>
</template>
