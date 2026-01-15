<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { setLocale, getLocale } from '@/i18n'
import { modStoreApi } from '@/api/management'

const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()

const showUserMenu = ref(false)
const currentLocale = ref(getLocale())
const webMapInstalled = ref(false)
const webMapPort = ref(18081)

function toggleLocale() {
  const newLocale = currentLocale.value === 'de' ? 'en' : 'de'
  setLocale(newLocale)
  currentLocale.value = newLocale
}

function logout() {
  authStore.logout()
  router.push('/login')
}

function openWebMap() {
  // Open the web map in a new tab
  const host = window.location.hostname
  window.open(`http://${host}:${webMapPort.value}`, '_blank')
}

async function checkWebMapStatus() {
  try {
    const mods = await modStoreApi.getAvailable()
    const webMap = mods.find(m => m.id === 'easywebmap')
    if (webMap && webMap.installed) {
      webMapInstalled.value = true
      // Get port from config if available
      if (webMap.ports && webMap.ports.length > 0) {
        webMapPort.value = webMap.ports[0].default
      }
    }
  } catch (e) {
    // Silently fail - just don't show the button
  }
}

onMounted(() => {
  checkWebMapStatus()
})
</script>

<template>
  <header class="h-16 bg-dark-200 border-b border-dark-50/50 flex items-center justify-between px-6">
    <!-- Left: Page Title (handled by route) -->
    <div>
      <!-- Placeholder for breadcrumbs or page title -->
    </div>

    <!-- Right: Actions -->
    <div class="flex items-center gap-4">
      <!-- Web Map Button (only when EasyWebMap is installed) -->
      <button
        v-if="webMapInstalled"
        @click="openWebMap"
        class="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-hytale-orange transition-colors rounded-lg hover:bg-dark-50"
        :title="t('header.openMap')"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
      </button>

      <!-- Language Toggle -->
      <button
        @click="toggleLocale"
        class="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors rounded-lg hover:bg-dark-50"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
        <span class="uppercase font-medium">{{ currentLocale }}</span>
      </button>

      <!-- User Menu -->
      <div class="relative">
        <button
          @click="showUserMenu = !showUserMenu"
          class="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors rounded-lg hover:bg-dark-50"
        >
          <div class="w-8 h-8 rounded-full bg-hytale-orange/20 flex items-center justify-center">
            <span class="text-hytale-orange font-medium">
              {{ authStore.username?.charAt(0).toUpperCase() || 'U' }}
            </span>
          </div>
          <span>{{ authStore.username }}</span>
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <!-- Dropdown -->
        <div
          v-if="showUserMenu"
          class="absolute right-0 mt-2 w-48 bg-dark-100 border border-dark-50 rounded-lg shadow-lg py-1 z-50"
        >
          <button
            @click="logout"
            class="w-full px-4 py-2 text-left text-sm text-gray-400 hover:text-white hover:bg-dark-50 flex items-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            {{ t('auth.logout') }}
          </button>
        </div>
      </div>
    </div>
  </header>

  <!-- Click outside to close menu -->
  <div v-if="showUserMenu" class="fixed inset-0 z-40" @click="showUserMenu = false" />
</template>
