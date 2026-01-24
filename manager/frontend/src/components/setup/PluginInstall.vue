<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
  back: []
}>()

// Plugin installation choice
const installPlugin = ref(true) // Default to install (recommended)

// Plugin information
const pluginInfo = {
  version: '1.1.6',
  compatibility: 'Hytale Server 2.x',
  port: 18085,
}

// Feature list for the plugin
const pluginFeatures = computed(() => [
  {
    icon: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />`,
    title: t('setup.plugin.featurePlayerList'),
    description: t('setup.plugin.featurePlayerListDesc'),
  },
  {
    icon: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />`,
    title: t('setup.plugin.featureChat'),
    description: t('setup.plugin.featureChatDesc'),
  },
  {
    icon: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />`,
    title: t('setup.plugin.featureStats'),
    description: t('setup.plugin.featureStatsDesc'),
  },
  {
    icon: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />`,
    title: t('setup.plugin.featureDeaths'),
    description: t('setup.plugin.featureDeathsDesc'),
  },
  {
    icon: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />`,
    title: t('setup.plugin.featureWebSocket'),
    description: t('setup.plugin.featureWebSocketDesc'),
  },
])

async function handleContinue() {
  const success = await setupStore.saveStep('plugin', {
    installPlugin: installPlugin.value,
    version: pluginInfo.version,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  emit('back')
}

// Load saved data on mount
onMounted(() => {
  const savedData = setupStore.setupData.plugin as Record<string, unknown> | null
  if (savedData) {
    if (typeof savedData.installPlugin === 'boolean') installPlugin.value = savedData.installPlugin
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14v6m-3-3h6M6 10h2a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2zm10 0h2a2 2 0 002-2V6a2 2 0 00-2-2h-2a2 2 0 00-2 2v2a2 2 0 002 2zM6 20h2a2 2 0 002-2v-2a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2z" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.plugin.title') }}</h2>
      <p class="text-gray-400">{{ t('setup.plugin.description') }}</p>
    </div>

    <!-- Plugin Description -->
    <div class="card">
      <div class="card-body">
        <h3 class="text-lg font-semibold text-white mb-4">{{ t('setup.plugin.featuresTitle') }}</h3>

        <div class="space-y-4">
          <div
            v-for="(feature, index) in pluginFeatures"
            :key="index"
            class="flex items-start gap-3"
          >
            <div class="flex-shrink-0 w-10 h-10 rounded-lg bg-hytale-orange/10 flex items-center justify-center">
              <svg
                class="w-5 h-5 text-hytale-orange"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                v-html="feature.icon"
              />
            </div>
            <div>
              <p class="text-white font-medium">{{ feature.title }}</p>
              <p class="text-sm text-gray-400">{{ feature.description }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Installation Choice -->
    <div class="space-y-3">
      <!-- Install Option (Recommended) -->
      <button
        @click="installPlugin = true"
        class="w-full p-4 rounded-xl border-2 transition-all duration-200 text-left"
        :class="[
          installPlugin
            ? 'border-hytale-orange bg-hytale-orange/10'
            : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
        ]"
      >
        <div class="flex items-start gap-3">
          <div
            class="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center"
            :class="installPlugin ? 'border-hytale-orange' : 'border-gray-500'"
          >
            <div
              v-if="installPlugin"
              class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
            />
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <p class="text-white font-medium">{{ t('setup.plugin.optionInstall') }}</p>
              <span class="text-xs px-2 py-0.5 rounded bg-status-success/20 text-status-success">
                {{ t('setup.recommended') }}
              </span>
            </div>
            <p class="text-sm text-gray-400 mt-1">{{ t('setup.plugin.optionInstallDesc') }}</p>
          </div>
        </div>
      </button>

      <!-- Skip Option -->
      <button
        @click="installPlugin = false"
        class="w-full p-4 rounded-xl border-2 transition-all duration-200 text-left"
        :class="[
          !installPlugin
            ? 'border-hytale-orange bg-hytale-orange/10'
            : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
        ]"
      >
        <div class="flex items-start gap-3">
          <div
            class="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center"
            :class="!installPlugin ? 'border-hytale-orange' : 'border-gray-500'"
          >
            <div
              v-if="!installPlugin"
              class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
            />
          </div>
          <div class="flex-1">
            <p class="text-white font-medium">{{ t('setup.plugin.optionSkip') }}</p>
            <p class="text-sm text-gray-400 mt-1">{{ t('setup.plugin.optionSkipDesc') }}</p>
          </div>
        </div>
      </button>
    </div>

    <!-- Plugin Version Info -->
    <div class="flex items-center justify-center gap-6 text-sm text-gray-400">
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
        <span>{{ t('setup.plugin.version') }}: {{ pluginInfo.version }}</span>
      </div>
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{{ pluginInfo.compatibility }}</span>
      </div>
    </div>

    <!-- Port Info Notice -->
    <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div class="text-sm text-gray-400">
          <p>{{ t('setup.plugin.portInfo', { port: pluginInfo.port }) }}</p>
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

      <Button :loading="setupStore.isLoading" @click="handleContinue">
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>
    </div>
  </div>
</template>
