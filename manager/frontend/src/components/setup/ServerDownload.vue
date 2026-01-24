<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import { subscribeToDownloadProgress, setupApi, type ProgressEvent } from '@/api/setup'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
  back: []
}>()

// Patchline selection (affects which server version is downloaded)
type Patchline = 'release' | 'pre-release'
const patchline = ref<Patchline>('release')

// Download method selection
type DownloadMethod = 'official' | 'custom' | 'manual'
const downloadMethod = ref<DownloadMethod>('official')

// Custom URLs (for custom method)
const customServerUrl = ref('')
const customAssetsUrl = ref('')

// OAuth Device Code Flow state
const deviceCodeState = ref<{
  verificationUrl: string
  verificationUrlDirect: string
  userCode: string
  expiresIn: number
  pollInterval: number
} | null>(null)
const isWaitingForAuth = ref(false)
const authError = ref<string | null>(null)
const authSuccess = ref(false)

// Download progress state
const isDownloading = ref(false)
const downloadProgress = ref({
  serverJar: {
    percent: 0,
    downloaded: 0,
    total: 0,
    complete: false,
  },
  assetsZip: {
    percent: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: 0,
    complete: false,
  },
})

// Download verification state
const isVerifying = ref(false)
const verificationComplete = ref(false)
const verificationResults = ref<{
  serverJar: { size: string; integrity: boolean }
  assetsZip: { size: string; integrity: boolean }
  version: string
  patchline: string
} | null>(null)

// Auto-update option
const autoUpdateEnabled = ref(true)

// Current step within the download flow
type DownloadStep = 'select' | 'auth' | 'downloading' | 'verifying' | 'complete'
const currentDownloadStep = ref<DownloadStep>('select')

// SSE cleanup function
let cleanupSSE: (() => void) | null = null

// Computed properties
const canProceedFromSelect = computed(() => {
  if (downloadMethod.value === 'official') return true
  if (downloadMethod.value === 'custom') {
    return customServerUrl.value.trim() !== '' && customAssetsUrl.value.trim() !== ''
  }
  if (downloadMethod.value === 'manual') return true
  return false
})

const formattedUserCode = computed(() => {
  if (!deviceCodeState.value) return ''
  return deviceCodeState.value.userCode.split('').join(' ')
})

const authTimeRemaining = computed(() => {
  if (!deviceCodeState.value) return ''
  const minutes = Math.floor(deviceCodeState.value.expiresIn / 60)
  return `${minutes} ${t('setup.minutes')}`
})

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

// Format seconds to time string
function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

// Handle method selection
function selectMethod(method: DownloadMethod) {
  downloadMethod.value = method
}

// Proceed from method selection
async function proceedFromSelect() {
  if (downloadMethod.value === 'manual') {
    // Skip download, go directly to verification
    currentDownloadStep.value = 'verifying'
    await verifyDownload()
    return
  }

  if (downloadMethod.value === 'official') {
    // Start OAuth device code flow
    currentDownloadStep.value = 'auth'
    await startDeviceCodeFlow()
  } else if (downloadMethod.value === 'custom') {
    // Start download with custom URLs
    currentDownloadStep.value = 'downloading'
    await startDownload()
  }
}

// State for env config needed message
const needsEnvConfig = ref(false)
const envConfigInstructions = ref<string[]>([])

// Start OAuth device code flow
async function startDeviceCodeFlow() {
  isWaitingForAuth.value = true
  authError.value = null
  authSuccess.value = false
  needsEnvConfig.value = false

  try {
    const response = await setupApi.startDownloaderAuth() as {
      success: boolean
      deviceCode?: string
      verificationUrl?: string
      verificationUrlDirect?: string
      userCode?: string
      expiresIn?: number
      pollInterval?: number
      error?: string
      needsEnvConfig?: boolean
      instructions?: string[]
    }

    // Check if USE_HYTALE_DOWNLOADER needs to be configured
    if (response.needsEnvConfig) {
      needsEnvConfig.value = true
      envConfigInstructions.value = response.instructions || []
      authError.value = response.error || t('setup.envConfigRequired')
      isWaitingForAuth.value = false
      return
    }

    if (response.success && response.deviceCode) {
      deviceCodeState.value = {
        verificationUrl: response.verificationUrl || '',
        verificationUrlDirect: response.verificationUrlDirect || '',
        userCode: response.userCode || '',
        expiresIn: response.expiresIn || 900,
        pollInterval: response.pollInterval || 5,
      }
      // Start polling for auth status
      pollAuthStatus()
    } else {
      authError.value = response.error || t('setup.authStartFailed')
      isWaitingForAuth.value = false
    }
  } catch (err) {
    authError.value = err instanceof Error ? err.message : t('setup.authStartFailed')
    isWaitingForAuth.value = false
  }
}

// Poll for auth status
let authPollInterval: ReturnType<typeof setInterval> | null = null

async function pollAuthStatus() {
  if (authPollInterval) {
    clearInterval(authPollInterval)
  }

  const pollInterval = deviceCodeState.value?.pollInterval || 5

  authPollInterval = setInterval(async () => {
    try {
      const status = await setupApi.checkDownloaderAuthStatus() as {
        authenticated: boolean
        expired?: boolean
        error?: string
        verificationUrl?: string
        verificationUrlDirect?: string
        userCode?: string
        downloadComplete?: boolean
      }

      // Update verification URL and user code if they become available
      if (deviceCodeState.value) {
        if (status.verificationUrl && !deviceCodeState.value.verificationUrl) {
          deviceCodeState.value.verificationUrl = status.verificationUrl
        }
        if (status.verificationUrlDirect && !deviceCodeState.value.verificationUrlDirect) {
          deviceCodeState.value.verificationUrlDirect = status.verificationUrlDirect
        }
        if (status.userCode && !deviceCodeState.value.userCode) {
          deviceCodeState.value.userCode = status.userCode
        }
      }

      // Check if download is complete
      if (status.downloadComplete) {
        clearInterval(authPollInterval!)
        authPollInterval = null
        authSuccess.value = true
        isWaitingForAuth.value = false
        currentDownloadStep.value = 'verifying'
        verifyDownload()
        return
      }

      if (status.authenticated) {
        clearInterval(authPollInterval!)
        authPollInterval = null
        authSuccess.value = true
        isWaitingForAuth.value = false

        // Wait a moment to show success, then go to downloading view
        setTimeout(() => {
          currentDownloadStep.value = 'downloading'
          startDownload()
        }, 1500)
      } else if (status.expired) {
        clearInterval(authPollInterval!)
        authPollInterval = null
        authError.value = t('setup.authCodeExpired')
        isWaitingForAuth.value = false
      } else if (status.error) {
        clearInterval(authPollInterval!)
        authPollInterval = null
        authError.value = status.error
        isWaitingForAuth.value = false
      }
    } catch {
      // Silently continue polling on network errors
    }
  }, pollInterval * 1000)
}

// Copy verification URL to clipboard
async function copyVerificationUrl() {
  if (!deviceCodeState.value) return
  try {
    await navigator.clipboard.writeText(deviceCodeState.value.verificationUrl)
  } catch {
    // Fallback for older browsers
    const textArea = document.createElement('textarea')
    textArea.value = deviceCodeState.value.verificationUrl
    document.body.appendChild(textArea)
    textArea.select()
    document.execCommand('copy')
    document.body.removeChild(textArea)
  }
}

// Start download process
async function startDownload() {
  isDownloading.value = true

  // Subscribe to SSE progress updates
  cleanupSSE = subscribeToDownloadProgress(
    handleDownloadProgress,
    handleDownloadComplete,
    handleDownloadError
  )

  try {
    // Trigger the download on the backend
    const downloadRequest = downloadMethod.value === 'custom'
      ? { method: 'custom', serverUrl: customServerUrl.value, assetsUrl: customAssetsUrl.value }
      : { method: 'official', patchline: patchline.value }

    await setupApi.startDownload(downloadRequest)
  } catch (err) {
    handleDownloadError(err instanceof Error ? err.message : t('setup.downloadStartFailed'))
  }
}

// Handle download progress events
function handleDownloadProgress(event: ProgressEvent) {
  if (event.currentFile === 'HytaleServer.jar') {
    downloadProgress.value.serverJar = {
      percent: event.percent || 0,
      downloaded: event.bytesDone || 0,
      total: event.bytesTotal || 0,
      complete: event.percent === 100,
    }
  } else if (event.currentFile === 'Assets.zip') {
    downloadProgress.value.assetsZip = {
      percent: event.percent || 0,
      downloaded: event.bytesDone || 0,
      total: event.bytesTotal || 0,
      speed: event.bytesPerSecond || 0,
      eta: event.estimatedSeconds || 0,
      complete: event.percent === 100,
    }
  }
}

// Handle download complete
function handleDownloadComplete() {
  isDownloading.value = false
  if (cleanupSSE) {
    cleanupSSE()
    cleanupSSE = null
  }
  currentDownloadStep.value = 'verifying'
  verifyDownload()
}

// Handle download error
function handleDownloadError(error: string) {
  isDownloading.value = false
  setupStore.setError(error)
  if (cleanupSSE) {
    cleanupSSE()
    cleanupSSE = null
  }
}

// Verify downloaded files
async function verifyDownload() {
  isVerifying.value = true

  try {
    const result = await setupApi.verifyDownload()
    if (result.success) {
      verificationResults.value = {
        serverJar: { size: result.serverJarSize || '', integrity: result.serverJarIntegrity || false },
        assetsZip: { size: result.assetsZipSize || '', integrity: result.assetsZipIntegrity || false },
        version: result.version || '',
        patchline: result.patchline || '',
      }
      verificationComplete.value = true
      currentDownloadStep.value = 'complete'
    } else {
      setupStore.setError(result.error || t('setup.verificationFailed'))
    }
  } catch (err) {
    setupStore.setError(err instanceof Error ? err.message : t('setup.verificationFailed'))
  } finally {
    isVerifying.value = false
  }
}

// Handle continue to next step
async function handleContinue() {
  // Save download settings
  const success = await setupStore.saveStep('server-download', {
    method: downloadMethod.value,
    patchline: patchline.value,
    autoUpdate: autoUpdateEnabled.value,
    customUrls: downloadMethod.value === 'custom' ? {
      serverUrl: customServerUrl.value,
      assetsUrl: customAssetsUrl.value,
    } : null,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  if (currentDownloadStep.value !== 'select') {
    // Go back within the download flow
    if (currentDownloadStep.value === 'auth') {
      if (authPollInterval) {
        clearInterval(authPollInterval)
        authPollInterval = null
      }
      currentDownloadStep.value = 'select'
      deviceCodeState.value = null
      isWaitingForAuth.value = false
      authError.value = null
    } else if (currentDownloadStep.value === 'downloading') {
      // Cancel download - can't really go back during download
    }
    return
  }
  emit('back')
}

// Retry auth
function retryAuth() {
  authError.value = null
  startDeviceCodeFlow()
}

// Load saved data on mount
onMounted(() => {
  const savedData = setupStore.setupData.serverDownload
  if (savedData) {
    if (savedData.patchline) patchline.value = savedData.patchline as Patchline
    if (savedData.method) downloadMethod.value = savedData.method as DownloadMethod
    if (savedData.autoUpdate !== undefined) autoUpdateEnabled.value = savedData.autoUpdate
  }
})

// Cleanup on unmount
onUnmounted(() => {
  if (cleanupSSE) {
    cleanupSSE()
  }
  if (authPollInterval) {
    clearInterval(authPollInterval)
  }
})

// Watch for expiry countdown
watch(deviceCodeState, () => {
  if (deviceCodeState.value && deviceCodeState.value.expiresIn > 0) {
    const countdownInterval = setInterval(() => {
      if (deviceCodeState.value) {
        deviceCodeState.value.expiresIn--
        if (deviceCodeState.value.expiresIn <= 0) {
          clearInterval(countdownInterval)
        }
      }
    }, 1000)
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">
        {{ currentDownloadStep === 'auth' ? t('setup.hytaleAuthTitle') :
           currentDownloadStep === 'downloading' ? t('setup.downloadingTitle') :
           currentDownloadStep === 'verifying' || currentDownloadStep === 'complete' ? t('setup.downloadCompleteTitle') :
           t('setup.serverDownloadTitle') }}
      </h2>
      <p class="text-gray-400">
        {{ currentDownloadStep === 'auth' ? t('setup.hytaleAuthDescription') :
           currentDownloadStep === 'downloading' ? t('setup.downloadingDescription') :
           currentDownloadStep === 'verifying' || currentDownloadStep === 'complete' ? t('setup.downloadVerifyDescription') :
           t('setup.serverDownloadDescription') }}
      </p>
    </div>

    <!-- Step 3.1: Download Method Selection -->
    <template v-if="currentDownloadStep === 'select'">
      <div class="space-y-4">
        <!-- Patchline Selection -->
        <div class="mb-6">
          <label class="label mb-3">{{ t('setup.patchlineLabel') }}</label>
          <div class="grid grid-cols-2 gap-3">
            <!-- Release -->
            <button
              type="button"
              @click="patchline = 'release'"
              class="p-4 rounded-xl border-2 text-left transition-all duration-200"
              :class="[
                patchline === 'release'
                  ? 'border-status-success bg-status-success/10'
                  : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
              ]"
            >
              <div class="flex items-center gap-3">
                <div
                  class="w-4 h-4 rounded-full border-2 flex items-center justify-center"
                  :class="patchline === 'release' ? 'border-status-success' : 'border-gray-500'"
                >
                  <div
                    v-if="patchline === 'release'"
                    class="w-2 h-2 rounded-full bg-status-success"
                  />
                </div>
                <div>
                  <p class="text-white font-semibold">{{ t('setup.patchlineRelease') }}</p>
                  <p class="text-xs text-gray-400">{{ t('setup.patchlineReleaseDesc') }}</p>
                </div>
              </div>
            </button>

            <!-- Pre-Release -->
            <button
              type="button"
              @click="patchline = 'pre-release'"
              class="p-4 rounded-xl border-2 text-left transition-all duration-200"
              :class="[
                patchline === 'pre-release'
                  ? 'border-status-warning bg-status-warning/10'
                  : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
              ]"
            >
              <div class="flex items-center gap-3">
                <div
                  class="w-4 h-4 rounded-full border-2 flex items-center justify-center"
                  :class="patchline === 'pre-release' ? 'border-status-warning' : 'border-gray-500'"
                >
                  <div
                    v-if="patchline === 'pre-release'"
                    class="w-2 h-2 rounded-full bg-status-warning"
                  />
                </div>
                <div>
                  <p class="text-white font-semibold">{{ t('setup.patchlinePreRelease') }}</p>
                  <p class="text-xs text-gray-400">{{ t('setup.patchlinePreReleaseDesc') }}</p>
                </div>
              </div>
            </button>
          </div>
        </div>

        <div class="border-t border-dark-50/30 pt-4">
          <label class="label mb-3">{{ t('setup.downloadMethodLabel') }}</label>
        </div>

        <!-- Official Downloader Option -->
        <button
          @click="selectMethod('official')"
          class="w-full p-5 rounded-xl border-2 text-left transition-all duration-200"
          :class="[
            downloadMethod === 'official'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
          ]"
        >
          <div class="flex items-start gap-4">
            <div class="flex-shrink-0 mt-1">
              <div
                class="w-5 h-5 rounded-full border-2 flex items-center justify-center"
                :class="downloadMethod === 'official' ? 'border-hytale-orange' : 'border-gray-500'"
              >
                <div
                  v-if="downloadMethod === 'official'"
                  class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
                />
              </div>
            </div>
            <div class="flex-1">
              <p class="text-white font-semibold mb-1">{{ t('setup.downloadMethodOfficial') }}</p>
              <p class="text-sm text-gray-400 mb-2">{{ t('setup.downloadMethodOfficialDesc') }}</p>
              <div class="flex flex-wrap gap-2">
                <span class="text-xs px-2 py-1 rounded bg-status-success/20 text-status-success">
                  {{ t('setup.autoUpdates') }}
                </span>
                <span class="text-xs px-2 py-1 rounded bg-status-success/20 text-status-success">
                  {{ t('setup.latestVersion') }}
                </span>
              </div>
            </div>
          </div>
        </button>

        <!-- Custom URLs Option -->
        <button
          @click="selectMethod('custom')"
          class="w-full p-5 rounded-xl border-2 text-left transition-all duration-200"
          :class="[
            downloadMethod === 'custom'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
          ]"
        >
          <div class="flex items-start gap-4">
            <div class="flex-shrink-0 mt-1">
              <div
                class="w-5 h-5 rounded-full border-2 flex items-center justify-center"
                :class="downloadMethod === 'custom' ? 'border-hytale-orange' : 'border-gray-500'"
              >
                <div
                  v-if="downloadMethod === 'custom'"
                  class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
                />
              </div>
            </div>
            <div class="flex-1">
              <p class="text-white font-semibold mb-1">{{ t('setup.downloadMethodCustom') }}</p>
              <p class="text-sm text-gray-400">{{ t('setup.downloadMethodCustomDesc') }}</p>
            </div>
          </div>
        </button>

        <!-- Custom URL Inputs -->
        <div v-if="downloadMethod === 'custom'" class="ml-9 space-y-4 pt-2">
          <div>
            <label class="label">{{ t('setup.serverJarUrl') }}</label>
            <Input
              v-model="customServerUrl"
              type="url"
              :placeholder="t('setup.serverJarUrlPlaceholder')"
            />
          </div>
          <div>
            <label class="label">{{ t('setup.assetsZipUrl') }}</label>
            <Input
              v-model="customAssetsUrl"
              type="url"
              :placeholder="t('setup.assetsZipUrlPlaceholder')"
            />
          </div>
        </div>

        <!-- Manual Option -->
        <button
          @click="selectMethod('manual')"
          class="w-full p-5 rounded-xl border-2 text-left transition-all duration-200"
          :class="[
            downloadMethod === 'manual'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
          ]"
        >
          <div class="flex items-start gap-4">
            <div class="flex-shrink-0 mt-1">
              <div
                class="w-5 h-5 rounded-full border-2 flex items-center justify-center"
                :class="downloadMethod === 'manual' ? 'border-hytale-orange' : 'border-gray-500'"
              >
                <div
                  v-if="downloadMethod === 'manual'"
                  class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
                />
              </div>
            </div>
            <div class="flex-1">
              <p class="text-white font-semibold mb-1">{{ t('setup.downloadMethodManual') }}</p>
              <p class="text-sm text-gray-400">{{ t('setup.downloadMethodManualDesc') }}</p>
            </div>
          </div>
        </button>
      </div>
    </template>

    <!-- Step 3.2: Hytale OAuth Device Code Flow -->
    <template v-else-if="currentDownloadStep === 'auth'">
      <div class="card">
        <div class="card-body">
          <!-- Success State -->
          <div v-if="authSuccess" class="text-center py-8">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-success/20 rounded-full mb-4">
              <svg class="w-8 h-8 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg">{{ t('setup.authSuccess') }}</p>
            <p class="text-gray-400 mt-2">{{ t('setup.startingDownload') }}</p>
          </div>

          <!-- Env Config Required State -->
          <div v-else-if="needsEnvConfig" class="py-6">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-warning/20 rounded-full mb-4 mx-auto block text-center">
              <svg class="w-8 h-8 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg text-center">{{ t('setup.envConfigRequired') }}</p>
            <p class="text-status-warning mt-2 text-center">{{ authError }}</p>

            <div class="mt-4 bg-dark-300 rounded-lg p-4 text-left">
              <p class="text-sm text-gray-300 mb-2 font-medium">{{ t('setup.followTheseSteps') }}:</p>
              <ol class="list-decimal list-inside space-y-2 text-sm text-gray-400">
                <li v-for="(instruction, index) in envConfigInstructions" :key="index">
                  <code v-if="instruction.includes('=') || instruction.includes('docker')" class="bg-dark-400 px-1 rounded text-hytale-orange">{{ instruction }}</code>
                  <span v-else>{{ instruction }}</span>
                </li>
              </ol>
            </div>

            <Button class="mt-4" @click="retryAuth">
              {{ t('setup.retryAuth') }}
            </Button>
          </div>

          <!-- Error State -->
          <div v-else-if="authError" class="text-center py-8">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-error/20 rounded-full mb-4">
              <svg class="w-8 h-8 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg">{{ t('setup.authFailed') }}</p>
            <p class="text-status-error mt-2">{{ authError }}</p>
            <Button class="mt-4" @click="retryAuth">
              {{ t('setup.retryAuth') }}
            </Button>
          </div>

          <!-- Device Code Display -->
          <div v-else-if="deviceCodeState" class="space-y-6">
            <div class="text-center">
              <!-- Option 1: Direct Link (One-Click Auth) -->
              <div v-if="deviceCodeState.verificationUrlDirect" class="bg-dark-300 rounded-lg p-4 mb-4">
                <p class="text-sm text-gray-400 mb-3">{{ t('setup.quickAuthOption') }}</p>
                <a
                  :href="deviceCodeState.verificationUrlDirect"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-2 px-6 py-3 bg-hytale-orange hover:bg-hytale-orange-light text-white font-semibold rounded-lg transition-colors"
                >
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  {{ t('setup.openAuthPage') }}
                </a>
                <p class="text-xs text-gray-500 mt-2">{{ t('setup.directLinkHint') }}</p>
              </div>

              <!-- Divider -->
              <div v-if="deviceCodeState.verificationUrlDirect && deviceCodeState.verificationUrl" class="flex items-center gap-4 my-4">
                <div class="flex-1 h-px bg-dark-50"></div>
                <span class="text-gray-500 text-sm">{{ t('setup.orAlternatively') }}</span>
                <div class="flex-1 h-px bg-dark-50"></div>
              </div>

              <!-- Option 2: Manual Code Entry -->
              <div class="bg-dark-300 rounded-lg p-4 mb-4">
                <p class="text-sm text-gray-400 mb-2">{{ t('setup.manualAuthOption') }}</p>

                <!-- Verification URL (Base URL) -->
                <div class="mb-4">
                  <p class="text-xs text-gray-500 mb-1">{{ t('setup.verificationUrl') }}</p>
                  <a
                    :href="deviceCodeState.verificationUrl || deviceCodeState.verificationUrlDirect"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-hytale-orange hover:text-hytale-orange-light break-all text-sm"
                  >
                    {{ deviceCodeState.verificationUrl || deviceCodeState.verificationUrlDirect }}
                  </a>
                  <Button
                    variant="secondary"
                    size="sm"
                    class="mt-2"
                    @click="copyVerificationUrl"
                  >
                    <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                    {{ t('setup.copyLink') }}
                  </Button>
                </div>

                <p class="text-gray-300 mb-3">{{ t('setup.enterCode') }}</p>

                <!-- User Code Display -->
                <div class="bg-dark-400 border-2 border-dark-50 rounded-xl p-6 inline-block">
                  <p class="text-3xl font-mono font-bold text-white tracking-widest">
                    {{ formattedUserCode }}
                  </p>
                </div>
              </div>
            </div>

            <!-- Waiting Status -->
            <div class="flex items-center justify-center gap-3 text-gray-400">
              <svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>{{ t('setup.waitingForConfirmation') }}</span>
            </div>

            <!-- Expiry Timer -->
            <div class="text-center text-sm text-gray-500">
              {{ t('setup.codeValidFor', { time: authTimeRemaining }) }}
            </div>

            <!-- Progress Bar (animated) -->
            <div class="h-1 bg-dark-50 rounded-full overflow-hidden">
              <div class="h-full bg-hytale-orange animate-pulse" style="width: 100%" />
            </div>
          </div>

          <!-- Loading State -->
          <div v-else class="text-center py-8">
            <svg class="w-12 h-12 text-hytale-orange animate-spin mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <p class="text-gray-400">{{ t('setup.initializingAuth') }}</p>
          </div>
        </div>
      </div>
    </template>

    <!-- Step 3.3: Download Progress -->
    <template v-else-if="currentDownloadStep === 'downloading'">
      <!-- Auth Success Banner -->
      <div v-if="downloadMethod === 'official'" class="flex items-center gap-3 p-4 bg-status-success/10 border border-status-success/20 rounded-lg mb-4">
        <svg class="w-5 h-5 text-status-success flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <p class="text-status-success text-sm">{{ t('setup.authSuccessful') }}</p>
      </div>

      <!-- Download Progress Card -->
      <div class="card">
        <div class="card-body text-center py-8">
          <!-- Animated Download Icon -->
          <div class="inline-flex items-center justify-center w-20 h-20 bg-hytale-orange/20 rounded-full mb-6">
            <svg class="w-10 h-10 text-hytale-orange animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </div>

          <h3 class="text-xl font-semibold text-white mb-2">{{ t('setup.downloadingTitle') }}</h3>
          <p class="text-gray-400 mb-6">{{ t('setup.downloadingDescription') }}</p>

          <!-- Indeterminate Progress Bar -->
          <div class="h-2 bg-dark-50 rounded-full overflow-hidden mb-6">
            <div class="h-full bg-gradient-to-r from-hytale-orange via-hytale-orange-light to-hytale-orange bg-[length:200%_100%] animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full" />
          </div>

          <!-- Download Status -->
          <div class="space-y-3">
            <div class="flex items-center justify-center gap-2 text-gray-300">
              <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>{{ t('setup.downloadInProgress') }}</span>
            </div>
            <p class="text-sm text-gray-500">{{ t('setup.downloadInfoNotice') }}</p>
          </div>
        </div>
      </div>

      <!-- Files being downloaded -->
      <div class="grid grid-cols-2 gap-4 mt-4">
        <div class="card">
          <div class="card-body flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-hytale-orange/20 flex items-center justify-center flex-shrink-0">
              <svg class="w-5 h-5 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
            <div>
              <p class="text-white font-medium text-sm">HytaleServer.jar</p>
              <p class="text-xs text-gray-500">~80 MB</p>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-body flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-hytale-orange/20 flex items-center justify-center flex-shrink-0">
              <svg class="w-5 h-5 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p class="text-white font-medium text-sm">Assets.zip</p>
              <p class="text-xs text-gray-500">~3.3 GB</p>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Step 3.4: Download Verification & Complete -->
    <template v-else-if="currentDownloadStep === 'verifying' || currentDownloadStep === 'complete'">
      <!-- Verifying State -->
      <div v-if="isVerifying" class="text-center py-8">
        <svg class="w-12 h-12 text-hytale-orange animate-spin mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <p class="text-gray-400">{{ t('setup.verifyingFiles') }}</p>
      </div>

      <!-- Verification Results -->
      <div v-else-if="verificationResults" class="space-y-4">
        <div class="card">
          <div class="card-body space-y-3">
            <!-- Server JAR -->
            <div class="flex items-center justify-between py-2">
              <div class="flex items-center gap-3">
                <div
                  class="w-8 h-8 rounded-lg flex items-center justify-center"
                  :class="verificationResults.serverJar.integrity ? 'bg-status-success/20' : 'bg-status-error/20'"
                >
                  <svg
                    class="w-4 h-4"
                    :class="verificationResults.serverJar.integrity ? 'text-status-success' : 'text-status-error'"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      v-if="verificationResults.serverJar.integrity"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M5 13l4 4L19 7"
                    />
                    <path
                      v-else
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </div>
                <span class="text-white">HytaleServer.jar</span>
              </div>
              <div class="text-right">
                <p class="text-sm text-gray-300">{{ verificationResults.serverJar.size }}</p>
                <p class="text-xs text-gray-500">{{ t('setup.integrityOk') }}</p>
              </div>
            </div>

            <!-- Assets ZIP -->
            <div class="flex items-center justify-between py-2">
              <div class="flex items-center gap-3">
                <div
                  class="w-8 h-8 rounded-lg flex items-center justify-center"
                  :class="verificationResults.assetsZip.integrity ? 'bg-status-success/20' : 'bg-status-error/20'"
                >
                  <svg
                    class="w-4 h-4"
                    :class="verificationResults.assetsZip.integrity ? 'text-status-success' : 'text-status-error'"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      v-if="verificationResults.assetsZip.integrity"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M5 13l4 4L19 7"
                    />
                    <path
                      v-else
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </div>
                <span class="text-white">Assets.zip</span>
              </div>
              <div class="text-right">
                <p class="text-sm text-gray-300">{{ verificationResults.assetsZip.size }}</p>
                <p class="text-xs text-gray-500">{{ t('setup.integrityOk') }}</p>
              </div>
            </div>

            <!-- Version Info -->
            <div class="flex items-center justify-between py-2 border-t border-dark-50/30">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-lg flex items-center justify-center bg-hytale-orange/20">
                  <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                  </svg>
                </div>
                <span class="text-white">{{ t('setup.version') }}</span>
              </div>
              <div class="text-right">
                <p class="text-sm text-gray-300">{{ verificationResults.version }}</p>
                <p class="text-xs text-gray-500">({{ verificationResults.patchline }})</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Auto-Update Option -->
        <div class="card">
          <div class="card-body">
            <label class="flex items-start gap-3 cursor-pointer">
              <input
                v-model="autoUpdateEnabled"
                type="checkbox"
                class="mt-1 w-4 h-4 rounded border-gray-600 bg-dark-300 text-hytale-orange focus:ring-hytale-orange focus:ring-offset-0"
              />
              <div>
                <p class="text-white font-medium">{{ t('setup.enableAutoUpdate') }}</p>
                <p class="text-sm text-gray-400">{{ t('setup.autoUpdateDescription') }}</p>
              </div>
            </label>
          </div>
        </div>
      </div>
    </template>

    <!-- Error Message -->
    <div v-if="setupStore.error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error text-sm">{{ setupStore.error }}</p>
    </div>

    <!-- Actions -->
    <div class="flex items-center justify-between pt-4">
      <Button
        variant="secondary"
        :disabled="isDownloading || isVerifying"
        @click="handleBack"
      >
        <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('common.back') }}
      </Button>

      <Button
        v-if="currentDownloadStep === 'select'"
        :disabled="!canProceedFromSelect"
        @click="proceedFromSelect"
      >
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>

      <Button
        v-else-if="currentDownloadStep === 'complete'"
        :loading="setupStore.isLoading"
        @click="handleContinue"
      >
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>

      <div v-else>
        <!-- Empty div to maintain layout during download/auth -->
      </div>
    </div>
  </div>
</template>
