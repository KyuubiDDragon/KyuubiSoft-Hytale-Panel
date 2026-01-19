<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { worldsApi, type WorldInfo, type WorldConfig, type WorldFileInfo } from '@/api/management'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const authStore = useAuthStore()

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
    error.value = `Failed to load ${filePath}`
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
      error.value = 'Invalid JSON syntax'
    } else {
      error.value = 'Failed to save file'
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

onMounted(loadWorlds)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">{{ t('worlds.title') }}</h1>
      <button
        @click="loadWorlds"
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

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12 text-gray-400">
      {{ t('common.loading') }}
    </div>

    <!-- No worlds -->
    <div v-else-if="worlds.length === 0" class="card">
      <div class="card-body text-center py-12">
        <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p class="text-gray-400">{{ t('worlds.noWorlds') }}</p>
      </div>
    </div>

    <!-- World tree and editor -->
    <div v-else class="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <!-- File tree -->
      <div class="card lg:col-span-1">
        <div class="card-header">
          <h3 class="text-lg font-semibold text-white">{{ t('worlds.files') || 'Files' }}</h3>
        </div>
        <div class="card-body p-0 overflow-y-auto" style="max-height: calc(100vh - 200px);">
          <div v-for="world in worlds" :key="world.name">
            <!-- World folder -->
            <button
              @click="toggleWorld(world.name)"
              class="w-full px-4 py-2 text-left hover:bg-gray-700/50 flex items-center gap-2 border-b border-gray-700"
            >
              <svg
                class="w-4 h-4 text-gray-400 transition-transform"
                :class="{ 'rotate-90': expandedWorlds.has(world.name) }"
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span class="text-white font-medium">{{ world.name }}</span>
              <span class="text-xs text-gray-500 ml-auto">{{ world.files?.length || 0 }} files</span>
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
                <span class="text-gray-300 text-sm">{{ file.name }}</span>
                <span class="text-xs text-gray-500 ml-auto">{{ formatFileSize(file.size) }}</span>
              </button>

              <!-- Resources folder header -->
              <div v-if="selectedWorldFiles.resources.length > 0" class="pl-10 pr-4 py-2 flex items-center gap-2 text-gray-500">
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
                <span class="text-gray-300 text-sm">{{ file.name }}</span>
                <span class="text-xs text-gray-500 ml-auto">{{ formatFileSize(file.size) }}</span>
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
            <h2 class="text-xl font-semibold text-white">{{ selectedFile }}</h2>
            <p class="text-sm text-gray-400">{{ selectedWorld }}</p>
          </div>
          <div class="flex items-center gap-3">
            <span v-if="saveSuccess" class="text-status-success flex items-center gap-1">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              Saved
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
              {{ saving ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </div>

        <!-- Specialized config.json editor -->
        <template v-if="isConfigJson && worldConfig">
          <!-- Edit mode toggle -->
          <div class="flex items-center gap-4 mb-4">
            <span class="text-gray-400 text-sm">Edit mode:</span>
            <div class="flex bg-gray-800 rounded-lg p-1">
              <button
                @click="configEditMode = 'form'"
                class="px-3 py-1 text-sm rounded-md transition-colors"
                :class="configEditMode === 'form' ? 'bg-hytale-orange text-white' : 'text-gray-400 hover:text-white'"
              >
                Form
              </button>
              <button
                @click="configEditMode = 'text'"
                class="px-3 py-1 text-sm rounded-md transition-colors"
                :class="configEditMode === 'text' ? 'bg-hytale-orange text-white' : 'text-gray-400 hover:text-white'"
              >
                JSON Text
              </button>
            </div>
          </div>

          <!-- Text editor mode for config.json -->
          <template v-if="configEditMode === 'text'">
            <div class="card">
              <div class="card-header">
                <h3 class="text-lg font-semibold text-white">config.json (Raw Editor)</h3>
              </div>
              <div class="card-body">
                <textarea
                  v-model="configRawText"
                  class="w-full h-[500px] px-4 py-3 bg-gray-900 border border-gray-600 rounded-lg text-gray-300 font-mono text-sm focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange resize-none"
                  spellcheck="false"
                ></textarea>
                <p class="text-xs text-gray-500 mt-2">Edit the raw JSON and click Save Changes to apply.</p>
              </div>
            </div>
          </template>

          <!-- Form editor mode for config.json -->
          <template v-else>
          <!-- World Info -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-white">World Info</h3>
            </div>
            <div class="card-body">
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <span class="text-gray-400 text-sm">Seed</span>
                  <p class="text-white font-mono">{{ worldConfig.seed }}</p>
                </div>
                <div>
                  <span class="text-gray-400 text-sm">Game Time</span>
                  <p class="text-white font-mono text-sm">{{ worldConfig.gameTime || 'N/A' }}</p>
                </div>
              </div>
            </div>
          </div>

          <!-- Gameplay Settings -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-white">Gameplay</h3>
            </div>
            <div class="card-body">
              <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isPvpEnabled" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">PvP Enabled</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isFallDamageEnabled" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">Fall Damage</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isSpawningNPC" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">NPC Spawning</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isAllNPCFrozen" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">Freeze All NPCs</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isCompassUpdating" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">Compass Updating</span>
                </label>
              </div>
              <div class="mt-4">
                <label class="block text-sm text-gray-400 mb-2">Gameplay Config</label>
                <input
                  type="text"
                  v-model="form.gameplayConfig"
                  class="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-gray-300 focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                  placeholder="Default"
                />
              </div>
            </div>
          </div>

          <!-- World Ticking -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-white">World Ticking</h3>
            </div>
            <div class="card-body">
              <div class="grid grid-cols-2 gap-4">
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isTicking" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">World Ticking</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isBlockTicking" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">Block Ticking</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Storage Settings -->
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-white">Storage & Saving</h3>
            </div>
            <div class="card-body">
              <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isSavingPlayers" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">Save Players</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isSavingChunks" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">Save Chunks</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.saveNewChunks" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">Save New Chunks</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.isUnloadingChunks" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                  <span class="text-white">Unload Chunks</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Danger Zone -->
          <div class="card border-status-error/30">
            <div class="card-header bg-status-error/10">
              <h3 class="text-lg font-semibold text-status-error">Danger Zone</h3>
            </div>
            <div class="card-body">
              <p class="text-gray-400 text-sm mb-4">These settings can cause data loss. Use with caution.</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.deleteOnUniverseStart" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-status-error focus:ring-status-error">
                  <div>
                    <span class="text-white">Delete on Universe Start</span>
                    <p class="text-xs text-gray-500">World will be deleted when the universe starts</p>
                  </div>
                </label>
                <label class="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" v-model="form.deleteOnRemove" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-status-error focus:ring-status-error">
                  <div>
                    <span class="text-white">Delete on Remove</span>
                    <p class="text-xs text-gray-500">World will be permanently deleted when removed</p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <!-- Raw JSON (collapsible) -->
          <details class="card">
            <summary class="card-header cursor-pointer hover:bg-gray-700/50">
              <h3 class="text-lg font-semibold text-white">Raw Config JSON</h3>
            </summary>
            <div class="card-body">
              <pre class="bg-gray-900 p-4 rounded-lg text-sm text-gray-300 overflow-x-auto max-h-96">{{ JSON.stringify(worldConfig.raw, null, 2) }}</pre>
            </div>
          </details>
          </template>
        </template>

        <!-- Generic JSON editor for other files -->
        <template v-else>
          <div class="card">
            <div class="card-header">
              <h3 class="text-lg font-semibold text-white">JSON Editor</h3>
            </div>
            <div class="card-body">
              <textarea
                v-model="fileContent"
                class="w-full h-[500px] px-4 py-3 bg-gray-900 border border-gray-600 rounded-lg text-gray-300 font-mono text-sm focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange resize-none"
                spellcheck="false"
              ></textarea>
              <p class="text-xs text-gray-500 mt-2">Edit the JSON content above and click Save Changes to apply.</p>
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
          <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p class="text-gray-400">Select a file from the tree to view and edit its contents.</p>
        </div>
      </div>
    </div>
  </div>
</template>
