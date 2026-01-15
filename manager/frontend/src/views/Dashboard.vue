<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useServerStats } from '@/composables/useServerStats'
import { serverApi, type ServerMemoryStats, type UpdateCheckResponse } from '@/api/server'
import StatusCard from '@/components/dashboard/StatusCard.vue'
import QuickActions from '@/components/dashboard/QuickActions.vue'

const { t } = useI18n()
const { status, stats, playerCount, loading, error, refresh } = useServerStats()

// Server JVM memory stats
const serverMemory = ref<ServerMemoryStats | null>(null)
let memoryInterval: ReturnType<typeof setInterval> | null = null

// Update check state
const updateInfo = ref<UpdateCheckResponse | null>(null)
const checkingUpdate = ref(false)
const updateCheckError = ref<string | null>(null)

async function fetchServerMemory() {
  try {
    serverMemory.value = await serverApi.getMemoryStats()
  } catch {
    // Silently fail - server might not be running
  }
}

async function checkForUpdates() {
  checkingUpdate.value = true
  updateCheckError.value = null
  try {
    updateInfo.value = await serverApi.checkForUpdates()
  } catch (err) {
    updateCheckError.value = err instanceof Error ? err.message : 'Failed to check for updates'
  } finally {
    checkingUpdate.value = false
  }
}

onMounted(() => {
  fetchServerMemory()
  memoryInterval = setInterval(fetchServerMemory, 10000) // Every 10 seconds
})

onUnmounted(() => {
  if (memoryInterval) {
    clearInterval(memoryInterval)
  }
})

const serverStatusText = computed(() => {
  if (!status.value) return t('common.loading')
  if (status.value.running) return t('dashboard.online')
  return t('dashboard.offline')
})

const serverStatusType = computed((): 'success' | 'error' => {
  return status.value?.running ? 'success' : 'error'
})

const cpuValue = computed(() => {
  if (!stats.value?.cpu_percent) return '0%'
  return `${stats.value.cpu_percent.toFixed(1)}%`
})

// Show JVM heap memory if available, otherwise fall back to Docker memory
const memoryValue = computed(() => {
  // Prefer JVM heap memory from server stats
  if (serverMemory.value?.available && serverMemory.value.heap?.used !== null) {
    const used = serverMemory.value.heap.used
    const max = serverMemory.value.heap.max
    if (used !== null && max !== null) {
      return `${used.toFixed(1)} / ${max.toFixed(1)} GiB`
    }
  }
  // Fall back to Docker container memory
  if (!stats.value?.memory_mb) return '0 MB'
  return `${stats.value.memory_mb.toFixed(0)} / ${stats.value.memory_limit_mb?.toFixed(0) || '?'} MB`
})

// Memory percent for status color (based on JVM heap or Docker)
const memoryPercent = computed(() => {
  if (serverMemory.value?.available && serverMemory.value.heap?.used !== null && serverMemory.value.heap?.max !== null) {
    const used = serverMemory.value.heap.used
    const max = serverMemory.value.heap.max
    if (used !== null && max !== null && max > 0) {
      return (used / max) * 100
    }
  }
  return stats.value?.memory_percent || 0
})

const uptimeValue = computed(() => {
  if (!status.value?.started_at) return '-'
  const started = new Date(status.value.started_at)
  const now = new Date()
  const diff = now.getTime() - started.getTime()

  const hours = Math.floor(diff / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))

  if (hours > 24) {
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
  }
  return `${hours}h ${minutes}m`
})

function handleAction(type: string, success: boolean) {
  if (success) {
    // Refresh stats after action
    setTimeout(() => {
      refresh()
      fetchServerMemory()
    }, 2000)
  }
}

function refreshAll() {
  refresh()
  fetchServerMemory()
}
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">{{ t('dashboard.title') }}</h1>
      <button
        @click="refreshAll"
        class="text-gray-400 hover:text-white transition-colors"
        :class="{ 'animate-spin': loading }"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Status Cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatusCard
        :title="t('dashboard.serverStatus')"
        :value="serverStatusText"
        :status="serverStatusType"
        icon="server"
      />

      <StatusCard
        :title="t('dashboard.cpu')"
        :value="cpuValue"
        :status="(stats?.cpu_percent || 0) > 80 ? 'warning' : 'info'"
        icon="cpu"
      />

      <StatusCard
        :title="t('dashboard.memory')"
        :value="memoryValue"
        :status="memoryPercent > 80 ? 'warning' : 'info'"
        icon="memory"
      />

      <StatusCard
        :title="t('dashboard.players')"
        :value="playerCount.toString()"
        status="info"
        icon="players"
      />
    </div>

    <!-- Quick Actions -->
    <QuickActions @action="handleAction" />

    <!-- Additional Info -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Uptime Card -->
      <div class="card">
        <div class="card-header">
          <h3 class="text-lg font-semibold text-white">{{ t('dashboard.uptime') }}</h3>
        </div>
        <div class="card-body">
          <div class="flex items-center gap-4">
            <div class="w-16 h-16 rounded-xl bg-hytale-orange/20 flex items-center justify-center">
              <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p class="text-3xl font-bold text-white">{{ uptimeValue }}</p>
              <p v-if="status?.started_at" class="text-sm text-gray-400">
                {{ t('dashboard.serverStatus') }}: {{ new Date(status.started_at).toLocaleString() }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Server Info Card -->
      <div class="card">
        <div class="card-header">
          <h3 class="text-lg font-semibold text-white">Server Info</h3>
        </div>
        <div class="card-body">
          <div class="space-y-3">
            <div class="flex justify-between">
              <span class="text-gray-400">Container</span>
              <span class="text-white font-mono">{{ status?.name || '-' }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">Container ID</span>
              <span class="text-white font-mono">{{ status?.id || '-' }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">Status</span>
              <span :class="status?.running ? 'text-status-success' : 'text-status-error'">
                {{ status?.status || '-' }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Update Check Card -->
    <div class="card">
      <div class="card-header flex items-center justify-between">
        <h3 class="text-lg font-semibold text-white">Hytale Updates</h3>
        <button
          @click="checkForUpdates"
          :disabled="checkingUpdate"
          class="px-4 py-2 bg-hytale-orange hover:bg-hytale-orange/80 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
        >
          <svg
            class="w-4 h-4"
            :class="{ 'animate-spin': checkingUpdate }"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ checkingUpdate ? 'Checking...' : 'Check for Updates' }}
        </button>
      </div>
      <div class="card-body">
        <!-- Error -->
        <div v-if="updateCheckError" class="p-3 bg-status-error/10 border border-status-error/20 rounded-lg">
          <p class="text-status-error text-sm">{{ updateCheckError }}</p>
        </div>

        <!-- No check yet -->
        <div v-else-if="!updateInfo" class="text-gray-400 text-sm">
          Click "Check for Updates" to see if a new version is available.
        </div>

        <!-- Update info -->
        <div v-else class="space-y-3">
          <div class="flex justify-between items-center">
            <span class="text-gray-400">Installed Version</span>
            <span class="text-white font-mono">{{ updateInfo.installedVersion }}</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-gray-400">Latest Version</span>
            <span class="text-white font-mono">{{ updateInfo.latestVersion }}</span>
          </div>
          <div
            class="p-3 rounded-lg text-sm font-medium"
            :class="updateInfo.updateAvailable
              ? 'bg-hytale-orange/20 text-hytale-orange border border-hytale-orange/30'
              : 'bg-status-success/20 text-status-success border border-status-success/30'"
          >
            <div class="flex items-center gap-2">
              <svg v-if="updateInfo.updateAvailable" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              {{ updateInfo.message }}
            </div>
            <p v-if="updateInfo.updateAvailable" class="mt-2 text-xs opacity-80">
              Restart the server with AUTO_UPDATE=true to apply the update.
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
