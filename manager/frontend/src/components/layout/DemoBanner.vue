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
    class="bg-gradient-to-r from-orange-600 to-amber-500 text-white px-4 py-2 flex items-center justify-center gap-3 shadow-lg"
  >
    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
    <span class="font-medium">
      {{ t('demo.banner', 'DEMO MODE') }}
    </span>
    <span class="text-ink/90 text-sm hidden sm:inline">
      {{ t('demo.description', 'All data is simulated. No real server connected.') }}
    </span>
    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  </div>
</template>
