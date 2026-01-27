<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import Card from '@/components/ui/Card.vue'
import {
  modupdatesApi,
  modsApi,
  type TrackedMod,
  type ModUpdateStatus,
  type ModInfo,
} from '@/api/management'

const { t } = useI18n()
const authStore = useAuthStore()

// State
const loading = ref(true)
const checking = ref(false)
const error = ref('')
const updateStatus = ref<ModUpdateStatus | null>(null)
const installedMods = ref<ModInfo[]>([])

// Track mod dialog
const showTrackDialog = ref(false)
const trackFilename = ref('')
const trackCurseforgeInput = ref('')
const trackCurrentVersion = ref('')
const tracking = ref(false)
const trackError = ref('')

// Untrack state
const untrackingFilename = ref<string | null>(null)

// Get mods that are not yet tracked
const untrackedMods = computed(() => {
  if (!updateStatus.value) return installedMods.value
  const trackedFilenames = updateStatus.value.mods.map(m => m.filename)
  return installedMods.value.filter(m => !trackedFilenames.includes(m.filename) && m.enabled)
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [statusResult, modsResult] = await Promise.all([
      modupdatesApi.getStatus(),
      authStore.hasPermission('mods.view') ? modsApi.get() : Promise.resolve({ mods: [], path: '' }),
    ])
    updateStatus.value = statusResult
    installedMods.value = modsResult.mods
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load data'
  } finally {
    loading.value = false
  }
}

async function checkAllUpdates() {
  checking.value = true
  error.value = ''
  try {
    updateStatus.value = await modupdatesApi.checkAll()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to check updates'
  } finally {
    checking.value = false
  }
}

function openTrackDialog(mod?: ModInfo) {
  trackFilename.value = mod?.filename || ''
  trackCurseforgeInput.value = ''
  trackCurrentVersion.value = ''
  trackError.value = ''
  showTrackDialog.value = true
}

async function trackMod() {
  if (!trackFilename.value || !trackCurseforgeInput.value) {
    trackError.value = t('modupdates.invalidUrl')
    return
  }

  tracking.value = true
  trackError.value = ''
  try {
    const result = await modupdatesApi.track(
      trackFilename.value,
      trackCurseforgeInput.value,
      trackCurrentVersion.value || undefined
    )
    if (result.success) {
      showTrackDialog.value = false
      await loadData()
    } else {
      trackError.value = result.error || t('modupdates.trackError')
    }
  } catch (err) {
    trackError.value = err instanceof Error ? err.message : t('modupdates.trackError')
  } finally {
    tracking.value = false
  }
}

async function untrackMod(filename: string) {
  untrackingFilename.value = filename
  try {
    await modupdatesApi.untrack(filename)
    await loadData()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to untrack mod'
  } finally {
    untrackingFilename.value = null
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return t('modupdates.never')
  return new Date(dateStr).toLocaleString()
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('modupdates.title') }}</h1>
        <p class="text-gray-400 text-sm mt-1">
          {{ t('modupdates.lastChecked') }}: {{ formatDate(updateStatus?.lastChecked || null) }}
        </p>
      </div>
      <div class="flex gap-2">
        <button
          class="btn btn-secondary"
          :disabled="checking"
          @click="checkAllUpdates"
        >
          <svg v-if="checking" class="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <svg v-else class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('modupdates.checkAll') }}
        </button>
        <button
          v-if="authStore.hasPermission('mods.edit')"
          class="btn btn-primary"
          @click="openTrackDialog()"
        >
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          {{ t('modupdates.trackMod') }}
        </button>
      </div>
    </div>

    <!-- Error Alert -->
    <div v-if="error" class="bg-red-500/10 border border-red-500/50 rounded-lg p-4 text-red-400">
      {{ error }}
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="flex items-center justify-center py-12">
      <svg class="w-8 h-8 animate-spin text-hytale-orange" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <!-- Status Summary -->
    <div v-else-if="updateStatus" class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-lg bg-hytale-orange/20 flex items-center justify-center">
            <svg class="w-6 h-6 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <div>
            <p class="text-gray-400 text-sm">{{ t('modupdates.tracked') }}</p>
            <p class="text-2xl font-bold text-white">{{ updateStatus.totalTracked }}</p>
          </div>
        </div>
      </Card>

      <Card>
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-lg flex items-center justify-center" :class="updateStatus.updatesAvailable > 0 ? 'bg-status-warning/20' : 'bg-status-success/20'">
            <svg class="w-6 h-6" :class="updateStatus.updatesAvailable > 0 ? 'text-status-warning' : 'text-status-success'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </div>
          <div>
            <p class="text-gray-400 text-sm">{{ t('modupdates.available') }}</p>
            <p class="text-2xl font-bold" :class="updateStatus.updatesAvailable > 0 ? 'text-status-warning' : 'text-status-success'">
              {{ updateStatus.updatesAvailable }}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <svg class="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p class="text-gray-400 text-sm">{{ t('modupdates.autoCheck') }}</p>
            <p class="text-lg font-medium text-white">1h</p>
          </div>
        </div>
      </Card>
    </div>

    <!-- Tracked Mods List -->
    <Card v-if="!loading && updateStatus">
      <template #header>
        <h2 class="text-lg font-semibold text-white">{{ t('modupdates.tracked') }}</h2>
      </template>

      <div v-if="updateStatus.mods.length === 0" class="text-center py-8 text-gray-400">
        {{ t('modupdates.noTrackedMods') }}
      </div>

      <div v-else class="divide-y divide-gray-700">
        <div
          v-for="mod in updateStatus.mods"
          :key="mod.filename"
          class="py-4 first:pt-0 last:pb-0"
        >
          <div class="flex items-center gap-4">
            <!-- Thumbnail -->
            <div class="flex-shrink-0">
              <img
                v-if="mod.thumbnail"
                :src="mod.thumbnail"
                :alt="mod.projectTitle"
                class="w-12 h-12 rounded-lg object-cover"
              />
              <div v-else class="w-12 h-12 rounded-lg bg-gray-700 flex items-center justify-center">
                <svg class="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
              </div>
            </div>

            <!-- Info -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-medium text-white truncate">{{ mod.projectTitle || mod.filename }}</h3>
                <span
                  v-if="mod.hasUpdate"
                  class="px-2 py-0.5 text-xs rounded-full bg-status-warning/20 text-status-warning"
                >
                  {{ t('modupdates.updateAvailable') }}
                </span>
                <span
                  v-else
                  class="px-2 py-0.5 text-xs rounded-full bg-status-success/20 text-status-success"
                >
                  {{ t('modupdates.noUpdate') }}
                </span>
              </div>
              <p class="text-sm text-gray-400 truncate">{{ mod.filename }}</p>
              <div class="flex items-center gap-4 mt-1 text-xs text-gray-500">
                <span>{{ t('modupdates.installedVersion') }}: {{ mod.installedVersion || '-' }}</span>
                <span>{{ t('modupdates.latestVersion') }}: {{ mod.latestVersion || '-' }}</span>
              </div>
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-2">
              <a
                v-if="mod.projectUrl"
                :href="mod.projectUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-sm btn-secondary"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              <button
                v-if="authStore.hasPermission('mods.edit')"
                class="btn btn-sm btn-danger"
                :disabled="untrackingFilename === mod.filename"
                @click="untrackMod(mod.filename)"
              >
                <svg v-if="untrackingFilename === mod.filename" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Card>

    <!-- Track Mod Dialog -->
    <Teleport to="body">
      <div v-if="showTrackDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
        <div class="bg-gray-800 rounded-xl shadow-xl max-w-md w-full">
          <div class="p-6">
            <h3 class="text-lg font-semibold text-white mb-4">{{ t('modupdates.trackMod') }}</h3>

            <!-- Error -->
            <div v-if="trackError" class="mb-4 p-3 bg-red-500/10 border border-red-500/50 rounded-lg text-red-400 text-sm">
              {{ trackError }}
            </div>

            <!-- Form -->
            <div class="space-y-4">
              <!-- Filename Select or Input -->
              <div>
                <label class="block text-sm font-medium text-gray-300 mb-1">{{ t('modupdates.filename') }}</label>
                <select
                  v-if="untrackedMods.length > 0"
                  v-model="trackFilename"
                  class="input w-full"
                >
                  <option value="">-- {{ t('common.select') }} --</option>
                  <option v-for="mod in untrackedMods" :key="mod.filename" :value="mod.filename">
                    {{ mod.filename }}
                  </option>
                </select>
                <input
                  v-else
                  v-model="trackFilename"
                  type="text"
                  class="input w-full"
                  :placeholder="t('modupdates.filename')"
                />
              </div>

              <!-- CurseForge URL/Slug -->
              <div>
                <label class="block text-sm font-medium text-gray-300 mb-1">{{ t('modupdates.curseforgeUrl') }}</label>
                <input
                  v-model="trackCurseforgeInput"
                  type="text"
                  class="input w-full"
                  :placeholder="t('modupdates.curseforgeUrlHint')"
                />
              </div>

              <!-- Current Version (optional) -->
              <div>
                <label class="block text-sm font-medium text-gray-300 mb-1">{{ t('modupdates.installedVersion') }} (optional)</label>
                <input
                  v-model="trackCurrentVersion"
                  type="text"
                  class="input w-full"
                  placeholder="1.0.0"
                />
              </div>
            </div>

            <!-- Actions -->
            <div class="flex justify-end gap-2 mt-6">
              <button class="btn btn-secondary" @click="showTrackDialog = false">
                {{ t('common.cancel') }}
              </button>
              <button
                class="btn btn-primary"
                :disabled="tracking || !trackFilename || !trackCurseforgeInput"
                @click="trackMod"
              >
                <svg v-if="tracking" class="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {{ t('modupdates.trackMod') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
