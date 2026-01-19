<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { healthApi, type PermissionHealthResponse } from '@/api/health'

const { t } = useI18n()

const permissionHealth = ref<PermissionHealthResponse | null>(null)
const loading = ref(true)
const dismissed = ref(false)

const showBanner = computed(() => {
  if (dismissed.value) return false
  if (loading.value) return false
  if (!permissionHealth.value) return false
  // Only show if there are issues - silent when OK
  return !permissionHealth.value.ok
})

async function checkPermissions() {
  try {
    loading.value = true
    permissionHealth.value = await healthApi.checkPermissions()
  } catch (err) {
    console.error('Failed to check permissions:', err)
    // Don't show banner if check fails - we don't want to annoy users
    permissionHealth.value = { ok: true, issues: [] }
  } finally {
    loading.value = false
  }
}

function dismiss() {
  dismissed.value = true
  // Store dismissal in sessionStorage so it persists until browser closes
  sessionStorage.setItem('permission-banner-dismissed', 'true')
}

onMounted(() => {
  // Check if banner was already dismissed this session
  if (sessionStorage.getItem('permission-banner-dismissed') === 'true') {
    dismissed.value = true
    loading.value = false
    return
  }
  checkPermissions()
})
</script>

<template>
  <div
    v-if="showBanner"
    class="bg-gradient-to-r from-status-error/20 to-status-warning/20 border-b-2 border-status-error px-4 py-3"
  >
    <div class="flex items-start gap-3 max-w-screen-xl mx-auto">
      <svg class="w-6 h-6 flex-shrink-0 mt-0.5 text-status-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>

      <div class="flex-1">
        <h3 class="font-semibold text-status-error">
          {{ t('health.permissionIssue') }}
        </h3>
        <p class="text-sm text-gray-300 mt-1">
          {{ t('health.permissionIssueDesc') }}
        </p>

        <!-- List of affected directories -->
        <div v-if="permissionHealth?.issues.length" class="mt-2 space-y-1">
          <div
            v-for="issue in permissionHealth.issues"
            :key="issue.path"
            class="text-xs font-mono text-gray-400"
          >
            <span class="text-status-warning">{{ issue.name }}</span>: {{ issue.path }}
            <span v-if="issue.error" class="text-status-error ml-2">({{ issue.error }})</span>
          </div>
        </div>

        <!-- Fix command -->
        <div class="mt-3 p-2 bg-dark-400/50 rounded-md">
          <p class="text-xs text-gray-400 mb-1">{{ t('health.fixCommand') }}:</p>
          <code class="text-sm text-hytale-orange font-mono select-all">
            sudo chown -R 1001:1001 /opt/hytale
          </code>
        </div>
      </div>

      <button
        @click="dismiss"
        class="flex-shrink-0 text-gray-400 hover:text-white transition-colors"
        :title="t('common.dismiss')"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
</template>
