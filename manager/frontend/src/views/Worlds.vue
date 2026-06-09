<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { worldsApi, type WorldInfo, type WorldConfig, type WorldBackup, type PregenStatus } from '@/api/management'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Icon from '@/components/ui/Icon.vue'

const { t } = useI18n()
const authStore = useAuthStore()
const { addToast } = useToast()
const { ask } = useConfirm()

// ===== World tools (backup / restore / upload / pregen) =====
const canManageWorlds = computed(() => authStore.hasPermission('worlds.manage'))
const worldBackups = ref<WorldBackup[]>([])
const worldToolsBusy = ref(false)
const uploadingWorld = ref(false)
const pregen = ref<PregenStatus>({ state: 'idle', world: null, radius: null, percent: 0, chunksDone: null, chunksTotal: null, startedAt: null })
const pregenWorld = ref('')
const pregenRadius = ref(8)
let pregenTimer: ReturnType<typeof setInterval> | null = null

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

async function loadWorldBackups() {
  try {
    worldBackups.value = (await worldsApi.listBackups()).backups
  } catch { /* ignore */ }
}

async function refreshPregen() {
  try {
    pregen.value = await worldsApi.getPregenStatus()
  } catch { /* ignore */ }
}

async function backupOneWorld(name: string) {
  worldToolsBusy.value = true
  try {
    const r = await worldsApi.backup(name)
    if (r.success) {
      addToast(t('worlds.tools.backupCreated', { name }), 'success')
      await loadWorldBackups()
    } else {
      addToast(r.error || t('errors.serverError'), 'error')
    }
  } finally {
    worldToolsBusy.value = false
  }
}

async function restoreWorldBackup(b: WorldBackup) {
  const ok = await ask({
    title: t('worlds.tools.restoreTitle'),
    message: t('worlds.tools.restoreConfirm', { world: b.world }),
    variant: 'danger',
    confirmText: t('worlds.tools.restore'),
  })
  if (!ok) return
  worldToolsBusy.value = true
  try {
    const r = await worldsApi.restoreBackup(b.id)
    if (r.success) {
      addToast(t('worlds.tools.restored'), 'success')
      await loadWorlds()
    } else {
      addToast(r.error || t('errors.serverError'), 'error')
    }
  } finally {
    worldToolsBusy.value = false
  }
}

async function deleteWorldBackup(b: WorldBackup) {
  const ok = await ask({ title: t('common.delete'), message: t('worlds.tools.deleteBackupConfirm'), variant: 'danger', confirmText: t('common.delete') })
  if (!ok) return
  try {
    await worldsApi.deleteBackup(b.id)
    await loadWorldBackups()
  } catch {
    addToast(t('errors.serverError'), 'error')
  }
}

async function onWorldUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadingWorld.value = true
  try {
    const r = await worldsApi.uploadWorld(file)
    if (r.success) {
      addToast(t('worlds.tools.uploaded'), 'success')
      await loadWorlds()
    } else {
      addToast(r.error || t('errors.serverError'), 'error')
    }
  } catch (e: any) {
    addToast(e?.response?.data?.error || t('errors.serverError'), 'error')
  } finally {
    uploadingWorld.value = false
    input.value = ''
  }
}

async function startWorldPregen() {
  if (!pregenWorld.value) return
  worldToolsBusy.value = true
  try {
    const r = await worldsApi.startPregen(pregenWorld.value, pregenRadius.value)
    if (r.success) {
      addToast(t('worlds.tools.pregenStarted'), 'success')
      await refreshPregen()
    } else {
      addToast(r.error || t('errors.serverError'), 'error')
    }
  } finally {
    worldToolsBusy.value = false
  }
}

async function cancelWorldPregen() {
  try {
    await worldsApi.cancelPregen()
    await refreshPregen()
  } catch {
    addToast(t('errors.serverError'), 'error')
  }
}

// State
const worlds = ref<WorldInfo[]>([])
const selectedWorld = ref<string | null>(null)
const selectedFile = ref<string | null>(null) // File path within world
const worldConfig = ref<WorldConfig | null>(null)
const fileContent = ref<string>('')
const loading = ref(true)
const loadingFile = ref(false)
const saving = ref(false)
const error = ref('')
const saveSuccess = ref(false)
const expandedWorlds = ref<Set<string>>(new Set())

// Editable form state (for config.json special handling)
const form = ref<Partial<WorldConfig>>({})

// Edit mode for config.json: 'form' or 'text'
const configEditMode = ref<'form' | 'text'>('form')
const configRawText = ref<string>('')

// Danger zone confirmation dialog
const dangerConfirmDialog = ref({
  show: false,
  type: '' as 'deleteOnUniverseStart' | 'deleteOnRemove',
  title: '',
  message: ''
})

// Handle danger zone checkbox clicks with confirmation
function onDangerCheckboxChange(type: 'deleteOnUniverseStart' | 'deleteOnRemove', event: Event) {
  const checkbox = event.target as HTMLInputElement
  const newValue = checkbox.checked

  // If unchecking, allow without confirmation
  if (!newValue) {
    form.value[type] = false
    return
  }

  // If checking, show confirmation dialog
  checkbox.checked = false // Prevent immediate check

  if (type === 'deleteOnUniverseStart') {
    dangerConfirmDialog.value = {
      show: true,
      type: 'deleteOnUniverseStart',
      title: t('worlds.dangerZone.confirmDeleteOnUniverseStart.title'),
      message: t('worlds.dangerZone.confirmDeleteOnUniverseStart.message')
    }
  } else {
    dangerConfirmDialog.value = {
      show: true,
      type: 'deleteOnRemove',
      title: t('worlds.dangerZone.confirmDeleteOnRemove.title'),
      message: t('worlds.dangerZone.confirmDeleteOnRemove.message')
    }
  }
}

function confirmDangerAction() {
  form.value[dangerConfirmDialog.value.type] = true
  dangerConfirmDialog.value.show = false
}

function cancelDangerAction() {
  dangerConfirmDialog.value.show = false
}

// Computed: Is the selected file config.json?
const isConfigJson = computed(() => selectedFile.value === 'config.json')

// Computed: Get selected world's files
const selectedWorldFiles = computed(() => {
  const world = worlds.value.find(w => w.name === selectedWorld.value)
  if (!world || !world.files) return { root: [], resources: [] }

  const root = world.files.filter(f => !f.path.includes('/'))
  const resources = world.files.filter(f => f.path.startsWith('resources/'))

  return { root, resources }
})

async function loadWorlds() {
  loading.value = true
  error.value = ''
  try {
    const data = await worldsApi.get()
    worlds.value = data.worlds
    // Auto-expand first world
    if (data.worlds.length > 0) {
      expandedWorlds.value.add(data.worlds[0].name)
      if (!selectedWorld.value) {
        selectedWorld.value = data.worlds[0].name
        // Auto-select config.json
        const world = data.worlds[0]
        if (world.files && world.files.length > 0) {
          const configFile = world.files.find(f => f.path === 'config.json')
          if (configFile) {
            selectFile(world.name, configFile.path)
          }
        }
      }
    }
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

function toggleWorld(worldName: string) {
  if (expandedWorlds.value.has(worldName)) {
    expandedWorlds.value.delete(worldName)
  } else {
    expandedWorlds.value.add(worldName)
  }
  // Also select this world
  selectedWorld.value = worldName
}

async function selectFile(worldName: string, filePath: string) {
  selectedWorld.value = worldName
  selectedFile.value = filePath
  loadingFile.value = true
  error.value = ''
  saveSuccess.value = false

  try {
    if (filePath === 'config.json') {
      // Use specialized config endpoint for config.json
      worldConfig.value = await worldsApi.getConfig(worldName)
      // Initialize form with current values
      form.value = {
        isTicking: worldConfig.value.isTicking,
        isBlockTicking: worldConfig.value.isBlockTicking,
        isPvpEnabled: worldConfig.value.isPvpEnabled,
        isFallDamageEnabled: worldConfig.value.isFallDamageEnabled,
        isGameTimePaused: worldConfig.value.isGameTimePaused,
        isSpawningNPC: worldConfig.value.isSpawningNPC,
        isAllNPCFrozen: worldConfig.value.isAllNPCFrozen,
        isSpawnMarkersEnabled: worldConfig.value.isSpawnMarkersEnabled,
        isObjectiveMarkersEnabled: worldConfig.value.isObjectiveMarkersEnabled,
        isSavingPlayers: worldConfig.value.isSavingPlayers,
        isSavingChunks: worldConfig.value.isSavingChunks,
        saveNewChunks: worldConfig.value.saveNewChunks,
        isUnloadingChunks: worldConfig.value.isUnloadingChunks,
        isCompassUpdating: worldConfig.value.isCompassUpdating,
        gameplayConfig: worldConfig.value.gameplayConfig,
        deleteOnUniverseStart: worldConfig.value.deleteOnUniverseStart,
        deleteOnRemove: worldConfig.value.deleteOnRemove,
        daytimeDurationSecondsOverride: worldConfig.value.daytimeDurationSecondsOverride,
        nighttimeDurationSecondsOverride: worldConfig.value.nighttimeDurationSecondsOverride,
        clientEffects: worldConfig.value.clientEffects ? { ...worldConfig.value.clientEffects } : {},
      }
      // Store raw JSON for text editor mode
      configRawText.value = JSON.stringify(worldConfig.value.raw, null, 2)
      fileContent.value = ''
    } else {
      // Use generic file endpoint for other files
      const data = await worldsApi.getFile(worldName, filePath)
      fileContent.value = JSON.stringify(data.content, null, 2)
      worldConfig.value = null
    }
  } catch (e) {
    error.value = t('worlds.loadFailed', { file: filePath })
    worldConfig.value = null
    fileContent.value = ''
  } finally {
    loadingFile.value = false
  }
}

async function saveFile() {
  if (!selectedWorld.value || !selectedFile.value) return

  saving.value = true
  error.value = ''
  saveSuccess.value = false

  try {
    if (selectedFile.value === 'config.json') {
      if (configEditMode.value === 'text') {
        // Save raw JSON text directly as file content
        const content = JSON.parse(configRawText.value)
        await worldsApi.updateFile(selectedWorld.value, 'config.json', content)
      } else {
        // Use specialized config endpoint for form mode
        await worldsApi.updateConfig(selectedWorld.value, form.value)
      }
    } else {
      // Parse and save generic file
      const content = JSON.parse(fileContent.value)
      await worldsApi.updateFile(selectedWorld.value, selectedFile.value, content)
    }
    saveSuccess.value = true
    setTimeout(() => saveSuccess.value = false, 3000)
  } catch (e) {
    if (e instanceof SyntaxError) {
      error.value = t('worlds.invalidJson')
    } else {
      error.value = t('worlds.saveFailed')
    }
  } finally {
    saving.value = false
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

onMounted(async () => {
  await loadWorlds()
  if (authStore.hasPermission('worlds.view')) {
    await loadWorldBackups()
    await refreshPregen()
    // Poll pregen progress while a job is active.
    pregenTimer = setInterval(() => {
      if (pregen.value.state === 'running') void refreshPregen()
    }, 4000)
  }
})

onUnmounted(() => {
  if (pregenTimer) clearInterval(pregenTimer)
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('worlds.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('worlds.subtitle') }}</p>
      </div>
      <button @click="loadWorlds" class="p-2 text-ink-muted hover:text-ink transition-colors" :aria-label="t('common.refresh')">
        <Icon name="refresh" class="w-5 h-5" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- World Tools: backup / restore / upload / pregeneration -->
    <div v-if="!loading && canManageWorlds" class="card">
      <div class="card-header flex items-center justify-between">
        <h3 class="text-lg font-semibold text-ink">{{ t('worlds.tools.title') }}</h3>
        <label class="flex items-center gap-2 px-3 py-1.5 bg-surface-overlay text-ink rounded-lg text-sm cursor-pointer hover:bg-border transition-colors" :class="{ 'opacity-50 pointer-events-none': uploadingWorld }">
          <Icon name="download" class="w-4 h-4 rotate-180" />
          {{ uploadingWorld ? t('worlds.tools.uploading') : t('worlds.tools.upload') }}
          <input type="file" accept=".zip,.tar.gz,.tgz" class="hidden" @change="onWorldUpload" />
        </label>
      </div>
      <div class="card-body space-y-5">
        <!-- Per-world backup buttons + seed -->
        <div>
          <p class="text-sm text-ink-muted mb-2">{{ t('worlds.tools.backupDesc') }}</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="w in worlds"
              :key="'bk-' + w.name"
              @click="backupOneWorld(w.name)"
              :disabled="worldToolsBusy"
              class="flex items-center gap-2 px-3 py-1.5 bg-surface text-ink rounded-lg text-sm hover:bg-surface-overlay transition-colors disabled:opacity-50"
            >
              <Icon name="backup" class="w-4 h-4 text-hytale-orange" />
              {{ w.name }}
            </button>
          </div>
        </div>

        <!-- World backups list -->
        <div>
          <h4 class="text-sm font-medium text-ink-muted uppercase tracking-wider mb-2">{{ t('worlds.tools.backups') }}</h4>
          <div v-if="worldBackups.length === 0" class="text-sm text-ink-subtle">{{ t('worlds.tools.noBackups') }}</div>
          <div v-else class="space-y-2 max-h-56 overflow-y-auto">
            <div v-for="b in worldBackups" :key="b.id" class="flex items-center gap-3 p-2.5 bg-surface rounded-lg text-sm">
              <Icon name="worlds" class="w-4 h-4 text-ink-muted shrink-0" />
              <div class="flex-1 min-w-0">
                <p class="text-ink font-medium truncate">{{ b.world }}</p>
                <p class="text-xs text-ink-subtle">{{ new Date(b.createdAt).toLocaleString() }} · {{ fmtBytes(b.sizeBytes) }}</p>
              </div>
              <button @click="restoreWorldBackup(b)" :disabled="worldToolsBusy" class="px-2.5 py-1 text-xs bg-surface-overlay rounded hover:bg-hytale-orange/20 hover:text-hytale-orange transition-colors disabled:opacity-50">
                {{ t('worlds.tools.restore') }}
              </button>
              <button @click="deleteWorldBackup(b)" class="p-1 text-ink-subtle hover:text-red-400">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Pregeneration -->
        <div class="border-t border-border/60 pt-4">
          <h4 class="text-sm font-medium text-ink-muted uppercase tracking-wider mb-2">{{ t('worlds.tools.pregen') }}</h4>
          <p class="text-xs text-ink-subtle mb-3">{{ t('worlds.tools.pregenDesc') }}</p>

          <div v-if="pregen.state === 'running'" class="space-y-2">
            <div class="flex justify-between text-xs text-ink-muted">
              <span>{{ t('worlds.tools.pregenRunning', { world: pregen.world }) }}</span>
              <span>{{ pregen.percent }}%<span v-if="pregen.chunksTotal"> · {{ pregen.chunksDone }}/{{ pregen.chunksTotal }}</span></span>
            </div>
            <div class="h-2 w-full rounded-full bg-surface-overlay overflow-hidden">
              <div class="h-full bg-hytale-orange transition-all" :style="{ width: pregen.percent + '%' }"></div>
            </div>
            <button @click="cancelWorldPregen" class="text-xs text-red-400 hover:underline">{{ t('common.cancel') }}</button>
          </div>

          <div v-else class="flex flex-wrap items-end gap-2">
            <div>
              <label class="block text-xs text-ink-subtle mb-1">{{ t('worlds.world') || 'World' }}</label>
              <select v-model="pregenWorld" class="bg-surface text-ink px-3 py-2 rounded-lg border border-border focus:border-hytale-orange focus:outline-none text-sm">
                <option value="" disabled>{{ t('worlds.tools.selectWorld') }}</option>
                <option v-for="w in worlds" :key="'pg-' + w.name" :value="w.name">{{ w.name }}</option>
              </select>
            </div>
            <div>
              <label class="block text-xs text-ink-subtle mb-1">{{ t('worlds.tools.radius') }}</label>
              <input v-model.number="pregenRadius" type="number" min="1" max="256" class="w-24 bg-surface text-ink px-3 py-2 rounded-lg border border-border focus:border-hytale-orange focus:outline-none text-sm" />
            </div>
            <button @click="startWorldPregen" :disabled="!pregenWorld || worldToolsBusy" class="px-4 py-2 bg-hytale-orange text-dark rounded-lg text-sm font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50">
              {{ t('worlds.tools.startPregen') }}
            </button>
            <span v-if="pregen.state === 'unsupported'" class="text-xs text-amber-400">{{ pregen.message || t('worlds.tools.pregenUnsupported') }}</span>
            <span v-else-if="pregen.state === 'complete'" class="text-xs text-emerald-400">{{ t('worlds.tools.pregenComplete') }}</span>
            <span v-else-if="pregen.state === 'cancelled'" class="text-xs text-ink-subtle">{{ t('worlds.tools.pregenCancelled') }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-12">
      <svg class="w-6 h-6 animate-spin text-hytale-orange" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    </div>

    <!-- No worlds -->
    <div v-else-if="worlds.length === 0" class="card">
      <div class="card-body text-center py-12">
        <svg class="w-16 h-16 mx-auto text-ink-subtle mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p class="text-ink-muted">{{ t('worlds.noWorlds') }}</p>
      </div>
    </div>

    <!-- World tree and editor -->
    <div v-else class="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <!-- File tree -->
      <div class="card lg:col-span-1">
        <div class="card-header">
          <h3 class="text-lg font-semibold text-ink">{{ t('worlds.files') || 'Files' }}</h3>
        </div>
        <div class="card-body p-0 overflow-y-auto" style="max-height: calc(100vh - 200px);">
          <div v-for="world in worlds" :key="world.name">
            <!-- World folder -->
            <button
              @click="toggleWorld(world.name)"
              class="w-full px-4 py-2 text-left hover:bg-gray-700/50 flex items-center gap-2 border-b border-gray-700"
            >
              <svg
                class="w-4 h-4 text-ink-muted transition-transform"
                :class="{ 'rotate-90': expandedWorlds.has(world.name) }"
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span class="text-ink font-medium">{{ world.name }}</span>
              <span class="text-xs text-ink-subtle ml-auto">{{ world.files?.length || 0 }} {{ t('worlds.fileCount') }}</span>
            </button>

            <!-- Files in world -->
            <div v-if="expandedWorlds.has(world.name) && selectedWorld === world.name" class="bg-gray-800/50">
              <!-- Root files -->
              <button
                v-for="file in selectedWorldFiles.root"
                :key="file.path"
                @click="selectFile(world.name, file.path)"
                class="w-full pl-10 pr-4 py-2 text-left hover:bg-gray-700/50 flex items-center gap-2"
                :class="{ 'bg-hytale-orange/20 border-l-2 border-hytale-orange': selectedFile === file.path }"
              >
                <svg class="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span class="text-ink-muted text-sm">{{ file.name }}</span>
                <span class="text-xs text-ink-subtle ml-auto">{{ formatFileSize(file.size) }}</span>
              </button>

              <!-- Resources folder header -->
              <div v-if="selectedWorldFiles.resources.length > 0" class="pl-10 pr-4 py-2 flex items-center gap-2 text-ink-subtle">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span class="text-xs">resources/</span>
              </div>

              <!-- Resource files -->
              <button
                v-for="file in selectedWorldFiles.resources"
                :key="file.path"
                @click="selectFile(world.name, file.path)"
                class="w-full pl-14 pr-4 py-2 text-left hover:bg-gray-700/50 flex items-center gap-2"
                :class="{ 'bg-hytale-orange/20 border-l-2 border-hytale-orange': selectedFile === file.path }"
              >
                <svg class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span class="text-ink-muted text-sm">{{ file.name }}</span>
                <span class="text-xs text-ink-subtle ml-auto">{{ formatFileSize(file.size) }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- File editor -->
      <div v-if="selectedFile && !loadingFile" class="lg:col-span-3 space-y-6">
        <!-- Header with save button -->
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-xl font-semibold text-ink">{{ selectedFile }}</h2>
            <p class="text-sm text-ink-muted">{{ selectedWorld }}</p>
          </div>
          <div class="flex items-center gap-3">
            <span v-if="saveSuccess" class="text-status-success flex items-center gap-1">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              {{ t('worlds.saved') }}
            </span>
            <button
              v-if="authStore.hasPermission('worlds.manage')"
              @click="saveFile"
              :disabled="saving"
              class="px-4 py-2 bg-hytale-orange hover:bg-hytale-orange/80 disabled:bg-gray-600 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
            >
              <svg v-if="saving" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {{ saving ? t('worlds.saving') : t('worlds.saveChanges') }}
            </button>
          </div>
        </div>

        <!-- Specialized config.json editor -->
        <template v-if="isConfigJson && worldConfig">
          <!-- Edit mode toggle -->
          <div class="flex items-center gap-4 mb-4">
            <span class="text-ink-muted text-sm">{{ t('worlds.editMode') }}:</span>
            <div class="flex bg-surface-raised rounded-lg p-1">
              <button
                @click="configEditMode = 'form'"
                class="px-3 py-1 text-sm rounded-md transition-colors"
                :class="configEditMode === 'form' ? 'bg-hytale-orange text-white' : 'text-ink-muted hover:text-ink'"
              >
                {{ t('worlds.formMode') }}
              </button>
              <button
                @click="configEditMode = 'text'"
                class="px-3 py-1 text-sm rounded-md transition-colors"
                :class="configEditMode === 'text' ? 'bg-hytale-orange text-white' : 'text-ink-muted hover:text-ink'"
              >
                {{ t('worlds.jsonTextMode') }}
              </button>
            </div>
          </div>

          <!-- Text editor mode for config.json -->
          <template v-if="configEditMode === 'text'">
            <div class="card">
              <div class="card-header">
                <h3 class="text-lg font-semibold text-ink">{{ t('worlds.rawEditor') }}</h3>
              </div>
              <div class="card-body">
                <textarea
                  v-model="configRawText"
                  class="w-full h-[500px] px-4 py-3 bg-surface-overlay border border-border rounded-lg text-ink-muted font-mono text-sm focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange resize-none"
                  spellcheck="false"
                ></textarea>
                <p class="text-xs text-ink-subtle mt-2">{{ t('worlds.rawEditorHint') }}</p>
              </div>
            </div>
          </template>

          <!-- Form editor mode for config.json -->
          <template v-else>
          <!-- World Info -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-ink">{{ t('worlds.worldInfo') }}</h3>
            </div>
            <div class="card-body">
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <span class="text-ink-muted text-sm">{{ t('worlds.seed') }}</span>
                  <p class="text-ink font-mono">{{ worldConfig.seed }}</p>
                </div>
                <div>
                  <span class="text-ink-muted text-sm">{{ t('worlds.gameTime') }}</span>
                  <p class="text-ink font-mono text-sm">{{ worldConfig.gameTime || 'N/A' }}</p>
                </div>
              </div>
            </div>
          </div>

          <!-- Gameplay Settings -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-ink">{{ t('worlds.gameplay') }}</h3>
            </div>
            <div class="card-body">
              <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isPvpEnabled" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.pvpEnabled') }}</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isFallDamageEnabled" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.fallDamage') }}</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isSpawningNPC" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.npcSpawning') }}</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isAllNPCFrozen" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.freezeNpcs') }}</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isCompassUpdating" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.compassUpdating') }}</span>
                </label>
              </div>
              <div class="mt-4">
                <label class="block text-sm text-ink-muted mb-2">{{ t('worlds.gameplayConfig') }}</label>
                <input
                  type="text"
                  v-model="form.gameplayConfig"
                  class="w-full px-3 py-2 bg-surface-overlay border border-border rounded-lg text-ink-muted focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                  :placeholder="t('worlds.defaultPlaceholder')"
                />
              </div>
            </div>
          </div>

          <!-- World Ticking -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-ink">{{ t('worlds.worldTicking') }}</h3>
            </div>
            <div class="card-body">
              <div class="grid grid-cols-2 gap-4">
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isTicking" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.worldTicking') }}</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isBlockTicking" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.blockTicking') }}</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Storage Settings -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-ink">{{ t('worlds.storageSaving') }}</h3>
            </div>
            <div class="card-body">
              <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isSavingPlayers" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.savePlayers') }}</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isSavingChunks" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.saveChunks') }}</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.saveNewChunks" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.saveNewChunks') }}</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isUnloadingChunks" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-ink">{{ t('worlds.unloadChunks') }}</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Danger Zone -->
          <div class="card border-status-error/30">
            <div class="card-header bg-status-error/10">
              <h3 class="text-lg font-semibold text-status-error">{{ t('worlds.dangerZone.title') }}</h3>
            </div>
            <div class="card-body">
              <p class="text-ink-muted text-sm mb-4">{{ t('worlds.dangerZone.description') }}</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label class="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    :checked="form.deleteOnUniverseStart"
                    @change="onDangerCheckboxChange('deleteOnUniverseStart', $event)"
                    class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-status-error focus:ring-status-error"
                  >
                  <div>
                    <span class="text-ink">{{ t('worlds.dangerZone.deleteOnUniverseStart') }}</span>
                    <p class="text-xs text-ink-subtle">{{ t('worlds.dangerZone.deleteOnUniverseStartDesc') }}</p>
                  </div>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    :checked="form.deleteOnRemove"
                    @change="onDangerCheckboxChange('deleteOnRemove', $event)"
                    class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-status-error focus:ring-status-error"
                  >
                  <div>
                    <span class="text-ink">{{ t('worlds.dangerZone.deleteOnRemove') }}</span>
                    <p class="text-xs text-ink-subtle">{{ t('worlds.dangerZone.deleteOnRemoveDesc') }}</p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <!-- Raw JSON (collapsible) -->
          <details class="card">
            <summary class="card-header cursor-pointer hover:bg-gray-700/50">
              <h3 class="text-lg font-semibold text-ink">{{ t('worlds.rawConfigJson') }}</h3>
            </summary>
            <div class="card-body">
              <pre class="bg-gray-900 p-4 rounded-lg text-sm text-ink-muted overflow-x-auto max-h-96">{{ JSON.stringify(worldConfig.raw, null, 2) }}</pre>
            </div>
          </details>
          </template>
        </template>

        <!-- Generic JSON editor for other files -->
        <template v-else>
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-ink">{{ t('worlds.jsonEditor') }}</h3>
            </div>
            <div class="card-body">
              <textarea
                v-model="fileContent"
                class="w-full h-[500px] px-4 py-3 bg-surface-overlay border border-border rounded-lg text-ink-muted font-mono text-sm focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange resize-none"
                spellcheck="false"
              ></textarea>
              <p class="text-xs text-ink-subtle mt-2">{{ t('worlds.jsonEditorHint') }}</p>
            </div>
          </div>
        </template>
      </div>

      <!-- Loading file state -->
      <div v-else-if="loadingFile" class="lg:col-span-3 flex items-center justify-center py-12">
        <svg class="w-8 h-8 animate-spin text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </div>

      <!-- Select file prompt -->
      <div v-else class="lg:col-span-3 card">
        <div class="card-body text-center py-12">
          <svg class="w-16 h-16 mx-auto text-ink-subtle mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p class="text-ink-muted">{{ t('worlds.selectFile') }}</p>
        </div>
      </div>
    </div>

    <!-- Danger Zone Confirmation Modal -->
    <ConfirmDialog
      :show="dangerConfirmDialog.show"
      :title="dangerConfirmDialog.title"
      :message="dangerConfirmDialog.message"
      :confirm-text="t('worlds.dangerZone.confirm')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="confirmDangerAction"
      @cancel="cancelDangerAction"
    />
  </div>
</template>
