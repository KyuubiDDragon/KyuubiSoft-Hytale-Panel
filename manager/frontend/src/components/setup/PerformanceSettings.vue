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

// System info
const detectedRam = ref(16) // Will be fetched from system check
const isLoadingSystemInfo = ref(false)

// Performance settings
const minRam = ref('3G')
const maxRam = ref('4G')
const viewRadius = ref(16)

// RAM options
const ramOptions = [
  { value: '2G', label: '2 GB' },
  { value: '3G', label: '3 GB' },
  { value: '4G', label: '4 GB' },
  { value: '6G', label: '6 GB' },
  { value: '8G', label: '8 GB' },
  { value: '12G', label: '12 GB' },
  { value: '16G', label: '16 GB' },
]

// Get numeric value from RAM string
function getRamValue(ram: string): number {
  return parseInt(ram.replace('G', ''))
}

// Computed for RAM recommendations based on player count
const ramRecommendation = computed(() => {
  const systemCheckData = setupStore.setupData.systemCheck
  const maxPlayers = 20 // Default, would be fetched from server config step

  if (maxPlayers <= 10) {
    return { min: '3G', max: '4G', message: t('setup.ramRecommendation10') }
  } else if (maxPlayers <= 20) {
    return { min: '4G', max: '6G', message: t('setup.ramRecommendation20') }
  } else if (maxPlayers <= 50) {
    return { min: '6G', max: '8G', message: t('setup.ramRecommendation50') }
  } else {
    return { min: '8G', max: '12G', message: t('setup.ramRecommendation100') }
  }
})

// Validate that min <= max
const isRamValid = computed(() => {
  return getRamValue(minRam.value) <= getRamValue(maxRam.value)
})

// View radius performance warning
const viewRadiusWarning = computed(() => {
  if (viewRadius.value > 24) {
    return t('setup.viewRadiusWarningHigh')
  } else if (viewRadius.value > 20) {
    return t('setup.viewRadiusWarningMedium')
  }
  return ''
})

// Performance impact indicator
const performanceImpact = computed(() => {
  const ram = getRamValue(maxRam.value)
  const radius = viewRadius.value

  // Simple scoring system
  let score = 0

  if (ram >= 8) score += 2
  else if (ram >= 6) score += 1

  if (radius <= 12) score += 2
  else if (radius <= 16) score += 1
  else if (radius >= 24) score -= 1

  if (score >= 3) {
    return { level: 'optimal', labelKey: 'setup.performanceOptimal', class: 'text-status-success' }
  } else if (score >= 1) {
    return { level: 'good', labelKey: 'setup.performanceGood', class: 'text-hytale-orange' }
  } else {
    return { level: 'demanding', labelKey: 'setup.performanceDemanding', class: 'text-status-warning' }
  }
})

const isFormValid = computed(() => isRamValid.value)

async function handleSubmit() {
  if (!isFormValid.value) {
    return
  }

  const success = await setupStore.saveStep('performance-settings', {
    minRam: minRam.value,
    maxRam: maxRam.value,
    viewRadius: viewRadius.value,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  emit('back')
}

// Load system info on mount
onMounted(() => {
  // Check if we have system check data with RAM info
  const systemCheck = setupStore.setupData.systemCheck
  if (systemCheck) {
    const ramCheck = systemCheck.checks.find(c => c.id === 'ram')
    if (ramCheck?.details) {
      // Try to extract RAM value from details (e.g., "16 GB available")
      const match = ramCheck.details.match(/(\d+)\s*GB/i)
      if (match) {
        detectedRam.value = parseInt(match[1])
      }
    }
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.performanceSettingsTitle') }}</h2>
      <p class="text-gray-400">{{ t('setup.performanceSettingsDescription') }}</p>
    </div>

    <!-- System Info Card -->
    <div class="p-4 bg-dark-200 rounded-lg border border-dark-50/50">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-xl bg-hytale-orange/20 flex items-center justify-center">
          <svg class="w-6 h-6 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
          </svg>
        </div>
        <div class="flex-1">
          <p class="text-sm text-gray-400">{{ t('setup.detectedSystemRam') }}</p>
          <p class="text-xl font-bold text-white">{{ detectedRam }} GB</p>
        </div>
        <div class="text-right">
          <p class="text-sm text-gray-400">{{ t('setup.performanceRating') }}</p>
          <p class="font-medium" :class="performanceImpact.class">
            {{ t(performanceImpact.labelKey) }}
          </p>
        </div>
      </div>
    </div>

    <!-- Form -->
    <form @submit.prevent="handleSubmit" class="space-y-6">
      <!-- RAM Settings -->
      <div class="card">
        <div class="card-header">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <div>
              <h3 class="font-semibold text-white">{{ t('setup.serverRam') }}</h3>
              <p class="text-sm text-gray-400">{{ t('setup.serverRamDescription') }}</p>
            </div>
          </div>
        </div>

        <div class="card-body space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <!-- Min RAM -->
            <div>
              <label class="label">{{ t('setup.minRam') }}</label>
              <div class="relative">
                <select
                  v-model="minRam"
                  class="input appearance-none cursor-pointer pr-10"
                >
                  <option
                    v-for="option in ramOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
                <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                  <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>

            <!-- Max RAM -->
            <div>
              <label class="label">{{ t('setup.maxRam') }}</label>
              <div class="relative">
                <select
                  v-model="maxRam"
                  class="input appearance-none cursor-pointer pr-10"
                >
                  <option
                    v-for="option in ramOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
                <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                  <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          <!-- RAM Error -->
          <div v-if="!isRamValid" class="p-3 bg-status-error/10 rounded-lg border border-status-error/20">
            <div class="flex items-center gap-2">
              <svg class="w-4 h-4 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p class="text-sm text-status-error">{{ t('setup.ramMinExceedsMax') }}</p>
            </div>
          </div>

          <!-- Recommendation -->
          <div class="p-3 bg-hytale-orange/10 rounded-lg border border-hytale-orange/20">
            <div class="flex items-start gap-2">
              <svg class="w-4 h-4 text-hytale-orange mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <p class="text-sm text-hytale-orange">{{ ramRecommendation.message }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- View Radius Settings -->
      <div class="card">
        <div class="card-header">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <div>
              <h3 class="font-semibold text-white">{{ t('setup.viewRadius') }}</h3>
              <p class="text-sm text-gray-400">{{ t('setup.viewRadiusDescription') }}</p>
            </div>
          </div>
        </div>

        <div class="card-body space-y-4">
          <!-- Slider -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm text-gray-400">{{ t('setup.chunks') }}</span>
              <span class="text-lg font-bold text-white">{{ viewRadius }}</span>
            </div>
            <input
              v-model="viewRadius"
              type="range"
              min="8"
              max="32"
              step="1"
              class="w-full h-2 bg-dark-50 rounded-lg appearance-none cursor-pointer slider-thumb"
            />
            <div class="flex justify-between text-xs text-gray-500 mt-1">
              <span>8</span>
              <span>16</span>
              <span>24</span>
              <span>32</span>
            </div>
          </div>

          <!-- View Radius Warning -->
          <div v-if="viewRadiusWarning" class="p-3 bg-status-warning/10 rounded-lg border border-status-warning/20">
            <div class="flex items-start gap-2">
              <svg class="w-4 h-4 text-status-warning mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p class="text-sm text-status-warning">{{ viewRadiusWarning }}</p>
            </div>
          </div>

          <!-- Info -->
          <div class="flex items-start gap-2 text-xs text-gray-500">
            <svg class="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>{{ t('setup.viewRadiusHint') }}</p>
          </div>
        </div>
      </div>

      <!-- Performance Guide -->
      <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <div class="text-sm text-gray-400">
            <p class="font-medium text-gray-300 mb-2">{{ t('setup.performanceGuideTitle') }}</p>
            <ul class="space-y-1">
              <li><span class="text-white">10-20 {{ t('setup.players') }}:</span> 4-6 GB RAM, 16 {{ t('setup.chunks') }}</li>
              <li><span class="text-white">20-50 {{ t('setup.players') }}:</span> 6-8 GB RAM, 12-16 {{ t('setup.chunks') }}</li>
              <li><span class="text-white">50+ {{ t('setup.players') }}:</span> 8+ GB RAM, 10-12 {{ t('setup.chunks') }}</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Error Message -->
      <div v-if="setupStore.error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
        <p class="text-status-error text-sm">{{ setupStore.error }}</p>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-between pt-4">
        <Button type="button" variant="secondary" @click="handleBack">
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          {{ t('common.back') }}
        </Button>

        <Button
          type="submit"
          :loading="setupStore.isLoading"
          :disabled="!isFormValid"
        >
          {{ t('common.next') }}
          <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </Button>
      </div>
    </form>
  </div>
</template>

<style scoped>
/* Custom slider styling */
.slider-thumb::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #f97316;
  cursor: pointer;
  border: 2px solid #fff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.slider-thumb::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #f97316;
  cursor: pointer;
  border: 2px solid #fff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}
</style>
