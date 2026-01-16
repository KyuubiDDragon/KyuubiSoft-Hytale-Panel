<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale, getLocale } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import Card from '@/components/ui/Card.vue'
import { serverApi, type ConfigFile } from '@/api/server'

const { t } = useI18n()
const authStore = useAuthStore()

const currentLocale = ref(getLocale())
const configFiles = ref<ConfigFile[]>([])
const selectedFile = ref<string | null>(null)
const fileContent = ref('')
const originalContent = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

function changeLocale(locale: 'de' | 'en' | 'pt_br') {
  setLocale(locale)
  currentLocale.value = locale
}

async function loadConfigFiles() {
  try {
    loading.value = true
    error.value = null
    const response = await serverApi.getConfigFiles()
    configFiles.value = response.files
  } catch (e) {
    error.value = 'Failed to load config files'
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
  } catch (e) {
    error.value = `Failed to load ${filename}`
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
    successMessage.value = t('settings.configSaved')
    setTimeout(() => { successMessage.value = null }, 3000)
  } catch (e) {
    error.value = 'Failed to save config'
  } finally {
    saving.value = false
  }
}

function closeEditor() {
  selectedFile.value = null
  fileContent.value = ''
  originalContent.value = ''
}

const hasChanges = () => fileContent.value !== originalContent.value

onMounted(() => {
  // Only load config files if user has permission
  if (authStore.canManageConfig) {
    loadConfigFiles()
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <h1 class="text-2xl font-bold text-white">{{ t('settings.title') }}</h1>

    <!-- Language Settings -->
    <Card :title="t('settings.language')">
      <div class="flex gap-4">
        <button
          @click="changeLocale('de')"
          :class="[
            'flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
            currentLocale === 'de'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 hover:border-gray-600'
          ]"
        >
          <span class="text-2xl">🇩🇪</span>
          <div class="text-left">
            <p class="font-medium text-white">{{ t('settings.german') }}</p>
            <p class="text-sm text-gray-400">Deutsch</p>
          </div>
          <svg
            v-if="currentLocale === 'de'"
            class="w-5 h-5 text-hytale-orange ml-auto"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
        </button>

        <button
          @click="changeLocale('en')"
          :class="[
            'flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
            currentLocale === 'en'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 hover:border-gray-600'
          ]"
        >
          <span class="text-2xl">🇬🇧</span>
          <div class="text-left">
            <p class="font-medium text-white">{{ t('settings.english') }}</p>
            <p class="text-sm text-gray-400">English</p>
          </div>
          <svg
            v-if="currentLocale === 'en'"
            class="w-5 h-5 text-hytale-orange ml-auto"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
        </button>

        <button
          @click="changeLocale('pt_br')"
          :class="[
            'flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
            currentLocale === 'pt_br'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 hover:border-gray-600'
          ]"
        >
          <span class="text-2xl">🇧🇷</span>
          <div class="text-left">
            <p class="font-medium text-white">Português (Brasil)</p>
            <p class="text-sm text-gray-400">Portuguese (Brazil)</p>
          </div>
          <svg
            v-if="currentLocale === 'pt_br'"
            class="w-5 h-5 text-hytale-orange ml-auto"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
        </button>
      </div>
    </Card>

    <!-- Server Configuration (only for users with permission) -->
    <Card v-if="authStore.canManageConfig" :title="t('settings.serverConfig')">
      <div class="space-y-4">
        <!-- Error/Success Messages -->
        <div v-if="error" class="p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
          {{ error }}
        </div>
        <div v-if="successMessage" class="p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
          {{ successMessage }}
        </div>

        <!-- File List -->
        <div v-if="!selectedFile">
          <p class="text-gray-400 text-sm mb-3">{{ t('settings.selectConfigFile') }}</p>

          <div v-if="loading" class="text-center py-4 text-gray-400">
            {{ t('common.loading') }}...
          </div>

          <div v-else-if="configFiles.length === 0" class="text-center py-4 text-gray-500">
            {{ t('settings.noConfigFiles') }}
          </div>

          <div v-else class="space-y-2">
            <button
              v-for="file in configFiles"
              :key="file.name"
              @click="selectFile(file.name)"
              class="w-full flex items-center justify-between p-3 bg-dark-300 hover:bg-dark-50 rounded-lg transition-colors"
            >
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span class="text-white font-mono text-sm">{{ file.name }}</span>
              </div>
              <span class="text-gray-500 text-xs">{{ Math.round(file.size / 1024) }} KB</span>
            </button>
          </div>

          <button
            @click="loadConfigFiles"
            class="mt-4 text-sm text-gray-400 hover:text-white flex items-center gap-1"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {{ t('common.refresh') }}
          </button>
        </div>

        <!-- File Editor -->
        <div v-else>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <button
                @click="closeEditor"
                class="text-gray-400 hover:text-white"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </button>
              <span class="text-white font-mono">{{ selectedFile }}</span>
              <span v-if="hasChanges()" class="text-status-warning text-xs">({{ t('settings.unsavedChanges') }})</span>
            </div>
            <button
              @click="saveFile"
              :disabled="saving || !hasChanges()"
              :class="[
                'btn btn-sm',
                hasChanges() ? 'btn-primary' : 'btn-secondary opacity-50 cursor-not-allowed'
              ]"
            >
              <svg v-if="saving" class="w-4 h-4 mr-1 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ t('common.save') }}
            </button>
          </div>

          <textarea
            v-model="fileContent"
            class="w-full h-96 bg-dark-400 text-gray-300 font-mono text-sm p-4 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none resize-y"
            spellcheck="false"
          ></textarea>

          <p class="text-gray-500 text-xs mt-2">
            {{ t('settings.configWarning') }}
          </p>
        </div>
      </div>
    </Card>

    <!-- About -->
    <Card :title="t('settings.about')">
      <div class="space-y-4">
        <div class="flex items-center gap-4">
          <div class="w-16 h-16 bg-gradient-to-br from-hytale-orange to-hytale-yellow rounded-2xl flex items-center justify-center">
            <span class="text-dark font-bold text-3xl">H</span>
          </div>
          <div>
            <h3 class="text-xl font-bold text-white">Hytale Server Manager</h3>
            <p class="text-gray-400">{{ t('settings.version') }}: 1.0.0</p>
          </div>
        </div>

        <div class="pt-4 border-t border-dark-50">
          <p class="text-gray-400 text-sm">
            Web-based management tool for Hytale dedicated servers.
            Provides server control, live console, backup management, and player administration.
          </p>
        </div>

        <div class="pt-4 border-t border-dark-50">
          <div class="flex gap-4">
            <div class="flex-1">
              <p class="text-sm text-gray-500 mb-1">Backend</p>
              <p class="text-white">Node.js + Express</p>
            </div>
            <div class="flex-1">
              <p class="text-sm text-gray-500 mb-1">Frontend</p>
              <p class="text-white">Vue.js 3 + Tailwind CSS</p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  </div>
</template>
