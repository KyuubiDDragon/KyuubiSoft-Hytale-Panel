<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useDemoStore } from '@/stores/demo'
import { serverApi } from '@/api/server'

// Existing installs may still start the server with --allow-op (it used to be
// the setup default). The setting is not changed silently; this banner keeps
// pointing at the risk until it is switched off. Dismissal lasts one session.
const DISMISS_KEY = 'allow-op-banner-dismissed'

const { t } = useI18n()
const authStore = useAuthStore()
const demoStore = useDemoStore()

const allowOp = ref(false)
const dismissed = ref(false)

const showBanner = computed(() => allowOp.value && !dismissed.value)

async function checkAllowOp() {
  try {
    await demoStore.checkDemoMode()
    if (demoStore.isDemoMode) return
    allowOp.value = (await serverApi.getAllowOp()).allowOp === true
  } catch {
    // Not critical for the page; the Settings card still shows the state.
    allowOp.value = false
  }
}

function dismiss() {
  dismissed.value = true
  try {
    sessionStorage.setItem(DISMISS_KEY, 'true')
  } catch {
    // Storage unavailable (private mode): dismissal lasts until reload.
  }
}

onMounted(() => {
  if (!authStore.canManageServer) return
  try {
    if (sessionStorage.getItem(DISMISS_KEY) === 'true') {
      dismissed.value = true
      return
    }
  } catch {
    // Storage unavailable: show the banner.
  }
  checkAllowOp()
})
</script>

<template>
  <div
    v-if="showBanner"
    role="alert"
    class="bg-gradient-to-r from-status-error/20 to-status-warning/20 border-b-2 border-status-error px-4 py-3"
  >
    <div class="flex items-start gap-3 max-w-screen-xl mx-auto">
      <svg class="w-6 h-6 flex-shrink-0 mt-0.5 text-status-error" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>

      <div class="flex-1">
        <h3 class="font-semibold text-status-error">
          {{ t('allowOpSecurity.bannerTitle') }}
        </h3>
        <p class="text-sm text-ink-muted mt-1">
          {{ t('allowOpSecurity.bannerText') }}
          {{ t('allowOpSecurity.warning') }}
          {{ t('allowOpSecurity.safeAlternative') }}
        </p>
        <router-link
          to="/settings"
          class="inline-block mt-2 text-sm font-medium text-hytale-orange hover:underline"
        >
          {{ t('allowOpSecurity.openSettings') }}
        </router-link>
      </div>

      <button
        type="button"
        @click="dismiss"
        class="flex-shrink-0 text-ink-muted hover:text-ink transition-colors"
        :title="t('common.dismiss')"
        :aria-label="t('common.dismiss')"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
</template>
