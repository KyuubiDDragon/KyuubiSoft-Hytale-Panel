<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AxiosError } from 'axios'
import api from '@/api/client'
import { modStoreApi } from '@/api/management'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const authStore = useAuthStore()

const loading = ref(true)
const error = ref('')
const webMapInstalled = ref(false)
const webMapHttpPort = ref(18081)

const canViewMap = computed(() => authStore.hasPermission('players.view'))

// The map is third-party code from the EasyWebMap mod. The backend proxies it
// under a per-session path (/api/webmap/t/<ticket>/) and forces it into a
// sandbox with an opaque origin, so it can't read this page's tokens or call
// the panel API as the current user.
const mapUrl = ref('')
let currentTicket: string | null = null

interface WebMapSession {
  ticket: string
  path: string
}

async function createSession(): Promise<WebMapSession> {
  const { data } = await api.post<WebMapSession>('/webmap/session')
  return data
}

function revokeSession(ticket: string | null) {
  if (!ticket) return
  // Best effort: an unrevoked session still expires on its own.
  api.post('/webmap/session/revoke', { ticket }).catch(() => {})
}

function sessionError(e: unknown): string {
  return (e as AxiosError)?.response?.status === 403
    ? t('webmap.access.noPermission')
    : t('webmap.access.sessionFailed')
}

async function loadMap() {
  try {
    const session = await createSession()
    revokeSession(currentTicket)
    currentTicket = session.ticket
    mapUrl.value = session.path
    error.value = ''
  } catch (e) {
    error.value = sessionError(e)
  }
}

async function checkWebMapStatus() {
  try {
    const result = await modStoreApi.getAvailable()
    const webMap = result.mods.find(m => m.id === 'easywebmap')
    if (webMap && webMap.installed) {
      webMapInstalled.value = true
      if (webMap.ports && webMap.ports.length > 0) {
        webMapHttpPort.value = webMap.ports[0].default
      }
      if (canViewMap.value) await loadMap()
    }
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    loading.value = false
  }
}

async function openInNewTab() {
  // Open the tab synchronously so popup blockers allow it, cut the opener link
  // (the map must not be able to navigate this tab), then point it at a
  // session of its own. The backend sandboxes the page there as well.
  const tab = window.open('', '_blank')
  if (!tab) return
  tab.opener = null
  try {
    const session = await createSession()
    tab.location.href = session.path
  } catch (e) {
    tab.close()
    error.value = sessionError(e)
  }
}

function refreshMap() {
  // A fresh session also recovers a map whose session has expired.
  loadMap()
}

onMounted(() => {
  checkWebMapStatus()
})

onBeforeUnmount(() => {
  revokeSession(currentTicket)
  currentTicket = null
})
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between mb-4 shrink-0">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('webmap.title') }}</h1>
        <p class="text-ink-muted text-sm mt-1">{{ t('webmap.subtitle') }}</p>
      </div>
      <div v-if="webMapInstalled && canViewMap" class="flex items-center gap-2">
        <button
          @click="refreshMap"
          class="px-3 py-1.5 bg-surface-overlay text-ink-muted rounded-lg hover:bg-surface-overlay transition-colors text-sm flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('common.refresh') }}
        </button>
        <button
          @click="openInNewTab"
          class="px-3 py-1.5 bg-surface-overlay text-ink-muted rounded-lg hover:bg-surface-overlay transition-colors text-sm flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          {{ t('webmap.openNewTab') }}
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 bg-surface-raised rounded-xl overflow-hidden min-h-0">
      <!-- Loading -->
      <div v-if="loading" class="h-full flex items-center justify-center text-ink-muted">
        <svg class="animate-spin h-8 w-8 mr-3" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        {{ t('common.loading') }}
      </div>

      <!-- Not Installed -->
      <div v-else-if="!webMapInstalled" class="h-full flex flex-col items-center justify-center text-ink-muted p-8">
        <svg class="w-16 h-16 mb-4 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
        <h3 class="text-xl font-semibold text-ink mb-2">{{ t('webmap.notInstalled') }}</h3>
        <p class="text-center max-w-md">{{ t('webmap.notInstalledDesc') }}</p>
        <router-link
          to="/mods"
          class="mt-4 px-4 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors"
        >
          {{ t('webmap.goToModStore') }}
        </router-link>
      </div>

      <!-- No players.view: the backend would refuse the map session anyway -->
      <div v-else-if="!canViewMap" class="h-full flex items-center justify-center text-ink-muted p-8 text-center">
        {{ t('webmap.access.noPermission') }}
      </div>

      <!-- Session could not be created -->
      <div v-else-if="error && !mapUrl" class="h-full flex flex-col items-center justify-center text-ink-muted p-8 text-center gap-4">
        <p>{{ error }}</p>
        <button
          @click="refreshMap"
          class="px-4 py-2 bg-surface-overlay text-ink rounded-lg hover:bg-surface-overlay transition-colors text-sm"
        >
          {{ t('common.refresh') }}
        </button>
      </div>

      <!-- Map iframe: sandboxed without allow-same-origin (opaque origin) -->
      <iframe
        v-else-if="mapUrl"
        id="webmap-frame"
        :key="mapUrl"
        :src="mapUrl"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        class="w-full h-full border-0"
        :title="t('webmap.title')"
      />
    </div>
  </div>
</template>
