<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { worldsApi, type WorldInfo, type WorldConfig } from '@/api/management'

const { t } = useI18n()

// State
const worlds = ref<WorldInfo[]>([])
const selectedWorld = ref<string | null>(null)
const worldConfig = ref<WorldConfig | null>(null)
const loading = ref(true)
const loadingConfig = ref(false)
const saving = ref(false)
const error = ref('')
const saveSuccess = ref(false)

// Editable form state
const form = ref<Partial<WorldConfig>>({})

async function loadWorlds() {
  loading.value = true
  error.value = ''
  try {
    const data = await worldsApi.get()
    worlds.value = data.worlds
    // Auto-select first world with config
    if (data.worlds.length > 0 && !selectedWorld.value) {
      const worldWithConfig = data.worlds.find(w => w.hasConfig)
      if (worldWithConfig) {
        selectWorld(worldWithConfig.name)
      }
    }
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function selectWorld(worldName: string) {
  selectedWorld.value = worldName
  loadingConfig.value = true
  error.value = ''
  saveSuccess.value = false
  try {
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
      daytimeDurationSecondsOverride: worldConfig.value.daytimeDurationSecondsOverride,
      nighttimeDurationSecondsOverride: worldConfig.value.nighttimeDurationSecondsOverride,
      clientEffects: worldConfig.value.clientEffects ? { ...worldConfig.value.clientEffects } : {},
    }
  } catch (e) {
    error.value = 'Failed to load world config'
    worldConfig.value = null
  } finally {
    loadingConfig.value = false
  }
}

async function saveConfig() {
  if (!selectedWorld.value) return
  saving.value = true
  error.value = ''
  saveSuccess.value = false
  try {
    await worldsApi.updateConfig(selectedWorld.value, form.value)
    saveSuccess.value = true
    setTimeout(() => saveSuccess.value = false, 3000)
  } catch (e) {
    error.value = 'Failed to save config'
  } finally {
    saving.value = false
  }
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

    <!-- World selector and config -->
    <div v-else class="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <!-- World list -->
      <div class="card lg:col-span-1">
        <div class="card-header">
          <h3 class="text-lg font-semibold text-white">Worlds</h3>
        </div>
        <div class="card-body p-0">
          <div class="divide-y divide-gray-700">
            <button
              v-for="world in worlds"
              :key="world.name"
              @click="world.hasConfig && selectWorld(world.name)"
              class="w-full px-4 py-3 text-left transition-colors flex items-center gap-3"
              :class="[
                selectedWorld === world.name ? 'bg-hytale-orange/20 border-l-2 border-hytale-orange' : '',
                world.hasConfig ? 'hover:bg-gray-700/50 cursor-pointer' : 'opacity-50 cursor-not-allowed'
              ]"
            >
              <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div class="flex-1">
                <span class="text-white">{{ world.name }}</span>
                <span v-if="!world.hasConfig" class="text-xs text-gray-500 block">No config</span>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- Config editor -->
      <div v-if="worldConfig && !loadingConfig" class="lg:col-span-3 space-y-6">
        <!-- Save button -->
        <div class="flex items-center justify-between">
          <h2 class="text-xl font-semibold text-white">{{ worldConfig.displayName || worldConfig.name }}</h2>
          <div class="flex items-center gap-3">
            <span v-if="saveSuccess" class="text-status-success flex items-center gap-1">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              Saved
            </span>
            <button
              @click="saveConfig"
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
                <input type="checkbox" v-model="form.isSpawnMarkersEnabled" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                <span class="text-white">Spawn Markers</span>
              </label>
              <label class="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" v-model="form.isObjectiveMarkersEnabled" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
                <span class="text-white">Objective Markers</span>
              </label>
            </div>
          </div>
        </div>

        <!-- Time Settings -->
        <div class="card">
          <div class="card-header">
            <h3 class="text-lg font-semibold text-white">Time & Day/Night Cycle</h3>
          </div>
          <div class="card-body space-y-4">
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" v-model="form.isGameTimePaused" class="w-5 h-5 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange">
              <span class="text-white">Pause Game Time</span>
            </label>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div>
                <label class="block text-gray-400 text-sm mb-1">Daytime Duration (seconds)</label>
                <input
                  type="number"
                  v-model.number="form.daytimeDurationSecondsOverride"
                  placeholder="Default"
                  class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                >
                <p class="text-xs text-gray-500 mt-1">Leave empty for default. e.g. 600 = 10 minutes</p>
              </div>
              <div>
                <label class="block text-gray-400 text-sm mb-1">Nighttime Duration (seconds)</label>
                <input
                  type="number"
                  v-model.number="form.nighttimeDurationSecondsOverride"
                  placeholder="Default"
                  class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                >
                <p class="text-xs text-gray-500 mt-1">Leave empty for default. e.g. 300 = 5 minutes</p>
              </div>
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

        <!-- Visual Effects -->
        <div class="card" v-if="form.clientEffects">
          <div class="card-header">
            <h3 class="text-lg font-semibold text-white">Visual Effects</h3>
          </div>
          <div class="card-body space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label class="block text-gray-400 text-sm mb-1">Sun Height %</label>
                <input
                  type="number"
                  step="0.1"
                  v-model.number="form.clientEffects.sunHeightPercent"
                  class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                >
              </div>
              <div>
                <label class="block text-gray-400 text-sm mb-1">Sun Angle (degrees)</label>
                <input
                  type="number"
                  step="0.1"
                  v-model.number="form.clientEffects.sunAngleDegrees"
                  class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                >
              </div>
              <div>
                <label class="block text-gray-400 text-sm mb-1">Sun Intensity</label>
                <input
                  type="number"
                  step="0.01"
                  v-model.number="form.clientEffects.sunIntensity"
                  class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                >
              </div>
              <div>
                <label class="block text-gray-400 text-sm mb-1">Bloom Intensity</label>
                <input
                  type="number"
                  step="0.01"
                  v-model.number="form.clientEffects.bloomIntensity"
                  class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                >
              </div>
              <div>
                <label class="block text-gray-400 text-sm mb-1">Bloom Power</label>
                <input
                  type="number"
                  step="0.1"
                  v-model.number="form.clientEffects.bloomPower"
                  class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                >
              </div>
              <div>
                <label class="block text-gray-400 text-sm mb-1">Sunshaft Intensity</label>
                <input
                  type="number"
                  step="0.01"
                  v-model.number="form.clientEffects.sunshaftIntensity"
                  class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
                >
              </div>
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
      </div>

      <!-- Loading config state -->
      <div v-else-if="loadingConfig" class="lg:col-span-3 flex items-center justify-center py-12">
        <svg class="w-8 h-8 animate-spin text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </div>

      <!-- Select world prompt -->
      <div v-else class="lg:col-span-3 card">
        <div class="card-body text-center py-12">
          <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-gray-400">Select a world from the list to edit its configuration.</p>
        </div>
      </div>
    </div>
  </div>
</template>
