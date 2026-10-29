<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useServersStore } from '@/stores/servers'
import { NAV_ENTRIES, firstOpenPath } from '@/router/navigation'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const serversStore = useServersStore()

// The page that was asked for, as the menu names it (path only as a fallback).
const requestedPath = computed(() => String(route.query.page ?? ''))
const requestedTitle = computed(() => {
  const entry = NAV_ENTRIES.find(
    (e) => e.path === requestedPath.value.split('?')[0].replace(/\/+$/, '') || e.path === requestedPath.value,
  )
  return entry ? t(entry.labelKey) : requestedPath.value
})
const homePath = computed(() => firstOpenPath(authStore.hasPermission, { hasServerList: serversStore.hasServerList }))

function goHome() {
  void router.push(homePath.value ?? '/help')
}
</script>

<template>
  <div class="max-w-lg mx-auto mt-16 text-center">
    <div class="w-14 h-14 mx-auto mb-4 rounded-full bg-status-warning/15 flex items-center justify-center">
      <svg class="w-7 h-7 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    </div>
    <h1 class="text-2xl font-bold text-ink mb-2">{{ t('forbidden.title') }}</h1>
    <p class="text-ink-muted mb-1">
      <template v-if="requestedTitle">{{ t('forbidden.messageFor', { page: requestedTitle }) }}</template>
      <template v-else>{{ t('forbidden.message') }}</template>
    </p>
    <p class="text-sm text-ink-subtle mb-6">{{ t('forbidden.hint') }}</p>
    <Button variant="primary" @click="goHome">{{ t('forbidden.back') }}</Button>
  </div>
</template>
