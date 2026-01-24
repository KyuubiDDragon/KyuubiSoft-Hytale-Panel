<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale, getLocale } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import Card from '@/components/ui/Card.vue'
import { serverApi, type ConfigFile, type PatchlineResponse, type AcceptEarlyPluginsResponse, type DisableSentryResponse, type AllowOpResponse } from '@/api/server'
import { authApi, type HytaleAuthStatus, type HytaleDeviceCodeResponse } from '@/api/auth'

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

// Hytale Auth
const hytaleAuthStatus = ref<HytaleAuthStatus>({ authenticated: false })
const hytaleAuthLoading = ref(false)
const hytaleAuthError = ref<string | null>(null)
const hytaleAuthSuccess = ref<string | null>(null)
const deviceCodeData = ref<HytaleDeviceCodeResponse | null>(null)
const checkingInterval = ref<number | null>(null)

// Patchline Settings
const patchlineData = ref<PatchlineResponse | null>(null)
const patchlineLoading = ref(false)
const patchlineError = ref<string | null>(null)
const patchlineSuccess = ref<string | null>(null)
const patchlineNeedsRestart = ref(false)

// Accept Early Plugins Settings
const acceptEarlyPluginsData = ref<AcceptEarlyPluginsResponse | null>(null)
const acceptEarlyPluginsLoading = ref(false)
const acceptEarlyPluginsError = ref<string | null>(null)
const acceptEarlyPluginsSuccess = ref<string | null>(null)
const acceptEarlyPluginsNeedsRestart = ref(false)

// Disable Sentry Settings
const disableSentryData = ref<DisableSentryResponse | null>(null)
const disableSentryLoading = ref(false)
const disableSentryError = ref<string | null>(null)
const disableSentrySuccess = ref<string | null>(null)
const disableSentryNeedsRestart = ref(false)

// Allow OP Settings
const allowOpData = ref<AllowOpResponse | null>(null)
const allowOpLoading = ref(false)
const allowOpError = ref<string | null>(null)
const allowOpSuccess = ref<string | null>(null)
const allowOpNeedsRestart = ref(false)

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

// Patchline Functions
async function loadPatchline() {
  try {
    patchlineLoading.value = true
    patchlineError.value = null
    const response = await serverApi.getPatchline()
    patchlineData.value = response
  } catch (e) {
    patchlineError.value = 'Failed to load patchline setting'
  } finally {
    patchlineLoading.value = false
  }
}

async function setPatchline(patchline: string) {
  try {
    patchlineLoading.value = true
    patchlineError.value = null
    patchlineSuccess.value = null

    const response = await serverApi.setPatchline(patchline)

    if (response.success) {
      patchlineData.value = { ...patchlineData.value!, patchline: response.patchline }
      patchlineSuccess.value = response.message

      // If patchline was changed, show restart button
      if (response.changed) {
        patchlineNeedsRestart.value = true
      }
    }
  } catch (e) {
    patchlineError.value = 'Failed to update patchline setting'
  } finally {
    patchlineLoading.value = false
  }
}

async function restartForPatchline() {
  try {
    patchlineLoading.value = true
    await serverApi.restart()
    patchlineNeedsRestart.value = false
    patchlineSuccess.value = t('settings.patchlineRestarting')
  } catch (e) {
    patchlineError.value = 'Failed to restart server'
  } finally {
    patchlineLoading.value = false
  }
}

// Accept Early Plugins Functions
async function loadAcceptEarlyPlugins() {
  try {
    acceptEarlyPluginsLoading.value = true
    acceptEarlyPluginsError.value = null
    const response = await serverApi.getAcceptEarlyPlugins()
    acceptEarlyPluginsData.value = response
  } catch (e) {
    acceptEarlyPluginsError.value = 'Failed to load accept early plugins setting'
  } finally {
    acceptEarlyPluginsLoading.value = false
  }
}

async function setAcceptEarlyPlugins(enabled: boolean) {
  try {
    acceptEarlyPluginsLoading.value = true
    acceptEarlyPluginsError.value = null
    acceptEarlyPluginsSuccess.value = null

    const response = await serverApi.setAcceptEarlyPlugins(enabled)

    if (response.success) {
      acceptEarlyPluginsData.value = { acceptEarlyPlugins: response.acceptEarlyPlugins }
      acceptEarlyPluginsSuccess.value = response.message

      // If setting was changed, show restart button
      if (response.changed) {
        acceptEarlyPluginsNeedsRestart.value = true
      }
    }
  } catch (e) {
    acceptEarlyPluginsError.value = 'Failed to update accept early plugins setting'
  } finally {
    acceptEarlyPluginsLoading.value = false
  }
}

async function restartForAcceptEarlyPlugins() {
  try {
    acceptEarlyPluginsLoading.value = true
    await serverApi.restart()
    acceptEarlyPluginsNeedsRestart.value = false
    acceptEarlyPluginsSuccess.value = t('settings.acceptEarlyPluginsRestarting')
  } catch (e) {
    acceptEarlyPluginsError.value = 'Failed to restart server'
  } finally {
    acceptEarlyPluginsLoading.value = false
  }
}

// Disable Sentry Functions
async function loadDisableSentry() {
  try {
    disableSentryLoading.value = true
    disableSentryError.value = null
    const response = await serverApi.getDisableSentry()
    disableSentryData.value = response
  } catch (e) {
    disableSentryError.value = 'Failed to load disable sentry setting'
  } finally {
    disableSentryLoading.value = false
  }
}

async function setDisableSentry(enabled: boolean) {
  try {
    disableSentryLoading.value = true
    disableSentryError.value = null
    disableSentrySuccess.value = null

    const response = await serverApi.setDisableSentry(enabled)

    if (response.success) {
      disableSentryData.value = { disableSentry: response.disableSentry }
      disableSentrySuccess.value = response.message

      if (response.changed) {
        disableSentryNeedsRestart.value = true
      }
    }
  } catch (e) {
    disableSentryError.value = 'Failed to update disable sentry setting'
  } finally {
    disableSentryLoading.value = false
  }
}

async function restartForDisableSentry() {
  try {
    disableSentryLoading.value = true
    await serverApi.restart()
    disableSentryNeedsRestart.value = false
    disableSentrySuccess.value = t('settings.disableSentryRestarting')
  } catch (e) {
    disableSentryError.value = 'Failed to restart server'
  } finally {
    disableSentryLoading.value = false
  }
}

// Allow OP Functions
async function loadAllowOp() {
  try {
    allowOpLoading.value = true
    allowOpError.value = null
    const response = await serverApi.getAllowOp()
    allowOpData.value = response
  } catch (e) {
    allowOpError.value = 'Failed to load allow op setting'
  } finally {
    allowOpLoading.value = false
  }
}

async function setAllowOp(enabled: boolean) {
  try {
    allowOpLoading.value = true
    allowOpError.value = null
    allowOpSuccess.value = null

    const response = await serverApi.setAllowOp(enabled)

    if (response.success) {
      allowOpData.value = { allowOp: response.allowOp }
      allowOpSuccess.value = response.message

      if (response.changed) {
        allowOpNeedsRestart.value = true
      }
    }
  } catch (e) {
    allowOpError.value = 'Failed to update allow op setting'
  } finally {
    allowOpLoading.value = false
  }
}

async function restartForAllowOp() {
  try {
    allowOpLoading.value = true
    await serverApi.restart()
    allowOpNeedsRestart.value = false
    allowOpSuccess.value = t('settings.allowOpRestarting')
  } catch (e) {
    allowOpError.value = 'Failed to restart server'
  } finally {
    allowOpLoading.value = false
  }
}

// Hytale Auth Functions
async function loadHytaleAuthStatus() {
  try {
    // First verify auth status with the backend (this updates the stored status)
    await authApi.checkHytaleAuthCompletion()

    // Then get the updated status
    const status = await authApi.getHytaleAuthStatus()
    hytaleAuthStatus.value = status
  } catch (e) {
    console.error('Failed to load Hytale auth status:', e)
  }
}

async function initiateHytaleAuth() {
  try {
    hytaleAuthLoading.value = true
    hytaleAuthError.value = null
    hytaleAuthSuccess.value = null

    const result = await authApi.initiateHytaleLogin()

    if (!result.success) {
      hytaleAuthError.value = result.error || 'Failed to initiate authentication'
      return
    }

    deviceCodeData.value = result

    // Start polling for completion
    startAuthPolling()
  } catch (e) {
    hytaleAuthError.value = 'An error occurred while initiating authentication'
  } finally {
    hytaleAuthLoading.value = false
  }
}

function startAuthPolling() {
  // Poll every 5 seconds
  checkingInterval.value = window.setInterval(async () => {
    try {
      const result = await authApi.checkHytaleAuthCompletion()

      if (result.success) {
        // Authentication completed!
        stopAuthPolling()
        hytaleAuthSuccess.value = result.message || t('settings.authSuccess')
        deviceCodeData.value = null
        await loadHytaleAuthStatus()

        // Clear success message after 5 seconds
        setTimeout(() => {
          hytaleAuthSuccess.value = null
        }, 5000)
      }
    } catch (e) {
      console.error('Error checking auth completion:', e)
    }
  }, 5000)
}

function stopAuthPolling() {
  if (checkingInterval.value) {
    window.clearInterval(checkingInterval.value)
    checkingInterval.value = null
  }
}

async function verifyAuth() {
  try {
    hytaleAuthLoading.value = true
    hytaleAuthError.value = null

    const result = await authApi.checkHytaleAuthCompletion()

    if (result.success) {
      hytaleAuthSuccess.value = result.message || t('settings.authSuccess')
      deviceCodeData.value = null
      stopAuthPolling()
      await loadHytaleAuthStatus()
    } else {
      hytaleAuthError.value = result.error || t('settings.authPending')
    }
  } catch (e) {
    hytaleAuthError.value = 'Failed to verify authentication'
  } finally {
    hytaleAuthLoading.value = false
  }
}

async function resetHytaleAuth() {
  try {
    hytaleAuthLoading.value = true
    hytaleAuthError.value = null
    hytaleAuthSuccess.value = null

    await authApi.resetHytaleAuth()
    deviceCodeData.value = null
    stopAuthPolling()
    await loadHytaleAuthStatus()
  } catch (e) {
    hytaleAuthError.value = 'Failed to reset authentication'
  } finally {
    hytaleAuthLoading.value = false
  }
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
}

function openAuthUrl() {
  if (deviceCodeData.value?.verificationUrl) {
    window.open(deviceCodeData.value.verificationUrl, '_blank')
  }
}

onMounted(() => {
  // Only load config files if user has permission
  if (authStore.canManageConfig) {
    loadConfigFiles()
  }

  // Load Hytale auth status if user can manage server
  if (authStore.canManageServer) {
    loadHytaleAuthStatus()
    loadPatchline()
    loadAcceptEarlyPlugins()
    loadDisableSentry()
    loadAllowOp()
  }
})

onUnmounted(() => {
  stopAuthPolling()
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

    <!-- Hytale Server Authentication (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.hytaleAuth')">
      <p class="text-gray-400 text-sm mb-4">{{ t('settings.hytaleAuthDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="hytaleAuthError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ hytaleAuthError }}
      </div>
      <div v-if="hytaleAuthSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ hytaleAuthSuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Status -->
        <div class="flex items-center justify-between p-4 bg-dark-300 rounded-lg">
          <div>
            <p class="text-sm text-gray-400">{{ t('settings.authStatus') }}</p>
            <p class="text-white font-medium mt-1">
              <span v-if="hytaleAuthStatus.authenticated" class="flex items-center gap-2">
                <svg class="w-5 h-5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ t('settings.authenticated') }}
              </span>
              <span v-else class="flex items-center gap-2">
                <svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ t('settings.notAuthenticated') }}
              </span>
            </p>
            <!-- Persistence Type Warning -->
            <p v-if="hytaleAuthStatus.authenticated && hytaleAuthStatus.persistenceType === 'memory'" class="text-xs text-status-warning mt-1 flex items-center gap-1">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              {{ t('dashboard.authMemoryOnlyShort') }}
            </p>
          </div>

          <div class="flex gap-2">
            <button
              v-if="!hytaleAuthStatus.authenticated && !deviceCodeData && authStore.hasPermission('hytale_auth.manage')"
              @click="initiateHytaleAuth"
              :disabled="hytaleAuthLoading"
              class="btn btn-primary"
            >
              <svg v-if="hytaleAuthLoading" class="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ t('settings.initiateAuth') }}
            </button>

            <button
              v-if="hytaleAuthStatus.authenticated && authStore.hasPermission('hytale_auth.manage')"
              @click="resetHytaleAuth"
              :disabled="hytaleAuthLoading"
              class="btn btn-secondary"
            >
              {{ t('settings.resetAuth') }}
            </button>
          </div>
        </div>

        <!-- Authentication in Progress -->
        <div v-if="deviceCodeData" class="p-4 bg-dark-300 rounded-lg border-2 border-hytale-orange">
          <div class="flex items-start gap-3">
            <svg class="w-6 h-6 text-hytale-orange mt-1 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div class="flex-1">
              <h3 class="text-white font-medium mb-2">{{ t('settings.authInProgress') }}</h3>
              <p class="text-gray-400 text-sm mb-4">{{ t('settings.completeAuth') }}</p>

              <!-- Auth Code Display -->
              <div class="bg-dark-400 p-4 rounded-lg mb-4">
                <p class="text-xs text-gray-500 uppercase mb-2">{{ t('settings.authCode') }}</p>
                <div class="flex items-center justify-between">
                  <p class="text-2xl font-mono text-hytale-orange font-bold">{{ deviceCodeData.userCode }}</p>
                  <button
                    @click="copyToClipboard(deviceCodeData.userCode || '')"
                    class="btn btn-sm btn-secondary"
                  >
                    <svg class="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    {{ t('settings.copyCode') }}
                  </button>
                </div>
              </div>

              <!-- Actions -->
              <div class="flex gap-2">
                <button
                  @click="openAuthUrl"
                  class="btn btn-primary flex-1"
                >
                  <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  {{ t('settings.openAuthUrl') }}
                </button>

                <button
                  @click="verifyAuth"
                  :disabled="hytaleAuthLoading"
                  class="btn btn-secondary"
                >
                  <svg v-if="hytaleAuthLoading" class="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {{ t('settings.verifyAuth') }}
                </button>

                <button
                  v-if="authStore.hasPermission('hytale_auth.manage')"
                  @click="resetHytaleAuth"
                  class="btn btn-secondary"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>

    <!-- Patchline Settings (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.patchlineTitle')">
      <p class="text-gray-400 text-sm mb-4">{{ t('settings.patchlineDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="patchlineError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ patchlineError }}
      </div>
      <div v-if="patchlineSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ patchlineSuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Setting -->
        <div class="flex items-center justify-between p-4 bg-dark-300 rounded-lg">
          <div>
            <p class="text-sm text-gray-400">{{ t('settings.currentPatchline') }}</p>
            <p class="text-white font-medium mt-1 font-mono">
              {{ patchlineData?.patchline || '-' }}
            </p>
          </div>
        </div>

        <!-- Patchline Selection -->
        <div v-if="!patchlineLoading && authStore.hasPermission('settings.edit')" class="flex gap-4">
          <button
            @click="setPatchline('release')"
            :disabled="patchlineLoading"
            :class="[
              'flex-1 flex items-center justify-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
              patchlineData?.patchline === 'release'
                ? 'border-status-success bg-status-success/10'
                : 'border-dark-50 hover:border-gray-600'
            ]"
          >
            <div class="text-center">
              <p class="font-medium text-white">Release</p>
              <p class="text-xs text-gray-400">{{ t('settings.patchlineReleaseDesc') }}</p>
            </div>
            <svg
              v-if="patchlineData?.patchline === 'release'"
              class="w-5 h-5 text-status-success"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
          </button>

          <button
            @click="setPatchline('pre-release')"
            :disabled="patchlineLoading"
            :class="[
              'flex-1 flex items-center justify-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
              patchlineData?.patchline === 'pre-release'
                ? 'border-status-warning bg-status-warning/10'
                : 'border-dark-50 hover:border-gray-600'
            ]"
          >
            <div class="text-center">
              <p class="font-medium text-white">Pre-Release</p>
              <p class="text-xs text-gray-400">{{ t('settings.patchlinePreReleaseDesc') }}</p>
            </div>
            <svg
              v-if="patchlineData?.patchline === 'pre-release'"
              class="w-5 h-5 text-status-warning"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
          </button>
        </div>

        <div v-else class="text-center py-4 text-gray-400">
          {{ t('common.loading') }}...
        </div>

        <!-- Restart Required Banner -->
        <div v-if="patchlineNeedsRestart" class="p-4 bg-status-warning/20 border border-status-warning/30 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-status-warning font-medium">{{ t('settings.patchlineRestartRequired') }}</p>
              <p class="text-sm text-gray-400 mt-1">{{ t('settings.patchlineRestartRequiredDesc') }}</p>
            </div>
            <button
              v-if="authStore.hasPermission('server.restart')"
              @click="restartForPatchline"
              :disabled="patchlineLoading"
              class="px-4 py-2 bg-status-warning text-dark-400 font-medium rounded-lg hover:bg-status-warning/90 transition-colors disabled:opacity-50"
            >
              {{ patchlineLoading ? t('common.loading') : t('dashboard.restart') }}
            </button>
          </div>
        </div>

        <p v-if="!patchlineNeedsRestart" class="text-xs text-gray-500">
          {{ t('settings.patchlineRestartNote') }}
        </p>
      </div>
    </Card>

    <!-- Accept Early Plugins Settings (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.acceptEarlyPluginsTitle')">
      <p class="text-gray-400 text-sm mb-4">{{ t('settings.acceptEarlyPluginsDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="acceptEarlyPluginsError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ acceptEarlyPluginsError }}
      </div>
      <div v-if="acceptEarlyPluginsSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ acceptEarlyPluginsSuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Setting -->
        <div class="flex items-center justify-between p-4 bg-dark-300 rounded-lg">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="acceptEarlyPluginsData?.acceptEarlyPlugins ?? false"
                :disabled="acceptEarlyPluginsLoading || !authStore.hasPermission('settings.edit')"
                @change="setAcceptEarlyPlugins(($event.target as HTMLInputElement).checked)"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-dark-50 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-hytale-orange peer-disabled:opacity-50 peer-disabled:cursor-not-allowed"></div>
            </label>
            <div>
              <p class="text-white font-medium">{{ t('settings.acceptEarlyPluginsLabel') }}</p>
              <p class="text-sm text-gray-400">{{ t('settings.acceptEarlyPluginsHint') }}</p>
            </div>
          </div>
          <div class="text-sm text-gray-400">
            <span v-if="acceptEarlyPluginsLoading">{{ t('common.loading') }}...</span>
            <span v-else-if="acceptEarlyPluginsData?.acceptEarlyPlugins" class="text-status-success">{{ t('settings.enabled') }}</span>
            <span v-else class="text-gray-500">{{ t('settings.disabled') }}</span>
          </div>
        </div>

        <!-- Restart Required Banner -->
        <div v-if="acceptEarlyPluginsNeedsRestart" class="p-4 bg-status-warning/20 border border-status-warning/30 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-status-warning font-medium">{{ t('settings.acceptEarlyPluginsRestartRequired') }}</p>
              <p class="text-sm text-gray-400 mt-1">{{ t('settings.acceptEarlyPluginsRestartRequiredDesc') }}</p>
            </div>
            <button
              v-if="authStore.hasPermission('server.restart')"
              @click="restartForAcceptEarlyPlugins"
              :disabled="acceptEarlyPluginsLoading"
              class="px-4 py-2 bg-status-warning text-dark-400 font-medium rounded-lg hover:bg-status-warning/90 transition-colors disabled:opacity-50"
            >
              {{ acceptEarlyPluginsLoading ? t('common.loading') : t('dashboard.restart') }}
            </button>
          </div>
        </div>

        <p v-if="!acceptEarlyPluginsNeedsRestart" class="text-xs text-gray-500">
          {{ t('settings.acceptEarlyPluginsRestartNote') }}
        </p>
      </div>
    </Card>

    <!-- Disable Sentry Settings (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.disableSentryTitle')">
      <p class="text-gray-400 text-sm mb-4">{{ t('settings.disableSentryDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="disableSentryError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ disableSentryError }}
      </div>
      <div v-if="disableSentrySuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ disableSentrySuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Setting -->
        <div class="flex items-center justify-between p-4 bg-dark-300 rounded-lg">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="disableSentryData?.disableSentry ?? false"
                :disabled="disableSentryLoading || !authStore.hasPermission('settings.edit')"
                @change="setDisableSentry(($event.target as HTMLInputElement).checked)"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-dark-50 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-hytale-orange peer-disabled:opacity-50 peer-disabled:cursor-not-allowed"></div>
            </label>
            <div>
              <p class="text-white font-medium">{{ t('settings.disableSentryLabel') }}</p>
              <p class="text-sm text-gray-400">{{ t('settings.disableSentryHint') }}</p>
            </div>
          </div>
          <div class="text-sm text-gray-400">
            <span v-if="disableSentryLoading">{{ t('common.loading') }}...</span>
            <span v-else-if="disableSentryData?.disableSentry" class="text-status-warning">{{ t('settings.disabled') }}</span>
            <span v-else class="text-status-success">{{ t('settings.enabled') }}</span>
          </div>
        </div>

        <!-- Restart Required Banner -->
        <div v-if="disableSentryNeedsRestart" class="p-4 bg-status-warning/20 border border-status-warning/30 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-status-warning font-medium">{{ t('settings.disableSentryRestartRequired') }}</p>
              <p class="text-sm text-gray-400 mt-1">{{ t('settings.disableSentryRestartRequiredDesc') }}</p>
            </div>
            <button
              v-if="authStore.hasPermission('server.restart')"
              @click="restartForDisableSentry"
              :disabled="disableSentryLoading"
              class="px-4 py-2 bg-status-warning text-dark-400 font-medium rounded-lg hover:bg-status-warning/90 transition-colors disabled:opacity-50"
            >
              {{ disableSentryLoading ? t('common.loading') : t('dashboard.restart') }}
            </button>
          </div>
        </div>

        <p v-if="!disableSentryNeedsRestart" class="text-xs text-gray-500">
          {{ t('settings.disableSentryRestartNote') }}
        </p>
      </div>
    </Card>

    <!-- Allow OP Settings (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.allowOpTitle')">
      <p class="text-gray-400 text-sm mb-4">{{ t('settings.allowOpDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="allowOpError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ allowOpError }}
      </div>
      <div v-if="allowOpSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ allowOpSuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Setting -->
        <div class="flex items-center justify-between p-4 bg-dark-300 rounded-lg">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="allowOpData?.allowOp ?? false"
                :disabled="allowOpLoading || !authStore.hasPermission('settings.edit')"
                @change="setAllowOp(($event.target as HTMLInputElement).checked)"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-dark-50 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-hytale-orange peer-disabled:opacity-50 peer-disabled:cursor-not-allowed"></div>
            </label>
            <div>
              <p class="text-white font-medium">{{ t('settings.allowOpLabel') }}</p>
              <p class="text-sm text-gray-400">{{ t('settings.allowOpHint') }}</p>
            </div>
          </div>
          <div class="text-sm text-gray-400">
            <span v-if="allowOpLoading">{{ t('common.loading') }}...</span>
            <span v-else-if="allowOpData?.allowOp" class="text-status-success">{{ t('settings.enabled') }}</span>
            <span v-else class="text-gray-500">{{ t('settings.disabled') }}</span>
          </div>
        </div>

        <!-- Restart Required Banner -->
        <div v-if="allowOpNeedsRestart" class="p-4 bg-status-warning/20 border border-status-warning/30 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-status-warning font-medium">{{ t('settings.allowOpRestartRequired') }}</p>
              <p class="text-sm text-gray-400 mt-1">{{ t('settings.allowOpRestartRequiredDesc') }}</p>
            </div>
            <button
              v-if="authStore.hasPermission('server.restart')"
              @click="restartForAllowOp"
              :disabled="allowOpLoading"
              class="px-4 py-2 bg-status-warning text-dark-400 font-medium rounded-lg hover:bg-status-warning/90 transition-colors disabled:opacity-50"
            >
              {{ allowOpLoading ? t('common.loading') : t('dashboard.restart') }}
            </button>
          </div>
        </div>

        <p v-if="!allowOpNeedsRestart" class="text-xs text-gray-500">
          {{ t('settings.allowOpRestartNote') }}
        </p>
      </div>
    </Card>

    <!-- Recommended Plugins Info -->
    <Card v-if="authStore.canManageServer" :title="t('settings.recommendedPluginsTitle')">
      <p class="text-gray-400 text-sm mb-4">{{ t('settings.recommendedPluginsDesc') }}</p>

      <div class="space-y-3">
        <div class="p-3 bg-dark-300 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-white font-medium">Nitrado:WebServer</p>
              <p class="text-sm text-gray-400">{{ t('settings.pluginWebServerDesc') }}</p>
            </div>
            <span class="text-xs text-gray-500 bg-dark-400 px-2 py-1 rounded">Nitrado</span>
          </div>
        </div>

        <div class="p-3 bg-dark-300 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-white font-medium">Nitrado:Query</p>
              <p class="text-sm text-gray-400">{{ t('settings.pluginQueryDesc') }}</p>
            </div>
            <span class="text-xs text-gray-500 bg-dark-400 px-2 py-1 rounded">Nitrado</span>
          </div>
        </div>

        <div class="p-3 bg-dark-300 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-white font-medium">Nitrado:PerformanceSaver</p>
              <p class="text-sm text-gray-400">{{ t('settings.pluginPerformanceSaverDesc') }}</p>
            </div>
            <span class="text-xs text-gray-500 bg-dark-400 px-2 py-1 rounded">Nitrado</span>
          </div>
        </div>

        <div class="p-3 bg-dark-300 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-white font-medium">ApexHosting:PrometheusExporter</p>
              <p class="text-sm text-gray-400">{{ t('settings.pluginPrometheusDesc') }}</p>
            </div>
            <span class="text-xs text-gray-500 bg-dark-400 px-2 py-1 rounded">Apex Hosting</span>
          </div>
        </div>
      </div>

      <p class="text-xs text-gray-500 mt-4">
        {{ t('settings.recommendedPluginsNote') }}
      </p>
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
              v-if="authStore.hasPermission('settings.edit')"
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
            <p class="text-gray-400">{{ t('settings.version') }}: 2.1.0</p>
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
