<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()
const router = useRouter()
const setupStore = useSetupStore()

const emit = defineEmits<{
  back: []
  goToStep: [step: number]
}>()

// Setup completion state
const isCompleting = ref(false)
const isComplete = ref(false)
const completionError = ref<string | null>(null)

// Final URLs after setup
const finalPanelUrl = ref('')
const finalServerAddress = ref('')

// Computed configuration summary from setup data
const configSummary = computed(() => {
  const data = setupStore.setupData
  return {
    admin: {
      username: data.admin?.username || 'admin',
    },
    language: data.language?.language || 'en',
    plugin: {
      installed: true, // This would come from stored data
      version: '1.1.6',
    },
    integrations: {
      modtale: false,
      stackmart: false,
      webmap: false,
    },
    network: {
      accessMode: 'localhost',
      panelUrl: 'http://localhost:18080',
      serverAddress: 'localhost:5520',
    },
  }
})

// Edit sections map to step indices
const sectionStepMap: Record<string, number> = {
  language: 1,
  admin: 2,
  plugin: 6,
  integrations: 7,
  network: 8,
}

function handleEdit(section: string) {
  const step = sectionStepMap[section]
  if (step !== undefined) {
    emit('goToStep', step)
  }
}

function handleBack() {
  emit('back')
}

async function handleComplete() {
  isCompleting.value = true
  completionError.value = null

  try {
    const redirectUrl = await setupStore.completeSetup()

    if (redirectUrl) {
      isComplete.value = true
      // Set final URLs based on network config
      finalPanelUrl.value = configSummary.value.network.panelUrl
      finalServerAddress.value = configSummary.value.network.serverAddress
    } else {
      completionError.value = setupStore.error || t('setup.summary.completionFailed')
    }
  } catch (error) {
    completionError.value = error instanceof Error ? error.message : t('setup.summary.completionFailed')
  } finally {
    isCompleting.value = false
  }
}

function handleGoToDashboard() {
  router.push('/login')
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
}
</script>

<template>
  <div class="space-y-6">
    <!-- Success Screen -->
    <template v-if="isComplete">
      <!-- Header -->
      <div class="text-center">
        <div class="inline-flex items-center justify-center w-20 h-20 bg-status-success/20 rounded-full mb-4">
          <svg class="w-10 h-10 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.summary.successTitle') }}</h2>
        <p class="text-gray-400">{{ t('setup.summary.successDescription') }}</p>
      </div>

      <!-- Server Ready Banner -->
      <div class="card bg-gradient-to-r from-hytale-orange/20 to-hytale-orange/5 border-hytale-orange/30">
        <div class="card-body text-center py-8">
          <svg class="w-16 h-16 text-hytale-orange mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h3 class="text-xl font-bold text-white">{{ t('setup.summary.serverReady') }}</h3>
        </div>
      </div>

      <!-- Important Information -->
      <div class="space-y-4">
        <!-- Panel Access -->
        <div class="card">
          <div class="card-body">
            <h4 class="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
              {{ t('setup.summary.panelAccess') }}
            </h4>
            <div class="flex items-center justify-between p-3 bg-dark-300 rounded-lg">
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <span class="text-white font-mono">{{ finalPanelUrl }}</span>
              </div>
              <button
                @click="copyToClipboard(finalPanelUrl)"
                class="p-2 text-gray-400 hover:text-white transition-colors"
                :title="t('common.copy')"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
            <p class="text-sm text-gray-500 mt-2">
              {{ t('setup.summary.loginWith') }}: <span class="text-gray-300">{{ configSummary.admin.username }}</span>
            </p>
          </div>
        </div>

        <!-- Server Address for Players -->
        <div class="card">
          <div class="card-body">
            <h4 class="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
              {{ t('setup.summary.serverAddress') }}
            </h4>
            <div class="flex items-center justify-between p-3 bg-dark-300 rounded-lg">
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                </svg>
                <span class="text-white font-mono">{{ finalServerAddress }}</span>
              </div>
              <button
                @click="copyToClipboard(finalServerAddress)"
                class="p-2 text-gray-400 hover:text-white transition-colors"
                :title="t('common.copy')"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
            <p class="text-sm text-gray-500 mt-2">{{ t('setup.summary.shareWithPlayers') }}</p>
          </div>
        </div>
      </div>

      <!-- Tips -->
      <div class="p-4 bg-hytale-orange/10 border border-hytale-orange/20 rounded-lg">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-hytale-orange mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <div>
            <p class="font-medium text-hytale-orange mb-2">{{ t('setup.summary.nextStepsTitle') }}</p>
            <ul class="text-sm text-gray-400 space-y-1.5">
              <li class="flex items-start gap-2">
                <svg class="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
                {{ t('setup.summary.tipWhitelist') }}
              </li>
              <li class="flex items-start gap-2">
                <svg class="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
                {{ t('setup.summary.tipBackup') }}
              </li>
              <li class="flex items-start gap-2">
                <svg class="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
                {{ t('setup.summary.tipSettings') }}
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Go to Dashboard Button -->
      <div class="flex justify-center pt-4">
        <Button size="lg" @click="handleGoToDashboard">
          {{ t('setup.summary.goToDashboard') }}
          <svg class="w-5 h-5 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </Button>
      </div>
    </template>

    <!-- Summary Screen (before completion) -->
    <template v-else>
      <!-- Header -->
      <div class="text-center">
        <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
          <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
        </div>
        <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.summary.title') }}</h2>
        <p class="text-gray-400">{{ t('setup.summary.description') }}</p>
      </div>

      <!-- Configuration Summary -->
      <div class="space-y-4">
        <!-- Admin Account Section -->
        <div class="card">
          <div class="card-body">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <svg class="w-5 h-5 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <h3 class="text-white font-semibold">{{ t('setup.summary.adminAccount') }}</h3>
              </div>
              <button
                @click="handleEdit('admin')"
                class="text-sm text-hytale-orange hover:text-hytale-orange-light transition-colors"
              >
                {{ t('common.edit') }}
              </button>
            </div>
            <div class="text-sm text-gray-400">
              <div class="flex justify-between py-1">
                <span>{{ t('setup.summary.username') }}</span>
                <span class="text-gray-200">{{ configSummary.admin.username }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Plugin Section -->
        <div class="card">
          <div class="card-body">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <svg class="w-5 h-5 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14v6m-3-3h6M6 10h2a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2zm10 0h2a2 2 0 002-2V6a2 2 0 00-2-2h-2a2 2 0 00-2 2v2a2 2 0 002 2zM6 20h2a2 2 0 002-2v-2a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2z" />
                </svg>
                <h3 class="text-white font-semibold">{{ t('setup.summary.plugin') }}</h3>
              </div>
              <button
                @click="handleEdit('plugin')"
                class="text-sm text-hytale-orange hover:text-hytale-orange-light transition-colors"
              >
                {{ t('common.edit') }}
              </button>
            </div>
            <div class="text-sm text-gray-400">
              <div class="flex justify-between py-1">
                <span>{{ t('setup.summary.kyuubiApi') }}</span>
                <span class="flex items-center gap-2">
                  <span v-if="configSummary.plugin.installed" class="text-status-success flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                    </svg>
                    {{ t('setup.summary.installed') }} (v{{ configSummary.plugin.version }})
                  </span>
                  <span v-else class="text-gray-500">{{ t('setup.summary.notInstalled') }}</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Integrations Section -->
        <div class="card">
          <div class="card-body">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <svg class="w-5 h-5 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <h3 class="text-white font-semibold">{{ t('setup.summary.integrations') }}</h3>
              </div>
              <button
                @click="handleEdit('integrations')"
                class="text-sm text-hytale-orange hover:text-hytale-orange-light transition-colors"
              >
                {{ t('common.edit') }}
              </button>
            </div>
            <div class="text-sm text-gray-400 space-y-1">
              <div class="flex justify-between py-1">
                <span>Modtale</span>
                <span :class="configSummary.integrations.modtale ? 'text-status-success' : 'text-gray-500'">
                  {{ configSummary.integrations.modtale ? t('setup.summary.configured') : t('setup.summary.notConfigured') }}
                </span>
              </div>
              <div class="flex justify-between py-1">
                <span>StackMart</span>
                <span :class="configSummary.integrations.stackmart ? 'text-status-success' : 'text-gray-500'">
                  {{ configSummary.integrations.stackmart ? t('setup.summary.configured') : t('setup.summary.notConfigured') }}
                </span>
              </div>
              <div class="flex justify-between py-1">
                <span>WebMap</span>
                <span :class="configSummary.integrations.webmap ? 'text-status-success' : 'text-gray-500'">
                  {{ configSummary.integrations.webmap ? t('setup.summary.enabled') : t('setup.summary.disabled') }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Network Section -->
        <div class="card">
          <div class="card-body">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <svg class="w-5 h-5 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                <h3 class="text-white font-semibold">{{ t('setup.summary.network') }}</h3>
              </div>
              <button
                @click="handleEdit('network')"
                class="text-sm text-hytale-orange hover:text-hytale-orange-light transition-colors"
              >
                {{ t('common.edit') }}
              </button>
            </div>
            <div class="text-sm text-gray-400 space-y-1">
              <div class="flex justify-between py-1">
                <span>{{ t('setup.summary.accessMode') }}</span>
                <span class="text-gray-200 capitalize">{{ configSummary.network.accessMode }}</span>
              </div>
              <div class="flex justify-between py-1">
                <span>{{ t('setup.summary.panelUrlLabel') }}</span>
                <span class="text-gray-200 font-mono text-xs">{{ configSummary.network.panelUrl }}</span>
              </div>
              <div class="flex justify-between py-1">
                <span>{{ t('setup.summary.serverAddressLabel') }}</span>
                <span class="text-gray-200 font-mono text-xs">{{ configSummary.network.serverAddress }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Error Message -->
      <div v-if="completionError || setupStore.error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
        <p class="text-status-error text-sm">{{ completionError || setupStore.error }}</p>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-between pt-4">
        <Button variant="secondary" @click="handleBack">
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          {{ t('common.back') }}
        </Button>

        <Button :loading="isCompleting" @click="handleComplete">
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          {{ t('setup.summary.completeSetup') }}
        </Button>
      </div>
    </template>
  </div>
</template>
