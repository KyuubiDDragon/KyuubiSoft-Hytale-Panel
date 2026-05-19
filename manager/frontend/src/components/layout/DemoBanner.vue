<script setup lang="ts">
import { onMounted } from 'vue'
import { useDemoStore } from '@/stores/demo'
import { useI18n } from 'vue-i18n'

const demoStore = useDemoStore()
const { t } = useI18n()

onMounted(async () => {
  await demoStore.checkDemoMode()
})
</script>

<template>
  <div
    v-if="demoStore.isDemoMode"
    class="relative bg-surface text-ink px-4 py-2 flex items-center justify-center gap-3 border-b border-hytale-orange/30"
    role="status"
    :aria-label="t('demo.banner', 'DEMO MODE')"
  >
    <!-- Gradient accent bar instead of full-bleed background -->
    <span class="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-hytale-orange to-transparent" aria-hidden="true" />
    <span class="inline-flex items-center gap-2 px-3 py-0.5 rounded-full border border-hytale-orange/40 bg-hytale-orange/10">
      <svg class="h-4 w-4 text-hytale-orange animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      <span class="text-xs font-semibold tracking-wider uppercase text-hytale-orange">
        {{ t('demo.banner', 'DEMO MODE') }}
      </span>
    </span>
    <span class="text-xs text-ink-muted hidden sm:inline">
      {{ t('demo.description', 'All data is simulated. No real server connected.') }}
    </span>
  </div>
</template>
