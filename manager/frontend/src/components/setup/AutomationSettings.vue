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

// Backup settings
const backupEnabled = ref(true)
const backupInterval = ref('6h')
const backupRetention = ref(7)

// Auto-restart settings
const restartEnabled = ref(true)
const restartSchedule = ref('daily-4')
const warnBeforeRestart = ref(true)

// Options for dropdowns
const backupIntervalOptions = [
  { value: '1h', labelKey: 'setup.backupHourly' },
  { value: '6h', labelKey: 'setup.backupEvery6Hours' },
  { value: '12h', labelKey: 'setup.backupEvery12Hours' },
  { value: '24h', labelKey: 'setup.backupDaily' },
]

const backupRetentionOptions = [
  { value: 3, labelKey: 'setup.keepLast3' },
  { value: 7, labelKey: 'setup.keepLast7' },
  { value: 14, labelKey: 'setup.keepLast14' },
  { value: 30, labelKey: 'setup.keepLast30' },
]

const restartScheduleOptions = [
  { value: 'daily-4', labelKey: 'setup.restartDaily4am', cron: '0 4 * * *' },
  { value: 'daily-6', labelKey: 'setup.restartDaily6am', cron: '0 6 * * *' },
  { value: 'weekly-sunday', labelKey: 'setup.restartWeeklySunday', cron: '0 4 * * 0' },
  { value: 'weekly-monday', labelKey: 'setup.restartWeeklyMonday', cron: '0 4 * * 1' },
]

const isFormValid = computed(() => true) // All settings have defaults

function getCronFromSchedule(schedule: string): string {
  const option = restartScheduleOptions.find(o => o.value === schedule)
  return option?.cron || '0 4 * * *'
}

async function handleSubmit() {
  const success = await setupStore.saveStep('automation', {
    backups: {
      enabled: backupEnabled.value,
      interval: backupInterval.value,
      retention: backupRetention.value,
    },
    restart: {
      enabled: restartEnabled.value,
      schedule: getCronFromSchedule(restartSchedule.value),
      warnMinutes: warnBeforeRestart.value ? 5 : 0,
    },
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  emit('back')
}

// Helper to find schedule value from cron
function getScheduleFromCron(cron: string): string {
  const option = restartScheduleOptions.find(o => o.cron === cron)
  return option?.value || 'daily-4'
}

// Load saved data on mount
onMounted(() => {
  const savedData = setupStore.setupData.automation as Record<string, unknown> | null
  if (savedData) {
    const backups = savedData.backups as Record<string, unknown> | undefined
    if (backups) {
      if (typeof backups.enabled === 'boolean') backupEnabled.value = backups.enabled
      if (backups.interval) backupInterval.value = backups.interval as string
      if (backups.retention) backupRetention.value = backups.retention as number
    }
    const restart = savedData.restart as Record<string, unknown> | undefined
    if (restart) {
      if (typeof restart.enabled === 'boolean') restartEnabled.value = restart.enabled
      if (restart.schedule) restartSchedule.value = getScheduleFromCron(restart.schedule as string)
      if (typeof restart.warnMinutes === 'number') warnBeforeRestart.value = restart.warnMinutes > 0
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
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.automationSettingsTitle') }}</h2>
      <p class="text-gray-400">{{ t('setup.automationSettingsDescription') }}</p>
    </div>

    <!-- Form -->
    <form @submit.prevent="handleSubmit" class="space-y-6">
      <!-- Backup Section -->
      <div class="card">
        <div class="card-header">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-status-success/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
            </div>
            <div>
              <h3 class="font-semibold text-white">{{ t('setup.automaticBackups') }}</h3>
              <p class="text-sm text-gray-400">{{ t('setup.automaticBackupsDescription') }}</p>
            </div>
          </div>
        </div>

        <div class="card-body space-y-4">
          <!-- Enable Toggle -->
          <div class="flex items-center justify-between">
            <span class="text-white">{{ t('setup.enableBackups') }}</span>
            <button
              type="button"
              @click="backupEnabled = !backupEnabled"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
              :class="backupEnabled ? 'bg-hytale-orange' : 'bg-dark-50'"
            >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                :class="backupEnabled ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
          </div>

          <!-- Backup Interval -->
          <div v-if="backupEnabled" class="space-y-4 pt-2 border-t border-dark-50/50">
            <div>
              <label class="label">{{ t('setup.backupInterval') }}</label>
              <div class="relative">
                <select
                  v-model="backupInterval"
                  class="input appearance-none cursor-pointer pr-10"
                >
                  <option
                    v-for="option in backupIntervalOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ t(option.labelKey) }}
                  </option>
                </select>
                <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                  <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>

            <!-- Backup Retention -->
            <div>
              <label class="label">{{ t('setup.backupRetention') }}</label>
              <div class="relative">
                <select
                  v-model="backupRetention"
                  class="input appearance-none cursor-pointer pr-10"
                >
                  <option
                    v-for="option in backupRetentionOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ t(option.labelKey) }}
                  </option>
                </select>
                <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                  <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
              <p class="mt-1 text-xs text-gray-500">
                {{ t('setup.backupRetentionHint') }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Auto-Restart Section -->
      <div class="card">
        <div class="card-header">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-status-warning/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <div>
              <h3 class="font-semibold text-white">{{ t('setup.automaticRestarts') }}</h3>
              <p class="text-sm text-gray-400">{{ t('setup.automaticRestartsDescription') }}</p>
            </div>
          </div>
        </div>

        <div class="card-body space-y-4">
          <!-- Enable Toggle -->
          <div class="flex items-center justify-between">
            <span class="text-white">{{ t('setup.enableRestarts') }}</span>
            <button
              type="button"
              @click="restartEnabled = !restartEnabled"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
              :class="restartEnabled ? 'bg-hytale-orange' : 'bg-dark-50'"
            >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                :class="restartEnabled ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
          </div>

          <div v-if="restartEnabled" class="space-y-4 pt-2 border-t border-dark-50/50">
            <!-- Restart Schedule -->
            <div>
              <label class="label">{{ t('setup.restartSchedule') }}</label>
              <div class="relative">
                <select
                  v-model="restartSchedule"
                  class="input appearance-none cursor-pointer pr-10"
                >
                  <option
                    v-for="option in restartScheduleOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ t(option.labelKey) }}
                  </option>
                </select>
                <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                  <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>

            <!-- Warn Players Toggle -->
            <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <svg class="w-5 h-5 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  <div>
                    <span class="font-medium text-white">{{ t('setup.warnBeforeRestart') }}</span>
                    <p class="text-xs text-gray-400">{{ t('setup.warnBeforeRestartDescription') }}</p>
                  </div>
                </div>
                <button
                  type="button"
                  @click="warnBeforeRestart = !warnBeforeRestart"
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                  :class="warnBeforeRestart ? 'bg-hytale-orange' : 'bg-dark-50'"
                >
                  <span
                    class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                    :class="warnBeforeRestart ? 'translate-x-6' : 'translate-x-1'"
                  />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Info Box -->
      <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-sm text-gray-400">{{ t('setup.automationSettingsInfo') }}</p>
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
