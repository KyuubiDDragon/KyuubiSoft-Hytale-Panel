<script setup lang="ts">
import { ref, onMounted, computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import ConfigFormEditor from '@/components/config/ConfigFormEditor.vue'
import { serverApi, type ConfigFile, type QuickSettings } from '@/api/server'

const { t } = useI18n()

type EditorMode = 'form' | 'json'

const configFiles = ref<ConfigFile[]>([])
const selectedFile = ref<string | null>(null)
const fileContent = ref('')
const originalContent = ref('')
const editorMode = ref<EditorMode>('form')
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

// Quick Settings
const quickSettings = reactive<QuickSettings>({
  serverName: '',
  motd: '',
  password: '',
  maxPlayers: 100,
  maxViewRadius: 32,
  defaultGameMode: 'Adventure'
})
const originalQuickSettings = ref<QuickSettings | null>(null)
const quickSettingsLoading = ref(false)
const quickSettingsSaving = ref(false)

const gameModes = ['Adventure', 'Survival', 'Creative', 'Spectator']

async function loadQuickSettings() {
  try {
    quickSettingsLoading.value = true
    const settings = await serverApi.getQuickSettings()
    Object.assign(quickSettings, settings)
    originalQuickSettings.value = { ...settings }
  } catch (e) {
    console.error('Failed to load quick settings:', e)
  } finally {
    quickSettingsLoading.value = false
  }
}

async function saveQuickSettings() {
  try {
    quickSettingsSaving.value = true
    error.value = null
    await serverApi.saveQuickSettings(quickSettings)
    originalQuickSettings.value = { ...quickSettings }
    successMessage.value = t('config.saved')
    setTimeout(() => { successMessage.value = null }, 3000)
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    quickSettingsSaving.value = false
  }
}

const quickSettingsChanged = computed(() => {
  if (!originalQuickSettings.value) return false
  return (
    quickSettings.serverName !== originalQuickSettings.value.serverName ||
    quickSettings.motd !== originalQuickSettings.value.motd ||
    quickSettings.password !== originalQuickSettings.value.password ||
    quickSettings.maxPlayers !== originalQuickSettings.value.maxPlayers ||
    quickSettings.maxViewRadius !== originalQuickSettings.value.maxViewRadius ||
    quickSettings.defaultGameMode !== originalQuickSettings.value.defaultGameMode
  )
})

async function loadConfigFiles() {
  try {
    loading.value = true
    error.value = null
    const response = await serverApi.getConfigFiles()
    configFiles.value = response.files
  } catch (e) {
    error.value = t('errors.connectionFailed')
    configFiles.value = []
  } finally {
    loading.value = false
  }
}

async function selectFile(filename: string) {
  try {
    loading.value = true
    error.value = null
    successMessage.value = null
    const response = await serverApi.getConfigContent(filename)
    selectedFile.value = filename
    fileContent.value = response.content
    originalContent.value = response.content
    // Set default mode based on file type
    editorMode.value = filename.endsWith('.json') ? 'form' : 'json'
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    loading.value = false
  }
}

async function saveFile() {
  if (!selectedFile.value) return

  try {
    saving.value = true
    error.value = null
    successMessage.value = null
    await serverApi.saveConfigContent(selectedFile.value, fileContent.value)
    originalContent.value = fileContent.value
    successMessage.value = t('config.saved')
    setTimeout(() => { successMessage.value = null }, 3000)
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    saving.value = false
  }
}

function closeEditor() {
  selectedFile.value = null
  fileContent.value = ''
  originalContent.value = ''
}

function switchMode(mode: EditorMode) {
  editorMode.value = mode
}

const hasChanges = computed(() => fileContent.value !== originalContent.value)
const isJsonFile = computed(() => selectedFile.value?.endsWith('.json'))
const fileExtension = computed(() => {
  if (!selectedFile.value) return ''
  const parts = selectedFile.value.split('.')
  return parts[parts.length - 1].toUpperCase()
})

onMounted(() => {
  loadConfigFiles()
  loadQuickSettings()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('config.title') }}</h1>
        <p class="text-gray-400 mt-1">{{ t('config.subtitle') }}</p>
      </div>
      <button
        v-if="!selectedFile"
        @click="loadConfigFiles"
        class="text-gray-400 hover:text-white transition-colors"
        :class="{ 'animate-spin': loading }"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <!-- Error/Success Messages -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>
    <div v-if="successMessage" class="p-4 bg-status-success/10 border border-status-success/20 rounded-lg">
      <p class="text-status-success">{{ successMessage }}</p>
    </div>

    <!-- Quick Settings -->
    <Card v-if="!selectedFile" :title="t('config.quickSettings')">
      <div v-if="quickSettingsLoading" class="text-center py-8 text-gray-400">
        {{ t('common.loading') }}
      </div>
      <div v-else class="space-y-4">
        <!-- Server Name -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('config.serverName') }}</label>
          <input
            v-model="quickSettings.serverName"
            type="text"
            class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            :placeholder="t('config.serverNamePlaceholder')"
          />
        </div>

        <!-- MOTD -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('config.motd') }}</label>
          <input
            v-model="quickSettings.motd"
            type="text"
            class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            :placeholder="t('config.motdPlaceholder')"
          />
        </div>

        <!-- Password -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('config.password') }}</label>
          <input
            v-model="quickSettings.password"
            type="password"
            class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            :placeholder="t('config.passwordPlaceholder')"
          />
          <p class="text-xs text-gray-500 mt-1">{{ t('config.passwordHint') }}</p>
        </div>

        <!-- Grid for numeric settings -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <!-- Max Players -->
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('config.maxPlayers') }}</label>
            <input
              v-model.number="quickSettings.maxPlayers"
              type="number"
              min="1"
              max="1000"
              class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            />
          </div>

          <!-- Max View Radius -->
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('config.maxViewRadius') }}</label>
            <input
              v-model.number="quickSettings.maxViewRadius"
              type="number"
              min="1"
              max="64"
              class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            />
          </div>

          <!-- Default GameMode -->
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('config.defaultGameMode') }}</label>
            <select
              v-model="quickSettings.defaultGameMode"
              class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            >
              <option v-for="mode in gameModes" :key="mode" :value="mode">
                {{ t(`players.gamemodes.${mode.toLowerCase()}`) }}
              </option>
            </select>
          </div>
        </div>

        <!-- Save Button -->
        <div class="flex items-center justify-between pt-4 border-t border-dark-50">
          <span v-if="quickSettingsChanged" class="text-xs text-status-warning">{{ t('config.unsaved') }}</span>
          <span v-else></span>
          <button
            @click="saveQuickSettings"
            :disabled="quickSettingsSaving || !quickSettingsChanged"
            :class="[
              'flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all',
              quickSettingsChanged
                ? 'bg-hytale-orange text-dark hover:bg-hytale-yellow'
                : 'bg-dark-50 text-gray-500 cursor-not-allowed'
            ]"
          >
            <svg v-if="quickSettingsSaving" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </Card>

    <!-- File List -->
    <Card v-if="!selectedFile" :title="t('config.files')">
      <div v-if="loading" class="text-center py-8 text-gray-400">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="configFiles.length === 0" class="text-center py-8 text-gray-500">
        {{ t('config.noFiles') }}
      </div>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          v-for="file in configFiles"
          :key="file.name"
          @click="selectFile(file.name)"
          class="flex items-center gap-4 p-4 bg-dark-100 hover:bg-dark-50 rounded-lg transition-colors text-left"
        >
          <div class="w-12 h-12 rounded-lg flex items-center justify-center"
            :class="file.name.endsWith('.json') ? 'bg-hytale-orange/20' : 'bg-gray-600/20'"
          >
            <svg class="w-6 h-6" :class="file.name.endsWith('.json') ? 'text-hytale-orange' : 'text-gray-400'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="font-medium text-white truncate">{{ file.name }}</p>
            <p class="text-sm text-gray-500">{{ Math.round(file.size / 1024) }} KB</p>
          </div>
          <svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </Card>

    <!-- File Editor -->
    <template v-else>
      <!-- Editor Header -->
      <Card>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <button
              @click="closeEditor"
              class="p-2 text-gray-400 hover:text-white hover:bg-dark-50 rounded-lg transition-colors"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </button>
            <div>
              <div class="flex items-center gap-2">
                <span class="font-mono text-white">{{ selectedFile }}</span>
                <span class="px-2 py-0.5 bg-dark-50 rounded text-xs text-gray-400">{{ fileExtension }}</span>
              </div>
              <span v-if="hasChanges" class="text-xs text-status-warning">{{ t('config.unsaved') }}</span>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <!-- Mode Toggle (only for JSON files) -->
            <div v-if="isJsonFile" class="flex bg-dark-100 rounded-lg p-1">
              <button
                @click="switchMode('form')"
                :class="[
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  editorMode === 'form'
                    ? 'bg-hytale-orange text-dark'
                    : 'text-gray-400 hover:text-white'
                ]"
              >
                <svg class="w-4 h-4 inline-block mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                {{ t('config.formMode') }}
              </button>
              <button
                @click="switchMode('json')"
                :class="[
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  editorMode === 'json'
                    ? 'bg-hytale-orange text-dark'
                    : 'text-gray-400 hover:text-white'
                ]"
              >
                <svg class="w-4 h-4 inline-block mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
                JSON
              </button>
            </div>

            <!-- Save Button -->
            <button
              @click="saveFile"
              :disabled="saving || !hasChanges"
              :class="[
                'flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all',
                hasChanges
                  ? 'bg-hytale-orange text-dark hover:bg-hytale-yellow'
                  : 'bg-dark-50 text-gray-500 cursor-not-allowed'
              ]"
            >
              <svg v-if="saving" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- Form Editor -->
      <Card v-if="editorMode === 'form' && isJsonFile" :title="t('config.formMode')">
        <ConfigFormEditor v-model="fileContent" :filename="selectedFile || ''" />
      </Card>

      <!-- JSON/Text Editor -->
      <Card v-else :title="editorMode === 'json' ? 'JSON Editor' : t('config.textEditor')">
        <textarea
          v-model="fileContent"
          class="w-full h-[500px] bg-dark-400 text-gray-300 font-mono text-sm p-4 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none resize-y"
          spellcheck="false"
        ></textarea>
      </Card>

      <!-- Warning -->
      <div class="flex items-start gap-3 p-4 bg-status-warning/10 border border-status-warning/20 rounded-lg">
        <svg class="w-5 h-5 text-status-warning flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p class="text-sm text-status-warning">{{ t('config.warning') }}</p>
      </div>
    </template>
  </div>
</template>
