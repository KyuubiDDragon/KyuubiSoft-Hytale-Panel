<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
}>()

const isChecking = ref(false)

// Icons for different check statuses
const statusIcons: Record<string, { svg: string; class: string; bg: string }> = {
  pass: {
    svg: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />`,
    class: 'text-status-success',
    bg: 'bg-status-success/20',
  },
  fail: {
    svg: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />`,
    class: 'text-status-error',
    bg: 'bg-status-error/20',
  },
  warning: {
    svg: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />`,
    class: 'text-status-warning',
    bg: 'bg-status-warning/20',
  },
  checking: {
    svg: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />`,
    class: 'text-gray-400 animate-spin',
    bg: 'bg-gray-500/20',
  },
}

// Map backend status to frontend status
// Backend uses: 'ok' | 'warning' | 'error'
// Frontend uses: 'pass' | 'warning' | 'fail' | 'checking'
function mapStatus(status: string): string {
  switch (status) {
    case 'ok':
      return 'pass'
    case 'error':
      return 'fail'
    case 'warning':
      return 'warning'
    default:
      return 'checking'
  }
}

// Safe getter for status icons with fallback
function getStatusIcon(status: string) {
  const mappedStatus = mapStatus(status)
  return statusIcons[mappedStatus] || statusIcons.checking
}

const checks = computed(() => setupStore.setupData.systemCheck?.checks || [])
const canProceed = computed(() => setupStore.setupData.systemCheck?.canProceed ?? false)
const errorCount = computed(() => setupStore.setupData.systemCheck?.errors ?? 0)
const warningCount = computed(() => setupStore.setupData.systemCheck?.warnings ?? 0)

async function runCheck() {
  isChecking.value = true
  await setupStore.runSystemCheck()
  isChecking.value = false
}

function handleContinue() {
  if (canProceed.value) {
    emit('complete')
  }
}

function handleForceContine() {
  // Allow continuing despite warnings (not errors)
  if (errorCount.value === 0) {
    emit('complete')
  }
}

onMounted(() => {
  // Run check automatically on mount
  runCheck()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.systemCheckTitle') }}</h2>
      <p class="text-gray-400">{{ t('setup.systemCheckDescription') }}</p>
    </div>

    <!-- Check Results -->
    <div class="card">
      <div class="card-body p-0">
        <div v-if="isChecking && checks.length === 0" class="p-8 text-center">
          <svg class="w-12 h-12 text-hytale-orange animate-spin mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <p class="text-gray-400">{{ t('setup.runningSystemCheck') }}</p>
        </div>

        <div v-else class="divide-y divide-dark-50/30">
          <div
            v-for="check in checks"
            :key="check.id"
            class="flex items-center gap-4 px-5 py-4"
          >
            <!-- Status Icon -->
            <div
              class="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
              :class="getStatusIcon(check.status).bg"
            >
              <svg
                class="w-5 h-5"
                :class="getStatusIcon(check.status).class"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                v-html="getStatusIcon(check.status).svg"
              />
            </div>

            <!-- Check Info -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <p class="text-white font-medium">{{ check.name }}</p>
                <span
                  v-if="check.required"
                  class="text-xs px-1.5 py-0.5 rounded bg-status-error/20 text-status-error"
                >
                  {{ t('setup.required') }}
                </span>
                <span
                  v-else
                  class="text-xs px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-400"
                >
                  {{ t('setup.optional') }}
                </span>
              </div>
              <p class="text-sm text-gray-400">{{ check.description }}</p>
            </div>

            <!-- Status Message -->
            <div class="flex-shrink-0 text-right">
              <p
                class="text-sm font-medium"
                :class="{
                  'text-status-success': check.status === 'ok' || check.status === 'pass',
                  'text-status-error': check.status === 'error' || check.status === 'fail',
                  'text-status-warning': check.status === 'warning',
                  'text-gray-400': check.status === 'checking',
                }"
              >
                {{ check.message }}
              </p>
              <p v-if="check.details" class="text-xs text-gray-500">{{ check.details }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Summary -->
    <div
      v-if="checks.length > 0 && !isChecking"
      class="flex items-center justify-center gap-4 text-sm"
    >
      <span v-if="warningCount > 0" class="flex items-center gap-1.5 text-status-warning">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        {{ warningCount }} {{ t('setup.warnings') }}
      </span>
      <span v-if="errorCount > 0" class="flex items-center gap-1.5 text-status-error">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
        {{ errorCount }} {{ t('setup.errors') }}
      </span>
      <span v-if="errorCount === 0 && warningCount === 0" class="flex items-center gap-1.5 text-status-success">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        {{ t('setup.allChecksPassed') }}
      </span>
    </div>

    <!-- Error Message -->
    <div v-if="setupStore.error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error text-sm">{{ setupStore.error }}</p>
    </div>

    <!-- Actions -->
    <div class="flex items-center justify-between pt-4">
      <Button
        variant="secondary"
        :loading="isChecking"
        @click="runCheck"
      >
        <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {{ t('setup.recheckSystem') }}
      </Button>

      <div class="flex items-center gap-3">
        <Button
          v-if="warningCount > 0 && errorCount === 0"
          variant="secondary"
          @click="handleForceContine"
        >
          {{ t('setup.continueAnyway') }}
        </Button>
        <Button
          :disabled="!canProceed && errorCount > 0"
          @click="handleContinue"
        >
          {{ t('common.next') }}
          <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </Button>
      </div>
    </div>
  </div>
</template>
