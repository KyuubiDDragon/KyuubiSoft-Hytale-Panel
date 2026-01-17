<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useServerStats } from '@/composables/useServerStats'
import { serverApi, type ServerMemoryStats, type UpdateCheckResponse, type PatchlineResponse } from '@/api/server'
import { authApi, type HytaleAuthStatus } from '@/api/auth'
import { schedulerApi, type SchedulerStatus } from '@/api/scheduler'
import StatusCard from '@/components/dashboard/StatusCard.vue'
import QuickActions from '@/components/dashboard/QuickActions.vue'
import PluginBanner from '@/components/dashboard/PluginBanner.vue'

const { t } = useI18n()
const router = useRouter()
const { status, stats, playerCount, loading, error, refresh, pluginAvailable, tps, mspt, maxPlayers, serverVersion, patchline, worldCount, uptimeSeconds } = useServerStats()

// Server JVM memory stats
const serverMemory = ref<ServerMemoryStats | null>(null)
let memoryInterval: ReturnType<typeof setInterval> | null = null

// Update check state
const updateInfo = ref<UpdateCheckResponse | null>(null)
const checkingUpdate = ref(false)
const updateCheckError = ref<string | null>(null)

// Hytale Auth status
const hytaleAuthStatus = ref<HytaleAuthStatus>({ authenticated: false })
const showAuthBanner = ref(false)
const showMemoryOnlyWarning = ref(false)
const enablingPersistence = ref(false)

// Scheduler status
const schedulerStatus = ref<SchedulerStatus | null>(null)

// Panel patchline setting (fallback when plugin not available)
const panelPatchline = ref<string | null>(null)

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

async function checkHytaleAuth() {
  try {
    // Check if server is running
    if (status.value?.running) {
      // First verify auth status with the backend
      const checkResult = await authApi.checkHytaleAuthCompletion()

      // Then get the updated status (which may have been modified by checkHytaleAuthCompletion)
      const authStatus = await authApi.getHytaleAuthStatus()
      hytaleAuthStatus.value = authStatus

      // Show banner only if not authenticated
      if (!authStatus.authenticated) {
        showAuthBanner.value = true
        showMemoryOnlyWarning.value = false
      } else {
        showAuthBanner.value = false

        // Show memory-only warning if authenticated but not persistent
        if (authStatus.persistenceType === 'memory' || (!authStatus.persistent && authStatus.authenticated)) {
          showMemoryOnlyWarning.value = true
        } else {
          showMemoryOnlyWarning.value = false
        }
      }
    } else {
      // Server not running - just get the status without checking
      const authStatus = await authApi.getHytaleAuthStatus()
      hytaleAuthStatus.value = authStatus
      showAuthBanner.value = false
      showMemoryOnlyWarning.value = false
    }
  } catch (err) {
    console.error('Failed to check Hytale auth:', err)
  }
}

function goToSettings() {
  router.push('/settings')
}

async function enablePersistence() {
  enablingPersistence.value = true
  try {
    const result = await authApi.setHytalePersistence('Encrypted')
    if (result.success) {
      // Refresh auth status to update the UI
      await checkHytaleAuth()
    }
  } catch (err) {
    console.error('Failed to enable persistence:', err)
  } finally {
    enablingPersistence.value = false
  }
}

async function fetchSchedulerStatus() {
  try {
    schedulerStatus.value = await schedulerApi.getStatus()
  } catch {
    // Silently fail
  }
}

async function fetchPanelPatchline() {
  try {
    const response = await serverApi.getPatchline()
    panelPatchline.value = response.patchline
  } catch {
    // Silently fail
  }
}

// Computed: Always use panel patchline setting (that's what the user configured)
// The plugin patchline shows what's currently running, but panel setting is the source of truth
const displayPatchline = computed(() => panelPatchline.value || patchline.value)

onMounted(() => {
  fetchServerMemory()
  checkHytaleAuth()
  fetchSchedulerStatus()
  fetchPanelPatchline()
  memoryInterval = setInterval(() => {
    fetchServerMemory()
    checkHytaleAuth()
    fetchSchedulerStatus()
  }, 10000) // Every 10 seconds
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
  // Prefer plugin uptime (more accurate - actual JVM uptime)
  if (pluginAvailable.value && uptimeSeconds.value !== null) {
    const totalSeconds = uptimeSeconds.value
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)

    if (hours > 24) {
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h`
    }
    return `${hours}h ${minutes}m`
  }

  // Fall back to Docker container uptime
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

// TPS value from plugin
const tpsValue = computed(() => {
  if (!pluginAvailable.value || tps.value === null) return null
  return tps.value.toFixed(1)
})

// TPS status color
const tpsStatus = computed((): 'success' | 'warning' | 'error' => {
  if (!tps.value) return 'info' as 'success'
  if (tps.value >= 19) return 'success'
  if (tps.value >= 15) return 'warning'
  return 'error'
})

// Player count with max players
const playerCountDisplay = computed(() => {
  if (maxPlayers.value) {
    return `${playerCount.value} / ${maxPlayers.value}`
  }
  return playerCount.value.toString()
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
    <!-- Server Authentication Required Banner (after download complete) -->
    <div
      v-if="showAuthBanner && status?.running && hytaleAuthStatus.serverAuthRequired && hytaleAuthStatus.authType === 'downloader'"
      class="bg-gradient-to-r from-hytale-orange/30 to-status-success/20 border-2 border-hytale-orange rounded-lg p-4"
    >
      <div class="flex items-start gap-4">
        <div class="flex-shrink-0">
          <svg class="w-8 h-8 text-hytale-orange animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="text-lg font-semibold text-white mb-1">
            {{ t('dashboard.downloadComplete') }}
          </h3>
          <p class="text-gray-300 text-sm mb-3">
            {{ t('dashboard.downloadCompleteDesc') }}
          </p>
          <button
            @click="goToSettings"
            class="btn btn-primary inline-flex items-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            {{ t('dashboard.authenticateServer') }}
          </button>
        </div>
        <button
          @click="showAuthBanner = false"
          class="flex-shrink-0 text-gray-400 hover:text-white"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- General Authentication Banner -->
    <div
      v-else-if="showAuthBanner && status?.running"
      class="bg-gradient-to-r from-status-warning/20 to-hytale-orange/20 border-2 border-status-warning rounded-lg p-4"
    >
      <div class="flex items-start gap-4">
        <div class="flex-shrink-0">
          <svg class="w-8 h-8 text-status-warning animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="text-lg font-semibold text-white mb-1">
            {{ hytaleAuthStatus.authenticated ? t('dashboard.authExpired') : t('dashboard.authRequired') }}
          </h3>
          <p class="text-gray-300 text-sm mb-3">
            {{ hytaleAuthStatus.authenticated ? t('dashboard.authExpiredDesc') : t('dashboard.authRequiredDesc') }}
          </p>
          <button
            @click="goToSettings"
            class="btn btn-primary inline-flex items-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            {{ t('dashboard.authenticateNow') }}
          </button>
        </div>
        <button
          @click="showAuthBanner = false"
          class="flex-shrink-0 text-gray-400 hover:text-white"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Memory-Only Auth Warning Banner -->
    <div
      v-if="showMemoryOnlyWarning && status?.running"
      class="bg-gradient-to-r from-hytale-orange/20 to-status-warning/20 border-2 border-hytale-orange rounded-lg p-4"
    >
      <div class="flex items-start gap-4">
        <div class="flex-shrink-0">
          <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="text-lg font-semibold text-white mb-1">
            {{ t('dashboard.authMemoryOnly') }}
          </h3>
          <p class="text-gray-300 text-sm mb-3">
            {{ t('dashboard.authMemoryOnlyDesc') }}
          </p>
          <button
            @click="enablePersistence"
            :disabled="enablingPersistence"
            class="btn btn-primary inline-flex items-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
            {{ enablingPersistence ? t('dashboard.enablingPersistence') : t('dashboard.enablePersistence') }}
          </button>
        </div>
        <button
          @click="showMemoryOnlyWarning = false"
          class="flex-shrink-0 text-gray-400 hover:text-white"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

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

    <!-- Plugin Status Banner -->
    <PluginBanner />

    <!-- Status Cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
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
        :value="playerCountDisplay"
        status="info"
        icon="players"
      />

      <!-- TPS Card (only when plugin is available) -->
      <StatusCard
        v-if="pluginAvailable && tpsValue"
        title="TPS"
        :value="tpsValue"
        :status="tpsStatus"
        icon="cpu"
      />

      <!-- Auth Status Card -->
      <div class="card" :class="hytaleAuthStatus.authenticated ? 'border-status-success' : 'border-status-warning'">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="flex-shrink-0">
              <svg
                v-if="hytaleAuthStatus.authenticated"
                class="w-6 h-6 text-status-success"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <svg
                v-else
                class="w-6 h-6 text-status-warning animate-pulse"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-xs text-gray-400 mb-1">{{ t('settings.authStatus') }}</p>
              <p class="text-sm font-semibold truncate" :class="hytaleAuthStatus.authenticated ? 'text-status-success' : 'text-status-warning'">
                {{ hytaleAuthStatus.authenticated ? t('settings.authenticated') : t('settings.notAuthenticated') }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Scheduler Status Cards -->
    <div v-if="schedulerStatus" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <!-- Backup Status Card -->
      <div class="card">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="flex-shrink-0">
              <div class="w-10 h-10 rounded-lg flex items-center justify-center" :class="schedulerStatus.backups.enabled ? 'bg-hytale-orange/20' : 'bg-gray-600/20'">
                <svg class="w-5 h-5" :class="schedulerStatus.backups.enabled ? 'text-hytale-orange' : 'text-gray-500'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                </svg>
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-xs text-gray-400 mb-0.5">{{ t('dashboard.backupStatus') }}</p>
              <p v-if="!schedulerStatus.backups.enabled" class="text-sm text-gray-500">{{ t('dashboard.backupsDisabled') }}</p>
              <template v-else>
                <p v-if="schedulerStatus.backups.lastRun" class="text-xs text-gray-400">
                  {{ t('scheduler.lastBackup') }}: {{ new Date(schedulerStatus.backups.lastRun).toLocaleString() }}
                </p>
                <p v-if="schedulerStatus.backups.nextRun" class="text-sm font-medium text-hytale-orange">
                  {{ t('scheduler.nextBackup') }}: {{ new Date(schedulerStatus.backups.nextRun).toLocaleTimeString() }}
                </p>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Restart Status Card -->
      <div class="card" :class="schedulerStatus.scheduledRestarts.pendingRestart ? 'border-status-warning' : ''">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="flex-shrink-0">
              <div class="w-10 h-10 rounded-lg flex items-center justify-center" :class="schedulerStatus.scheduledRestarts.enabled ? 'bg-hytale-orange/20' : 'bg-gray-600/20'">
                <svg class="w-5 h-5" :class="schedulerStatus.scheduledRestarts.pendingRestart ? 'text-status-warning animate-pulse' : (schedulerStatus.scheduledRestarts.enabled ? 'text-hytale-orange' : 'text-gray-500')" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-xs text-gray-400 mb-0.5">{{ t('dashboard.restartStatus') }}</p>
              <p v-if="!schedulerStatus.scheduledRestarts.enabled" class="text-sm text-gray-500">{{ t('dashboard.restartsDisabled') }}</p>
              <template v-else>
                <p v-if="schedulerStatus.scheduledRestarts.pendingRestart" class="text-sm font-medium text-status-warning">
                  {{ t('scheduler.pendingRestart') }}: {{ new Date(schedulerStatus.scheduledRestarts.pendingRestart.scheduledAt).toLocaleTimeString() }}
                </p>
                <p v-else-if="schedulerStatus.scheduledRestarts.nextRestart" class="text-sm font-medium text-hytale-orange">
                  {{ t('scheduler.nextRestart') }}: {{ new Date(schedulerStatus.scheduledRestarts.nextRestart).toLocaleTimeString() }}
                </p>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Announcements Status Card -->
      <div class="card">
        <div class="card-body p-4">
          <div class="flex items-center gap-3">
            <div class="flex-shrink-0">
              <div class="w-10 h-10 rounded-lg flex items-center justify-center" :class="schedulerStatus.announcements.enabled ? 'bg-hytale-orange/20' : 'bg-gray-600/20'">
                <svg class="w-5 h-5" :class="schedulerStatus.announcements.enabled ? 'text-hytale-orange' : 'text-gray-500'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                </svg>
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-xs text-gray-400 mb-0.5">{{ t('dashboard.announcementsStatus') }}</p>
              <p v-if="!schedulerStatus.announcements.enabled" class="text-sm text-gray-500">{{ t('dashboard.announcementsDisabled') }}</p>
              <p v-else class="text-sm font-medium text-hytale-orange">
                {{ schedulerStatus.announcements.activeCount }} {{ t('dashboard.activeAnnouncements') }}
              </p>
            </div>
          </div>
        </div>
      </div>
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
        <div class="card-header flex items-center justify-between">
          <h3 class="text-lg font-semibold text-white">Server Info</h3>
          <span
            v-if="pluginAvailable"
            class="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400 border border-green-500/30"
          >
            Plugin API
          </span>
        </div>
        <div class="card-body">
          <div class="space-y-3">
            <!-- Plugin data (when available) -->
            <template v-if="pluginAvailable">
              <div class="flex justify-between">
                <span class="text-gray-400">Version</span>
                <span class="text-white font-mono">{{ serverVersion || '-' }}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">Worlds</span>
                <span class="text-white">{{ worldCount ?? '-' }}</span>
              </div>
            </template>
            <!-- Container info -->
            <div class="flex justify-between">
              <span class="text-gray-400">Container</span>
              <span class="text-white font-mono">{{ status?.name || '-' }}</span>
            </div>
            <div v-if="!pluginAvailable" class="flex justify-between">
              <span class="text-gray-400">Container ID</span>
              <span class="text-white font-mono text-xs">{{ status?.id || '-' }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-400">Status</span>
              <span :class="status?.running ? 'text-status-success' : 'text-status-error'">
                {{ status?.status || '-' }}
              </span>
            </div>
            <!-- Patchline (always visible) -->
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Patchline</span>
              <span
                v-if="displayPatchline"
                :class="[
                  'px-2 py-0.5 rounded text-xs font-medium',
                  displayPatchline === 'release'
                    ? 'bg-status-success/20 text-status-success'
                    : 'bg-status-warning/20 text-status-warning'
                ]"
              >
                {{ displayPatchline === 'release' ? 'Release' : 'Pre-Release' }}
              </span>
              <span v-else class="text-white font-mono">-</span>
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
