<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
  back: []
}>()

// Access mode types
type AccessMode = 'localhost' | 'lan' | 'custom'

// Form state
const accessMode = ref<AccessMode>('localhost')
const customDomain = ref('')
const trustProxy = ref(false)
const detectedIp = ref<string | null>(null)
const isDetectingIp = ref(false)

// Computed panel URL based on access mode
const panelUrl = computed(() => {
  switch (accessMode.value) {
    case 'localhost':
      return 'http://localhost:18080'
    case 'lan':
      return detectedIp.value ? `http://${detectedIp.value}:18080` : 'http://[detecting...]:18080'
    case 'custom':
      return customDomain.value || 'https://your-domain.com'
    default:
      return 'http://localhost:18080'
  }
})

// Validation
const customDomainError = computed(() => {
  if (accessMode.value !== 'custom') return ''
  if (!customDomain.value) return t('setup.network.domainRequired')

  // Basic URL validation
  try {
    const url = new URL(customDomain.value)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return t('setup.network.invalidProtocol')
    }
    return ''
  } catch {
    return t('setup.network.invalidUrl')
  }
})

const canProceed = computed(() => {
  if (accessMode.value === 'custom') {
    return !customDomainError.value && customDomain.value.length > 0
  }
  return true
})

// Auto-detect local IP
async function detectLocalIp() {
  isDetectingIp.value = true
  try {
    // In a real implementation, this would call the backend API
    // For now, simulate detection
    const response = await fetch('/api/setup/detect-ip')
    if (response.ok) {
      const data = await response.json()
      detectedIp.value = data.ip
    } else {
      // Fallback - try to detect via WebRTC or use a default
      detectedIp.value = '192.168.1.100'
    }
  } catch {
    // Fallback to a common private IP format
    detectedIp.value = '192.168.1.100'
  } finally {
    isDetectingIp.value = false
  }
}

async function handleContinue() {
  if (!canProceed.value) return

  let corsOrigins: string[] = []

  switch (accessMode.value) {
    case 'localhost':
      corsOrigins = ['http://localhost:18080']
      break
    case 'lan':
      corsOrigins = [
        'http://localhost:18080',
        detectedIp.value ? `http://${detectedIp.value}:18080` : '',
      ].filter(Boolean)
      break
    case 'custom':
      corsOrigins = [customDomain.value]
      break
  }

  const success = await setupStore.saveStep('network', {
    accessMode: accessMode.value,
    customDomain: accessMode.value === 'custom' ? customDomain.value : null,
    trustProxy: trustProxy.value,
    detectedIp: detectedIp.value,
    corsOrigins,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  emit('back')
}

onMounted(() => {
  detectLocalIp()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.network.title') }}</h2>
      <p class="text-gray-400">{{ t('setup.network.description') }}</p>
    </div>

    <!-- Access Mode Selection -->
    <div class="space-y-3">
      <!-- Localhost Option (Default, Most Secure) -->
      <button
        @click="accessMode = 'localhost'"
        class="w-full p-4 rounded-xl border-2 transition-all duration-200 text-left"
        :class="[
          accessMode === 'localhost'
            ? 'border-hytale-orange bg-hytale-orange/10'
            : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
        ]"
      >
        <div class="flex items-start gap-3">
          <div
            class="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center"
            :class="accessMode === 'localhost' ? 'border-hytale-orange' : 'border-gray-500'"
          >
            <div
              v-if="accessMode === 'localhost'"
              class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
            />
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <p class="text-white font-medium">{{ t('setup.network.localhost.title') }}</p>
              <span class="text-xs px-2 py-0.5 rounded bg-status-success/20 text-status-success">
                {{ t('setup.network.mostSecure') }}
              </span>
            </div>
            <p class="text-sm text-gray-400 mt-1">{{ t('setup.network.localhost.description') }}</p>
            <div class="mt-2 flex items-center gap-2 text-sm text-gray-500">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <span>http://localhost:18080</span>
            </div>
          </div>
        </div>
      </button>

      <!-- LAN Option -->
      <button
        @click="accessMode = 'lan'"
        class="w-full p-4 rounded-xl border-2 transition-all duration-200 text-left"
        :class="[
          accessMode === 'lan'
            ? 'border-hytale-orange bg-hytale-orange/10'
            : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
        ]"
      >
        <div class="flex items-start gap-3">
          <div
            class="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center"
            :class="accessMode === 'lan' ? 'border-hytale-orange' : 'border-gray-500'"
          >
            <div
              v-if="accessMode === 'lan'"
              class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
            />
          </div>
          <div class="flex-1">
            <p class="text-white font-medium">{{ t('setup.network.lan.title') }}</p>
            <p class="text-sm text-gray-400 mt-1">{{ t('setup.network.lan.description') }}</p>
            <div class="mt-2 flex items-center gap-2 text-sm">
              <svg class="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <span v-if="isDetectingIp" class="text-gray-500">
                <svg class="animate-spin h-4 w-4 inline mr-1" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {{ t('setup.network.detectingIp') }}
              </span>
              <span v-else class="text-gray-300">
                {{ t('setup.network.detectedIp') }}: {{ detectedIp || 'N/A' }}
              </span>
            </div>
          </div>
        </div>
      </button>

      <!-- Custom Domain Option -->
      <div
        class="p-4 rounded-xl border-2 transition-all duration-200"
        :class="[
          accessMode === 'custom'
            ? 'border-hytale-orange bg-hytale-orange/10'
            : 'border-dark-50 bg-dark-200'
        ]"
      >
        <button
          @click="accessMode = 'custom'"
          class="w-full text-left"
        >
          <div class="flex items-start gap-3">
            <div
              class="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center"
              :class="accessMode === 'custom' ? 'border-hytale-orange' : 'border-gray-500'"
            >
              <div
                v-if="accessMode === 'custom'"
                class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
              />
            </div>
            <div class="flex-1">
              <p class="text-white font-medium">{{ t('setup.network.custom.title') }}</p>
              <p class="text-sm text-gray-400 mt-1">{{ t('setup.network.custom.description') }}</p>
            </div>
          </div>
        </button>

        <!-- Custom Domain Input -->
        <div v-if="accessMode === 'custom'" class="mt-4 ml-8">
          <label class="label">{{ t('setup.network.custom.domainLabel') }}</label>
          <Input
            v-model="customDomain"
            type="text"
            placeholder="https://panel.yourserver.com"
            :error="customDomainError"
          />
          <p class="mt-1 text-xs text-gray-500">{{ t('setup.network.custom.hint') }}</p>

          <!-- Trust Proxy Toggle -->
          <div class="mt-4 flex items-center justify-between p-3 bg-dark-300 rounded-lg">
            <div>
              <p class="text-sm text-white font-medium">{{ t('setup.network.trustProxy.title') }}</p>
              <p class="text-xs text-gray-400 mt-0.5">{{ t('setup.network.trustProxy.description') }}</p>
            </div>
            <button
              type="button"
              @click="trustProxy = !trustProxy"
              class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-hytale-orange focus:ring-offset-2 focus:ring-offset-dark-200"
              :class="trustProxy ? 'bg-hytale-orange' : 'bg-dark-50'"
              role="switch"
              :aria-checked="trustProxy"
            >
              <span
                class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
                :class="trustProxy ? 'translate-x-5' : 'translate-x-0'"
              />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- CORS Explanation -->
    <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-hytale-orange mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div class="text-sm">
          <p class="font-medium text-gray-300 mb-1">{{ t('setup.network.corsTitle') }}</p>
          <p class="text-gray-400">{{ t('setup.network.corsExplanation') }}</p>
        </div>
      </div>
    </div>

    <!-- Preview -->
    <div class="card">
      <div class="card-body py-3">
        <div class="flex items-center justify-between">
          <span class="text-sm text-gray-400">{{ t('setup.network.panelUrl') }}</span>
          <span class="text-sm text-white font-mono">{{ panelUrl }}</span>
        </div>
      </div>
    </div>

    <!-- Error Message -->
    <div v-if="setupStore.error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error text-sm">{{ setupStore.error }}</p>
    </div>

    <!-- Actions -->
    <div class="flex items-center justify-between pt-4">
      <Button variant="secondary" @click="handleBack">
        <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('common.back') }}
      </Button>

      <Button :loading="setupStore.isLoading" :disabled="!canProceed" @click="handleContinue">
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>
    </div>
  </div>
</template>
