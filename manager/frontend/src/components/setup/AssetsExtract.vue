<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'
import { subscribeToExtractionProgress, setupApi, type ProgressEvent } from '@/api/setup'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
  back: []
}>()

// Extraction option selection
type ExtractionOption = 'extract' | 'skip'
const extractionOption = ref<ExtractionOption>('extract')

// Current step within the extraction flow
type ExtractionStep = 'select' | 'extracting' | 'complete'
const currentExtractionStep = ref<ExtractionStep>('select')

// Extraction progress state
const isExtracting = ref(false)
const extractionProgress = ref({
  percent: 0,
  filesTotal: 0,
  filesDone: 0,
  bytesTotal: 0,
  bytesDone: 0,
  currentFile: '',
  estimatedSeconds: 0,
})

// Extraction complete state
const extractionComplete = ref(false)
const extractionSkipped = ref(false)

// SSE cleanup function
let cleanupSSE: (() => void) | null = null

// Features enabled by extraction
const extractionFeatures = computed(() => [
  {
    icon: 'image',
    title: t('setup.featureItemImages'),
    description: t('setup.featureItemImagesDesc'),
  },
  {
    icon: 'map',
    title: t('setup.featurePrefabPreviews'),
    description: t('setup.featurePrefabPreviewsDesc'),
  },
  {
    icon: 'grid',
    title: t('setup.featureAssetBrowser'),
    description: t('setup.featureAssetBrowserDesc'),
  },
  {
    icon: 'palette',
    title: t('setup.featureTexturePreviews'),
    description: t('setup.featureTexturePreviewsDesc'),
  },
])

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

// Format number with thousands separator
function formatNumber(num: number): string {
  return num.toLocaleString()
}

// Handle option selection
function selectOption(option: ExtractionOption) {
  extractionOption.value = option
}

// Proceed from option selection
async function proceedFromSelect() {
  if (extractionOption.value === 'skip') {
    extractionSkipped.value = true
    currentExtractionStep.value = 'complete'
    return
  }

  currentExtractionStep.value = 'extracting'
  await startExtraction()
}

// Start extraction process
async function startExtraction() {
  isExtracting.value = true

  // Subscribe to SSE progress updates
  cleanupSSE = subscribeToExtractionProgress(
    handleExtractionProgress,
    handleExtractionComplete,
    handleExtractionError
  )

  try {
    // Trigger the extraction on the backend
    await setupApi.startAssetExtraction()
  } catch (err) {
    handleExtractionError(err instanceof Error ? err.message : t('setup.extractionStartFailed'))
  }
}

// Handle extraction progress events
function handleExtractionProgress(event: ProgressEvent) {
  extractionProgress.value = {
    percent: event.percent || 0,
    filesTotal: event.filesTotal || 0,
    filesDone: event.filesDone || 0,
    bytesTotal: event.bytesTotal || 0,
    bytesDone: event.bytesDone || 0,
    currentFile: event.currentFile || '',
    estimatedSeconds: event.estimatedSeconds || 0,
  }
}

// Handle extraction complete
function handleExtractionComplete() {
  isExtracting.value = false
  extractionComplete.value = true
  if (cleanupSSE) {
    cleanupSSE()
    cleanupSSE = null
  }
  currentExtractionStep.value = 'complete'
}

// Handle extraction error
function handleExtractionError(error: string) {
  isExtracting.value = false
  setupStore.setError(error)
  if (cleanupSSE) {
    cleanupSSE()
    cleanupSSE = null
  }
}

// Handle continue to next step
async function handleContinue() {
  // Save extraction settings
  const success = await setupStore.saveStep('assets-extract', {
    extracted: extractionOption.value === 'extract' && extractionComplete.value,
    skipped: extractionSkipped.value,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  if (currentExtractionStep.value !== 'select' && !isExtracting.value) {
    currentExtractionStep.value = 'select'
    extractionComplete.value = false
    extractionSkipped.value = false
    extractionProgress.value = {
      percent: 0,
      filesTotal: 0,
      filesDone: 0,
      bytesTotal: 0,
      bytesDone: 0,
      currentFile: '',
      estimatedSeconds: 0,
    }
    return
  }
  emit('back')
}

// Cleanup on unmount
onUnmounted(() => {
  if (cleanupSSE) {
    cleanupSSE()
  }
})

// Get icon SVG path based on icon name
function getIconPath(icon: string): string {
  switch (icon) {
    case 'image':
      return 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z'
    case 'map':
      return 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7'
    case 'grid':
      return 'M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z'
    case 'palette':
      return 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01'
    default:
      return ''
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">
        {{ currentExtractionStep === 'extracting' ? t('setup.extractingAssetsTitle') :
           currentExtractionStep === 'complete' ? t('setup.extractionCompleteTitle') :
           t('setup.extractAssetsTitle') }}
      </h2>
      <p class="text-gray-400">
        {{ currentExtractionStep === 'extracting' ? t('setup.extractingAssetsDescription') :
           currentExtractionStep === 'complete' ? (extractionSkipped ? t('setup.extractionSkippedDescription') : t('setup.extractionCompleteDescription')) :
           t('setup.extractAssetsDescription') }}
      </p>
    </div>

    <!-- Step 3.5: Extraction Option Selection -->
    <template v-if="currentExtractionStep === 'select'">
      <div class="space-y-4">
        <!-- Extract Option -->
        <button
          @click="selectOption('extract')"
          class="w-full p-5 rounded-xl border-2 text-left transition-all duration-200"
          :class="[
            extractionOption === 'extract'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
          ]"
        >
          <div class="flex items-start gap-4">
            <div class="flex-shrink-0 mt-1">
              <div
                class="w-5 h-5 rounded-full border-2 flex items-center justify-center"
                :class="extractionOption === 'extract' ? 'border-hytale-orange' : 'border-gray-500'"
              >
                <div
                  v-if="extractionOption === 'extract'"
                  class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
                />
              </div>
            </div>
            <div class="flex-1">
              <p class="text-white font-semibold mb-1">{{ t('setup.extractAssetsOption') }}</p>
              <p class="text-sm text-gray-400 mb-3">{{ t('setup.extractAssetsOptionDesc') }}</p>

              <!-- Feature List -->
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                <div
                  v-for="feature in extractionFeatures"
                  :key="feature.title"
                  class="flex items-start gap-2"
                >
                  <svg
                    class="w-5 h-5 text-hytale-orange flex-shrink-0 mt-0.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      :d="getIconPath(feature.icon)"
                    />
                  </svg>
                  <div>
                    <p class="text-sm text-gray-300">{{ feature.title }}</p>
                  </div>
                </div>
              </div>

              <!-- Storage Warning -->
              <div class="mt-4 flex items-center gap-2 text-sm text-status-warning">
                <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span>{{ t('setup.extractStorageWarning') }}</span>
              </div>
            </div>
          </div>
        </button>

        <!-- Skip Option -->
        <button
          @click="selectOption('skip')"
          class="w-full p-5 rounded-xl border-2 text-left transition-all duration-200"
          :class="[
            extractionOption === 'skip'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
          ]"
        >
          <div class="flex items-start gap-4">
            <div class="flex-shrink-0 mt-1">
              <div
                class="w-5 h-5 rounded-full border-2 flex items-center justify-center"
                :class="extractionOption === 'skip' ? 'border-hytale-orange' : 'border-gray-500'"
              >
                <div
                  v-if="extractionOption === 'skip'"
                  class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
                />
              </div>
            </div>
            <div class="flex-1">
              <p class="text-white font-semibold mb-1">{{ t('setup.skipExtractionOption') }}</p>
              <p class="text-sm text-gray-400">{{ t('setup.skipExtractionOptionDesc') }}</p>
            </div>
          </div>
        </button>
      </div>
    </template>

    <!-- Step 3.6: Extraction Progress (Simplified - no detailed progress info available) -->
    <template v-else-if="currentExtractionStep === 'extracting'">
      <div class="card">
        <div class="card-body">
          <!-- Simple extraction status -->
          <div class="text-center py-8">
            <!-- Animated extraction icon -->
            <div class="inline-flex items-center justify-center w-20 h-20 bg-hytale-orange/20 rounded-2xl mb-6">
              <svg class="w-10 h-10 text-hytale-orange animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
            </div>

            <h3 class="text-xl font-semibold text-white mb-2">{{ t('setup.extractingAssetsTitle') }}</h3>
            <p class="text-gray-400 mb-6">{{ t('setup.extractingAssetsDescription') }}</p>

            <!-- Simple animated progress bar -->
            <div class="max-w-md mx-auto">
              <div class="h-2 bg-dark-50 rounded-full overflow-hidden">
                <div class="h-full bg-gradient-to-r from-hytale-orange to-hytale-yellow animate-extraction-progress" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Info Notice -->
      <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-sm text-gray-400">{{ t('setup.extractionInfoNotice') }}</p>
        </div>
      </div>
    </template>

    <!-- Extraction Complete -->
    <template v-else-if="currentExtractionStep === 'complete'">
      <div class="card">
        <div class="card-body">
          <!-- Success State -->
          <div v-if="!extractionSkipped" class="text-center py-4">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-success/20 rounded-full mb-4">
              <svg class="w-8 h-8 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg mb-2">{{ t('setup.extractionSuccess') }}</p>
            <p class="text-gray-400">{{ t('setup.extractionSuccessDesc') }}</p>
          </div>

          <!-- Skipped State -->
          <div v-else class="text-center py-4">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-warning/20 rounded-full mb-4">
              <svg class="w-8 h-8 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg mb-2">{{ t('setup.extractionSkipped') }}</p>
            <p class="text-gray-400">{{ t('setup.extractionSkippedInfo') }}</p>
          </div>

          <!-- Enabled Features (if extracted) -->
          <div v-if="!extractionSkipped" class="mt-6 pt-6 border-t border-dark-50/30">
            <p class="text-sm text-gray-400 mb-3">{{ t('setup.enabledFeatures') }}</p>
            <div class="grid grid-cols-2 gap-3">
              <div
                v-for="feature in extractionFeatures"
                :key="feature.title"
                class="flex items-center gap-2 p-2 bg-dark-300 rounded-lg"
              >
                <svg class="w-4 h-4 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
                <span class="text-sm text-gray-300">{{ feature.title }}</span>
              </div>
            </div>
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
        :disabled="isExtracting"
        @click="handleBack"
      >
        <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('common.back') }}
      </Button>

      <Button
        v-if="currentExtractionStep === 'select'"
        @click="proceedFromSelect"
      >
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>

      <Button
        v-else-if="currentExtractionStep === 'complete'"
        :loading="setupStore.isLoading"
        @click="handleContinue"
      >
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>

      <div v-else>
        <!-- Empty div to maintain layout during extraction -->
      </div>
    </div>
  </div>
</template>
