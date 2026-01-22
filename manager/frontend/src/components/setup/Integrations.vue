<script setup lang="ts">
import { ref } from 'vue'
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

// Form state
const modtaleApiKey = ref('')
const stackmartApiKey = ref('')
const webmapEnabled = ref(false)

// Visibility toggles for API keys
const showModtaleKey = ref(false)
const showStackmartKey = ref(false)

// WebMap port information
const webmapPorts = {
  http: 18081,
  websocket: 18082,
}

async function handleContinue() {
  const success = await setupStore.saveStep('integrations', {
    modtaleApiKey: modtaleApiKey.value || null,
    stackmartApiKey: stackmartApiKey.value || null,
    webmapEnabled: webmapEnabled.value,
  })

  if (success) {
    emit('complete')
  }
}

async function handleSkip() {
  // Save with empty/default values
  const success = await setupStore.saveStep('integrations', {
    modtaleApiKey: null,
    stackmartApiKey: null,
    webmapEnabled: false,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  emit('back')
}
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.integrations.title') }}</h2>
      <p class="text-gray-400">{{ t('setup.integrations.description') }}</p>
    </div>

    <!-- Info Banner -->
    <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p class="text-sm text-gray-400">{{ t('setup.integrations.configLaterInfo') }}</p>
      </div>
    </div>

    <!-- Integrations Form -->
    <div class="space-y-6">
      <!-- Modtale Integration -->
      <div class="card">
        <div class="card-body">
          <div class="flex items-start gap-4 mb-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center">
              <svg class="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
            </div>
            <div class="flex-1">
              <h3 class="text-lg font-semibold text-white">{{ t('setup.integrations.modtale.title') }}</h3>
              <p class="text-sm text-gray-400 mt-1">{{ t('setup.integrations.modtale.description') }}</p>
            </div>
          </div>

          <div>
            <label class="label">{{ t('setup.integrations.modtale.apiKey') }}</label>
            <div class="relative">
              <Input
                v-model="modtaleApiKey"
                :type="showModtaleKey ? 'text' : 'password'"
                :placeholder="t('setup.integrations.modtale.apiKeyPlaceholder')"
              />
              <button
                type="button"
                @click="showModtaleKey = !showModtaleKey"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
              >
                <svg v-if="showModtaleKey" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </button>
            </div>
            <p class="mt-1 text-xs text-gray-500">{{ t('setup.integrations.modtale.hint') }}</p>
          </div>
        </div>
      </div>

      <!-- StackMart Integration -->
      <div class="card">
        <div class="card-body">
          <div class="flex items-start gap-4 mb-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-xl bg-blue-500/20 flex items-center justify-center">
              <svg class="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <div class="flex-1">
              <h3 class="text-lg font-semibold text-white">{{ t('setup.integrations.stackmart.title') }}</h3>
              <p class="text-sm text-gray-400 mt-1">{{ t('setup.integrations.stackmart.description') }}</p>
            </div>
          </div>

          <div>
            <label class="label">{{ t('setup.integrations.stackmart.apiKey') }}</label>
            <div class="relative">
              <Input
                v-model="stackmartApiKey"
                :type="showStackmartKey ? 'text' : 'password'"
                :placeholder="t('setup.integrations.stackmart.apiKeyPlaceholder')"
              />
              <button
                type="button"
                @click="showStackmartKey = !showStackmartKey"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
              >
                <svg v-if="showStackmartKey" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </button>
            </div>
            <p class="mt-1 text-xs text-gray-500">{{ t('setup.integrations.stackmart.hint') }}</p>
          </div>
        </div>
      </div>

      <!-- WebMap Integration -->
      <div class="card">
        <div class="card-body">
          <div class="flex items-start gap-4">
            <div class="flex-shrink-0 w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center">
              <svg class="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
              </svg>
            </div>
            <div class="flex-1">
              <div class="flex items-center justify-between">
                <div>
                  <h3 class="text-lg font-semibold text-white">{{ t('setup.integrations.webmap.title') }}</h3>
                  <p class="text-sm text-gray-400 mt-1">{{ t('setup.integrations.webmap.description') }}</p>
                </div>
                <!-- Toggle -->
                <button
                  type="button"
                  @click="webmapEnabled = !webmapEnabled"
                  class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-hytale-orange focus:ring-offset-2 focus:ring-offset-dark-200"
                  :class="webmapEnabled ? 'bg-hytale-orange' : 'bg-dark-50'"
                  role="switch"
                  :aria-checked="webmapEnabled"
                >
                  <span
                    class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
                    :class="webmapEnabled ? 'translate-x-5' : 'translate-x-0'"
                  />
                </button>
              </div>

              <!-- Port Requirements -->
              <div v-if="webmapEnabled" class="mt-4 p-3 bg-dark-300 rounded-lg">
                <p class="text-sm text-gray-400 mb-2">{{ t('setup.integrations.webmap.portRequirements') }}</p>
                <div class="flex gap-4 text-sm">
                  <div class="flex items-center gap-2 text-gray-300">
                    <svg class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                    </svg>
                    <span>HTTP: {{ webmapPorts.http }}</span>
                  </div>
                  <div class="flex items-center gap-2 text-gray-300">
                    <svg class="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span>WebSocket: {{ webmapPorts.websocket }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
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

      <div class="flex items-center gap-3">
        <Button variant="secondary" @click="handleSkip">
          {{ t('common.skip') }}
        </Button>
        <Button :loading="setupStore.isLoading" @click="handleContinue">
          {{ t('common.next') }}
          <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </Button>
      </div>
    </div>
  </div>
</template>
