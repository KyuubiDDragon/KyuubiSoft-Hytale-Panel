<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { serverApi, type PluginStatus, type PluginUpdateCheck } from '@/api/server'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()

const pluginStatus = ref<PluginStatus | null>(null)
const updateInfo = ref<PluginUpdateCheck | null>(null)
const loading = ref(true)
const installing = ref(false)
const updating = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

const showBanner = computed(() => {
  if (!pluginStatus.value) return false
  // Show banner if plugin is not installed, not running, or update available
  return !pluginStatus.value.installed || !pluginStatus.value.running || updateInfo.value?.available
})

const bannerType = computed(() => {
  if (!pluginStatus.value) return 'info'
  if (!pluginStatus.value.installed) return 'warning'
  if (updateInfo.value?.available) return 'warning'
  if (!pluginStatus.value.running) return 'info'
  return 'success'
})

const bannerIcon = computed(() => {
  if (!pluginStatus.value?.installed) return 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
  return 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
})

async function loadPluginStatus() {
  try {
    loading.value = true
    error.value = null
    pluginStatus.value = await serverApi.getPluginStatus()
    // Check for updates if plugin is installed
    if (pluginStatus.value?.installed) {
      updateInfo.value = await serverApi.checkPluginUpdate()
    }
  } catch (err) {
    console.error('Failed to load plugin status:', err)
    error.value = err instanceof Error ? err.message : 'Failed to load plugin status'
  } finally {
    loading.value = false
  }
}

async function installPlugin() {
  try {
    installing.value = true
    error.value = null
    successMessage.value = null

    const result = await serverApi.installPlugin()

    if (result.success) {
      successMessage.value = result.message || t('dashboard.plugin.installSuccess')
      // Reload status
      await loadPluginStatus()
    } else {
      error.value = result.error || t('dashboard.plugin.installFailed')
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('dashboard.plugin.installFailed')
  } finally {
    installing.value = false
  }
}

async function updatePlugin() {
  try {
    updating.value = true
    error.value = null
    successMessage.value = null

    const result = await serverApi.installPlugin()

    if (result.success) {
      successMessage.value = t('dashboard.plugin.updateSuccess')
      // Reload status
      await loadPluginStatus()
    } else {
      error.value = result.error || t('dashboard.plugin.updateFailed')
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('dashboard.plugin.updateFailed')
  } finally {
    updating.value = false
  }
}

onMounted(() => {
  loadPluginStatus()
})
</script>

<template>
  <div
    v-if="showBanner && !loading"
    class="mb-4 rounded-lg p-4 border"
    :class="{
      'bg-yellow-900/20 border-yellow-700/50 text-yellow-200': bannerType === 'warning',
      'bg-blue-900/20 border-blue-700/50 text-blue-200': bannerType === 'info',
      'bg-green-900/20 border-green-700/50 text-green-200': bannerType === 'success',
    }"
  >
    <div class="flex items-start gap-3">
      <svg class="w-6 h-6 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="bannerIcon" />
      </svg>

      <div class="flex-1">
        <h3 class="font-semibold text-base">
          <template v-if="!pluginStatus?.installed">
            {{ t('dashboard.plugin.notInstalled') }}
          </template>
          <template v-else-if="updateInfo?.available">
            {{ t('dashboard.plugin.updateAvailable') }}
          </template>
          <template v-else>
            {{ t('dashboard.plugin.notRunning') }}
          </template>
        </h3>

        <p class="text-sm opacity-80 mt-1">
          <template v-if="!pluginStatus?.installed">
            {{ t('dashboard.plugin.installHint') }}
          </template>
          <template v-else-if="updateInfo?.available">
            {{ t('dashboard.plugin.updateHint', { current: updateInfo.currentVersion, latest: updateInfo.latestVersion }) }}
          </template>
          <template v-else>
            {{ t('dashboard.plugin.restartHint') }}
          </template>
        </p>

        <!-- Error message -->
        <p v-if="error" class="text-sm text-red-400 mt-2">
          {{ error }}
        </p>

        <!-- Success message -->
        <p v-if="successMessage" class="text-sm text-green-400 mt-2">
          {{ successMessage }}
        </p>

        <!-- Install button -->
        <div v-if="!pluginStatus?.installed" class="mt-3">
          <Button
            :disabled="installing"
            size="sm"
            @click="installPlugin"
          >
            <svg v-if="installing" class="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ installing ? t('dashboard.plugin.installing') : t('dashboard.plugin.install') }}
          </Button>
        </div>

        <!-- Update button -->
        <div v-if="pluginStatus?.installed && updateInfo?.available" class="mt-3">
          <Button
            :disabled="updating"
            size="sm"
            @click="updatePlugin"
          >
            <svg v-if="updating" class="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ updating ? t('dashboard.plugin.updating') : t('dashboard.plugin.update') }}
          </Button>
        </div>

        <!-- Version info when installed -->
        <p v-if="pluginStatus?.installed && pluginStatus?.version" class="text-xs opacity-60 mt-2">
          {{ t('dashboard.plugin.version') }}: {{ pluginStatus.version }}
        </p>
      </div>

      <!-- Close/dismiss button could go here -->
    </div>
  </div>
</template>
