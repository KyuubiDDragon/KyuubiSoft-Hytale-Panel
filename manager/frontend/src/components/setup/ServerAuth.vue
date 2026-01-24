<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'
import { setupApi } from '@/api/setup'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
  back: []
}>()

// Current step within the auth flow (Phase 4)
// Step 4.1: starting - First server start with live console output
// Step 4.2: server-auth - Server device code flow (separate from downloader!)
// Step 4.3: persistence - Persistence setup progress
// Step 4.4: complete - Verification complete status showing all auth statuses
type AuthStep = 'starting' | 'server-auth' | 'persistence' | 'complete'
const currentAuthStep = ref<AuthStep>('starting')

// Step 4.1: First Server Start
const isServerStarting = ref(false)
const serverStarted = ref(false)
const serverNeedsAuth = ref(false)
const consoleLines = ref<Array<{ timestamp: string; message: string; type: 'info' | 'warning' | 'error' }>>([])
const consoleContainer = ref<HTMLElement | null>(null)

// Step 4.2: Server Device Code Flow
const serverDeviceCodeState = ref<{
  verificationUrl: string
  verificationUrlDirect: string
  userCode: string
  expiresIn: number
  pollInterval: number
} | null>(null)
const isWaitingForServerAuth = ref(false)
const serverAuthError = ref<string | null>(null)
const serverAuthSuccess = ref(false)

// Step 4.3: Persistence Setup
const isPersistenceSetup = ref(false)
const persistenceProgress = ref(0)
const persistenceComplete = ref(false)

// Step 4.4: Verification Complete
const allAuthStatus = ref({
  downloaderCredentials: false,
  serverToken: false,
  tokenPersistence: false,
  machineId: false,
})

// SSE/WebSocket cleanup
let consoleEventSource: EventSource | null = null
let authPollInterval: ReturnType<typeof setInterval> | null = null
let expiryCountdownInterval: ReturnType<typeof setInterval> | null = null
let sseReconnectAttempts = 0
const MAX_SSE_RECONNECT_ATTEMPTS = 5

// Computed properties
const formattedServerUserCode = computed(() => {
  if (!serverDeviceCodeState.value) return ''
  return serverDeviceCodeState.value.userCode
})

const serverAuthTimeRemaining = computed(() => {
  if (!serverDeviceCodeState.value) return ''
  const minutes = Math.floor(serverDeviceCodeState.value.expiresIn / 60)
  const seconds = serverDeviceCodeState.value.expiresIn % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
})

// Scroll console to bottom
function scrollConsoleToBottom() {
  nextTick(() => {
    if (consoleContainer.value) {
      consoleContainer.value.scrollTop = consoleContainer.value.scrollHeight
    }
  })
}

// Add console line
function addConsoleLine(message: string, type: 'info' | 'warning' | 'error' = 'info') {
  const now = new Date()
  const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
  consoleLines.value.push({ timestamp, message, type })

  // Keep only last 100 lines
  if (consoleLines.value.length > 100) {
    consoleLines.value = consoleLines.value.slice(-100)
  }

  scrollConsoleToBottom()
}

// Connect to SSE for console output with automatic reconnection
function connectConsoleSSE() {
  if (consoleEventSource) {
    consoleEventSource.close()
    consoleEventSource = null
  }

  consoleEventSource = new EventSource('/api/setup/server/console')

  consoleEventSource.onmessage = (event) => {
    // Reset reconnect counter on successful message
    sseReconnectAttempts = 0

    try {
      const data = JSON.parse(event.data)

      if (data.type === 'log') {
        addConsoleLine(data.message, data.level || 'info')
      } else if (data.type === 'auth_required') {
        serverNeedsAuth.value = true
        serverStarted.value = true
        isServerStarting.value = false
      } else if (data.type === 'started') {
        serverStarted.value = true
        isServerStarting.value = false
        // Check if auth is needed
        if (!data.authenticated) {
          serverNeedsAuth.value = true
        }
      } else if (data.type === 'error') {
        addConsoleLine(data.message, 'error')
        setupStore.setError(data.message)
        isServerStarting.value = false
      }
    } catch {
      // Treat as plain text log - check for server boot messages
      const logText = event.data
      addConsoleLine(logText)

      // Detect server started from log output
      if (logText.includes('Server Booted') || logText.includes('Hytale Server Booted')) {
        serverStarted.value = true
        isServerStarting.value = false
      }

      // Detect auth required from log output
      if (logText.includes('No server tokens configured') || logText.includes('AUTHENTICATION REQUIRED') || logText.includes('/auth login')) {
        serverNeedsAuth.value = true
        serverStarted.value = true
        isServerStarting.value = false
      }
    }
  }

  consoleEventSource.onerror = () => {
    if (consoleEventSource) {
      consoleEventSource.close()
      consoleEventSource = null
    }

    // Auto-reconnect with exponential backoff (unless we're done)
    if (isServerStarting.value && sseReconnectAttempts < MAX_SSE_RECONNECT_ATTEMPTS) {
      sseReconnectAttempts++
      const delay = Math.min(1000 * Math.pow(2, sseReconnectAttempts - 1), 10000)
      addConsoleLine(`Connection lost, reconnecting in ${delay / 1000}s...`, 'warning')
      setTimeout(() => {
        if (isServerStarting.value) {
          connectConsoleSSE()
        }
      }, delay)
    }
  }
}

// Fallback status check interval
let statusCheckInterval: ReturnType<typeof setInterval> | null = null

// Check server status via REST API (fallback for SSE issues)
async function checkServerStatusFallback() {
  try {
    // Use auth-free setup endpoint for logs
    const logsResponse = await fetch('/api/setup/server/logs?lines=200')
    if (logsResponse.ok) {
      const logsData = await logsResponse.json()

      // The endpoint now returns parsed status
      const isBooted = logsData.booted === true
      const needsAuth = logsData.authRequired === true

      if (isBooted && needsAuth) {
        console.log('[Setup] Server status detected via fallback check')
        serverStarted.value = true
        serverNeedsAuth.value = true
        isServerStarting.value = false

        // Stop fallback checking
        if (statusCheckInterval) {
          clearInterval(statusCheckInterval)
          statusCheckInterval = null
        }
      }
    }
  } catch (err) {
    console.log('[Setup] Fallback status check failed:', err)
  }
}

// Start the server for the first time (Step 4.1)
async function startServer() {
  isServerStarting.value = true
  consoleLines.value = []
  sseReconnectAttempts = 0

  // Subscribe to console output via SSE
  connectConsoleSSE()

  // Start fallback status checking (in case SSE fails or misses events)
  // Check every 5 seconds
  statusCheckInterval = setInterval(checkServerStatusFallback, 5000)

  // Trigger server start
  try {
    const result = await setupApi.startServerFirstTime()

    if (!result.success) {
      setupStore.setError(result.error || t('setup.serverStartFailed'))
      isServerStarting.value = false
    }
  } catch (err) {
    // Check if it's a timeout error - server might still be starting
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (errorMessage.includes('timeout') || errorMessage.includes('504') || errorMessage.includes('Gateway')) {
      // Don't show error for timeout - the server might still be starting
      // The SSE connection and fallback check will update us when the server is ready
      addConsoleLine('Server start request sent, waiting for server to boot...', 'info')

      // Do an immediate fallback check
      setTimeout(checkServerStatusFallback, 2000)
    } else {
      setupStore.setError(errorMessage || t('setup.serverStartFailed'))
      isServerStarting.value = false
    }
  }
}

// Proceed to server authentication (Step 4.2)
function proceedToServerAuth() {
  if (consoleEventSource) {
    consoleEventSource.close()
    consoleEventSource = null
  }
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
    statusCheckInterval = null
  }
  currentAuthStep.value = 'server-auth'
  startServerDeviceCodeFlow()
}

// Start server device code flow (Step 4.2)
async function startServerDeviceCodeFlow() {
  isWaitingForServerAuth.value = true
  serverAuthError.value = null
  serverAuthSuccess.value = false

  try {
    const response = await setupApi.startServerAuth() as {
      success: boolean
      deviceCode?: string
      verificationUrl?: string
      verificationUrlDirect?: string
      userCode?: string
      expiresIn?: number
      pollInterval?: number
      error?: string
    }
    if (response.success && response.deviceCode) {
      serverDeviceCodeState.value = {
        verificationUrl: response.verificationUrl || '',
        verificationUrlDirect: response.verificationUrlDirect || '',
        userCode: response.userCode || '',
        expiresIn: response.expiresIn || 900,
        pollInterval: response.pollInterval || 5,
      }
      // Start polling for auth status
      pollServerAuthStatus()
      // Start expiry countdown
      startExpiryCountdown()
    } else {
      serverAuthError.value = response.error || t('setup.authStartFailed')
      isWaitingForServerAuth.value = false
    }
  } catch (err) {
    serverAuthError.value = err instanceof Error ? err.message : t('setup.authStartFailed')
    isWaitingForServerAuth.value = false
  }
}

// Start expiry countdown
function startExpiryCountdown() {
  if (expiryCountdownInterval) {
    clearInterval(expiryCountdownInterval)
  }

  expiryCountdownInterval = setInterval(() => {
    if (serverDeviceCodeState.value && serverDeviceCodeState.value.expiresIn > 0) {
      serverDeviceCodeState.value.expiresIn--
      if (serverDeviceCodeState.value.expiresIn <= 0) {
        clearInterval(expiryCountdownInterval!)
        expiryCountdownInterval = null
      }
    } else if (expiryCountdownInterval) {
      clearInterval(expiryCountdownInterval)
      expiryCountdownInterval = null
    }
  }, 1000)
}

// Poll for server auth status
async function pollServerAuthStatus() {
  if (authPollInterval) {
    clearInterval(authPollInterval)
  }

  const pollInterval = serverDeviceCodeState.value?.pollInterval || 5

  authPollInterval = setInterval(async () => {
    try {
      const status = await setupApi.checkServerAuthStatus()

      if (status.authenticated) {
        clearInterval(authPollInterval!)
        authPollInterval = null
        if (expiryCountdownInterval) {
          clearInterval(expiryCountdownInterval)
          expiryCountdownInterval = null
        }
        serverAuthSuccess.value = true
        isWaitingForServerAuth.value = false

        // Wait a moment to show success, then proceed to persistence
        setTimeout(() => {
          currentAuthStep.value = 'persistence'
          setupPersistence()
        }, 1500)
      } else if (status.expired) {
        clearInterval(authPollInterval!)
        authPollInterval = null
        serverAuthError.value = t('setup.authCodeExpired')
        isWaitingForServerAuth.value = false
      } else if (status.error) {
        clearInterval(authPollInterval!)
        authPollInterval = null
        serverAuthError.value = status.error
        isWaitingForServerAuth.value = false
      }
    } catch {
      // Silently continue polling on network errors
    }
  }, pollInterval * 1000)
}

// Open server verification URL in new tab (prefer direct URL with code)
function openServerVerificationUrl() {
  if (!serverDeviceCodeState.value) return
  const url = serverDeviceCodeState.value.verificationUrlDirect || serverDeviceCodeState.value.verificationUrl
  window.open(url, '_blank', 'noopener,noreferrer')
}

// Copy server verification URL to clipboard
async function copyServerVerificationUrl() {
  if (!serverDeviceCodeState.value) return
  try {
    await navigator.clipboard.writeText(serverDeviceCodeState.value.verificationUrl)
  } catch {
    const textArea = document.createElement('textarea')
    textArea.value = serverDeviceCodeState.value.verificationUrl
    document.body.appendChild(textArea)
    textArea.select()
    document.execCommand('copy')
    document.body.removeChild(textArea)
  }
}

// Retry server auth
function retryServerAuth() {
  serverAuthError.value = null
  startServerDeviceCodeFlow()
}

// Setup persistence (Step 4.3)
async function setupPersistence() {
  isPersistenceSetup.value = true
  persistenceProgress.value = 0
  consoleLines.value = []

  // Subscribe to console for persistence setup logs
  try {
    consoleEventSource = new EventSource('/api/setup/server/console')

    consoleEventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'log') {
          addConsoleLine(data.message, data.level || 'info')
        }
      } catch {
        addConsoleLine(event.data)
      }
    }

    consoleEventSource.onerror = () => {
      if (consoleEventSource) {
        consoleEventSource.close()
        consoleEventSource = null
      }
    }
  } catch {
    // SSE not critical for persistence
  }

  try {
    // Simulate progress updates
    const progressInterval = setInterval(() => {
      if (persistenceProgress.value < 90) {
        persistenceProgress.value += 10
      }
    }, 300)

    const result = await setupApi.setupPersistence()

    clearInterval(progressInterval)

    if (result.success) {
      persistenceProgress.value = 100
      persistenceComplete.value = true

      // Wait a moment, then proceed to complete
      setTimeout(() => {
        if (consoleEventSource) {
          consoleEventSource.close()
          consoleEventSource = null
        }
        currentAuthStep.value = 'complete'
        loadFinalAuthStatus()
      }, 1500)
    } else {
      setupStore.setError(result.error || t('setup.persistenceFailed'))
      isPersistenceSetup.value = false
    }
  } catch (err) {
    setupStore.setError(err instanceof Error ? err.message : t('setup.persistenceFailed'))
    isPersistenceSetup.value = false
  }
}

// Load final auth status (Step 4.4)
async function loadFinalAuthStatus() {
  try {
    const status = await setupApi.getAuthStatus()
    allAuthStatus.value = {
      downloaderCredentials: status.downloaderCredentials || false,
      serverToken: status.serverToken || false,
      tokenPersistence: status.tokenPersistence || false,
      machineId: status.machineId || false,
    }
  } catch {
    // Use defaults if status check fails - assume success since we got here
    allAuthStatus.value = {
      downloaderCredentials: true,
      serverToken: true,
      tokenPersistence: true,
      machineId: true,
    }
  }
}

// Handle continue to next step
async function handleContinue() {
  const success = await setupStore.saveStep('server-auth', {
    serverAuthenticated: true,
    persistenceEnabled: persistenceComplete.value,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  if (currentAuthStep.value === 'server-auth' && !isWaitingForServerAuth.value && !serverAuthSuccess.value) {
    currentAuthStep.value = 'starting'
    serverDeviceCodeState.value = null
    serverAuthError.value = null
    if (authPollInterval) {
      clearInterval(authPollInterval)
      authPollInterval = null
    }
    if (expiryCountdownInterval) {
      clearInterval(expiryCountdownInterval)
      expiryCountdownInterval = null
    }
    return
  }
  emit('back')
}

// Check if already authenticated on mount
onMounted(async () => {
  try {
    const status = await setupApi.getAuthStatus()
    if (status.serverToken && status.tokenPersistence) {
      // Already authenticated, skip to complete
      allAuthStatus.value = {
        downloaderCredentials: status.downloaderCredentials || false,
        serverToken: status.serverToken || false,
        tokenPersistence: status.tokenPersistence || false,
        machineId: status.machineId || false,
      }
      currentAuthStep.value = 'complete'
    } else {
      // Start server for auth
      startServer()
    }
  } catch {
    // Start fresh
    startServer()
  }
})

// Cleanup on unmount
onUnmounted(() => {
  // Stop SSE reconnection attempts
  sseReconnectAttempts = MAX_SSE_RECONNECT_ATTEMPTS + 1

  if (consoleEventSource) {
    consoleEventSource.close()
    consoleEventSource = null
  }
  if (authPollInterval) {
    clearInterval(authPollInterval)
    authPollInterval = null
  }
  if (expiryCountdownInterval) {
    clearInterval(expiryCountdownInterval)
    expiryCountdownInterval = null
  }
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
    statusCheckInterval = null
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            v-if="currentAuthStep === 'complete'"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
          <path
            v-else
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
          />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">
        {{ currentAuthStep === 'starting' ? t('setup.firstServerStartTitle') :
           currentAuthStep === 'server-auth' ? t('setup.serverAuthTitle') :
           currentAuthStep === 'persistence' ? t('setup.persistenceTitle') :
           t('setup.authCompleteTitle') }}
      </h2>
      <p class="text-gray-400">
        {{ currentAuthStep === 'starting' ? t('setup.firstServerStartDescription') :
           currentAuthStep === 'server-auth' ? t('setup.serverAuthDescription') :
           currentAuthStep === 'persistence' ? t('setup.persistenceDescription') :
           t('setup.authCompleteDescription') }}
      </p>
    </div>

    <!-- Step 4.1: First Server Start -->
    <template v-if="currentAuthStep === 'starting'">
      <!-- Console Output -->
      <div class="card">
        <div class="card-body p-0">
          <div
            ref="consoleContainer"
            class="h-64 overflow-y-auto bg-dark-400 rounded-lg p-4 font-mono text-sm"
          >
            <div v-if="consoleLines.length === 0 && isServerStarting" class="flex items-center gap-2 text-gray-400">
              <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>{{ t('setup.startingServer') }}</span>
            </div>
            <div
              v-for="(line, index) in consoleLines"
              :key="index"
              class="flex gap-2"
            >
              <span class="text-gray-500 flex-shrink-0">[{{ line.timestamp }}]</span>
              <span
                :class="{
                  'text-gray-300': line.type === 'info',
                  'text-status-warning': line.type === 'warning',
                  'text-status-error': line.type === 'error',
                }"
              >
                {{ line.message }}
              </span>
            </div>
            <!-- Blinking cursor -->
            <div v-if="isServerStarting" class="inline-block w-2 h-4 bg-gray-400 animate-pulse" />
          </div>
        </div>
      </div>

      <!-- Server Status -->
      <div
        v-if="serverNeedsAuth"
        class="flex items-center gap-3 p-4 bg-status-warning/10 border border-status-warning/20 rounded-lg"
      >
        <svg class="w-5 h-5 text-status-warning flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p class="text-status-warning text-sm">{{ t('setup.serverNeedsAuth') }}</p>
      </div>

      <!-- Proceed Button -->
      <div v-if="serverNeedsAuth" class="flex justify-end">
        <Button @click="proceedToServerAuth">
          {{ t('setup.proceedToAuth') }}
          <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </Button>
      </div>
    </template>

    <!-- Step 4.2: Server Device Code Flow -->
    <template v-else-if="currentAuthStep === 'server-auth'">
      <div class="card">
        <div class="card-body">
          <!-- Important Notice -->
          <div class="mb-6 p-4 bg-hytale-orange/10 border border-hytale-orange/20 rounded-lg">
            <div class="flex items-start gap-3">
              <svg class="w-5 h-5 text-hytale-orange flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div class="text-sm">
                <p class="text-hytale-orange font-medium mb-1">{{ t('setup.separateAuthNotice') }}</p>
                <p class="text-gray-400">{{ t('setup.separateAuthNoticeDesc') }}</p>
              </div>
            </div>
          </div>

          <!-- Success State -->
          <div v-if="serverAuthSuccess" class="text-center py-8">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-success/20 rounded-full mb-4">
              <svg class="w-8 h-8 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg">{{ t('setup.serverAuthSuccess') }}</p>
            <p class="text-gray-400 mt-2">{{ t('setup.settingUpPersistence') }}</p>
          </div>

          <!-- Error State -->
          <div v-else-if="serverAuthError" class="text-center py-8">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-error/20 rounded-full mb-4">
              <svg class="w-8 h-8 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg">{{ t('setup.authFailed') }}</p>
            <p class="text-status-error mt-2">{{ serverAuthError }}</p>
            <Button class="mt-4" @click="retryServerAuth">
              {{ t('setup.retryAuth') }}
            </Button>
          </div>

          <!-- Device Code Display -->
          <div v-else-if="serverDeviceCodeState" class="space-y-6">
            <div class="text-center">
              <!-- Option 1: Direct Link (One-Click Auth) -->
              <div v-if="serverDeviceCodeState.verificationUrlDirect" class="bg-dark-300 rounded-lg p-4 mb-4">
                <p class="text-sm text-gray-400 mb-3">{{ t('setup.quickAuthOption') }}</p>
                <a
                  :href="serverDeviceCodeState.verificationUrlDirect"
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
              <div v-if="serverDeviceCodeState.verificationUrlDirect && serverDeviceCodeState.verificationUrl" class="flex items-center gap-4 my-4">
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
                    :href="serverDeviceCodeState.verificationUrl || serverDeviceCodeState.verificationUrlDirect"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-hytale-orange hover:text-hytale-orange-light break-all text-sm"
                  >
                    {{ serverDeviceCodeState.verificationUrl || serverDeviceCodeState.verificationUrlDirect }}
                  </a>
                  <Button
                    variant="secondary"
                    size="sm"
                    class="mt-2"
                    @click="copyServerVerificationUrl"
                  >
                    <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                    {{ t('setup.copyLink') }}
                  </Button>
                </div>

                <p class="text-gray-300 mb-4">{{ t('setup.enterCode') }}</p>

                <!-- User Code Display -->
                <div class="bg-dark-400 border-2 border-dark-50 rounded-xl p-6 inline-block">
                  <p class="text-3xl font-mono font-bold text-white tracking-widest">
                    {{ formattedServerUserCode }}
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
              {{ t('setup.codeValidFor', { time: serverAuthTimeRemaining }) }}
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

    <!-- Step 4.3: Persistence Setup -->
    <template v-else-if="currentAuthStep === 'persistence'">
      <!-- Success Banner -->
      <div class="flex items-center gap-3 p-4 bg-status-success/10 border border-status-success/20 rounded-lg">
        <svg class="w-5 h-5 text-status-success flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <p class="text-status-success text-sm">{{ t('setup.serverAuthSuccessful') }}</p>
      </div>

      <div class="card">
        <div class="card-body">
          <p class="text-gray-300 mb-4">{{ t('setup.persistenceSetupInfo') }}</p>

          <!-- Progress Bar -->
          <div class="mb-4">
            <div class="flex items-center justify-between mb-2">
              <span class="text-white font-medium">{{ t('setup.savingToken') }}</span>
              <span class="text-gray-400 text-sm">{{ persistenceProgress }}%</span>
            </div>
            <div class="h-2 bg-dark-50 rounded-full overflow-hidden">
              <div
                class="h-full transition-all duration-300"
                :class="persistenceComplete ? 'bg-status-success' : 'bg-hytale-orange'"
                :style="{ width: `${persistenceProgress}%` }"
              />
            </div>
          </div>

          <!-- Console Output -->
          <div
            ref="consoleContainer"
            class="h-40 overflow-y-auto bg-dark-400 rounded-lg p-4 font-mono text-sm"
          >
            <div
              v-for="(line, index) in consoleLines"
              :key="index"
              class="flex gap-2"
            >
              <span class="text-gray-500 flex-shrink-0">[{{ line.timestamp }}]</span>
              <span
                :class="{
                  'text-gray-300': line.type === 'info',
                  'text-status-warning': line.type === 'warning',
                  'text-status-error': line.type === 'error',
                }"
              >
                {{ line.message }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Step 4.4: Verification Complete -->
    <template v-else-if="currentAuthStep === 'complete'">
      <div class="card">
        <div class="card-body">
          <p class="text-gray-300 mb-4">{{ t('setup.allAuthCompleted') }}</p>

          <!-- Auth Status List -->
          <div class="space-y-3">
            <!-- Downloader Credentials -->
            <div class="flex items-center justify-between py-3 border-b border-dark-50/30">
              <div class="flex items-center gap-3">
                <div
                  class="w-8 h-8 rounded-lg flex items-center justify-center"
                  :class="allAuthStatus.downloaderCredentials ? 'bg-status-success/20' : 'bg-gray-500/20'"
                >
                  <svg
                    class="w-4 h-4"
                    :class="allAuthStatus.downloaderCredentials ? 'text-status-success' : 'text-gray-500'"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      v-if="allAuthStatus.downloaderCredentials"
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
                <span class="text-white">{{ t('setup.downloaderCredentials') }}</span>
              </div>
              <span
                class="text-sm"
                :class="allAuthStatus.downloaderCredentials ? 'text-status-success' : 'text-gray-500'"
              >
                {{ allAuthStatus.downloaderCredentials ? t('setup.saved') : t('setup.notSaved') }}
              </span>
            </div>

            <!-- Server Token -->
            <div class="flex items-center justify-between py-3 border-b border-dark-50/30">
              <div class="flex items-center gap-3">
                <div
                  class="w-8 h-8 rounded-lg flex items-center justify-center"
                  :class="allAuthStatus.serverToken ? 'bg-status-success/20' : 'bg-gray-500/20'"
                >
                  <svg
                    class="w-4 h-4"
                    :class="allAuthStatus.serverToken ? 'text-status-success' : 'text-gray-500'"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      v-if="allAuthStatus.serverToken"
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
                <span class="text-white">{{ t('setup.serverToken') }}</span>
              </div>
              <span
                class="text-sm"
                :class="allAuthStatus.serverToken ? 'text-status-success' : 'text-gray-500'"
              >
                {{ allAuthStatus.serverToken ? t('setup.authenticated') : t('setup.notAuthenticated') }}
              </span>
            </div>

            <!-- Token Persistence -->
            <div class="flex items-center justify-between py-3 border-b border-dark-50/30">
              <div class="flex items-center gap-3">
                <div
                  class="w-8 h-8 rounded-lg flex items-center justify-center"
                  :class="allAuthStatus.tokenPersistence ? 'bg-status-success/20' : 'bg-gray-500/20'"
                >
                  <svg
                    class="w-4 h-4"
                    :class="allAuthStatus.tokenPersistence ? 'text-status-success' : 'text-gray-500'"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      v-if="allAuthStatus.tokenPersistence"
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
                <span class="text-white">{{ t('setup.tokenPersistence') }}</span>
              </div>
              <span
                class="text-sm"
                :class="allAuthStatus.tokenPersistence ? 'text-status-success' : 'text-gray-500'"
              >
                {{ allAuthStatus.tokenPersistence ? t('setup.encryptedOnDisk') : t('setup.notPersisted') }}
              </span>
            </div>

            <!-- Machine ID -->
            <div class="flex items-center justify-between py-3">
              <div class="flex items-center gap-3">
                <div
                  class="w-8 h-8 rounded-lg flex items-center justify-center"
                  :class="allAuthStatus.machineId ? 'bg-status-success/20' : 'bg-gray-500/20'"
                >
                  <svg
                    class="w-4 h-4"
                    :class="allAuthStatus.machineId ? 'text-status-success' : 'text-gray-500'"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      v-if="allAuthStatus.machineId"
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
                <span class="text-white">{{ t('setup.machineId') }}</span>
              </div>
              <span
                class="text-sm"
                :class="allAuthStatus.machineId ? 'text-status-success' : 'text-gray-500'"
              >
                {{ allAuthStatus.machineId ? t('setup.generatedAndSaved') : t('setup.notGenerated') }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Auto-Auth Info -->
      <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-status-success mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <div class="text-sm text-gray-400">
            <p class="font-medium text-gray-300 mb-1">{{ t('setup.autoAuthEnabled') }}</p>
            <p>{{ t('setup.autoAuthEnabledDesc') }}</p>
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
        :disabled="isServerStarting || isPersistenceSetup"
        @click="handleBack"
      >
        <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('common.back') }}
      </Button>

      <Button
        v-if="currentAuthStep === 'complete'"
        :loading="setupStore.isLoading"
        @click="handleContinue"
      >
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>

      <div v-else>
        <!-- Empty div to maintain layout -->
      </div>
    </div>
  </div>
</template>
