<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { setLocale, getLocale } from '@/i18n'
import { modStoreApi } from '@/api/management'
import { useTheme } from '@/composables/useTheme'
import NotificationBell from './NotificationBell.vue'
import ServerPicker from './ServerPicker.vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const { theme, toggle: toggleTheme } = useTheme()

const showUserMenu = ref(false)
// Close the user menu on Escape (it already closes on outside-click).
onKeyStroke('Escape', () => { if (showUserMenu.value) showUserMenu.value = false })
const currentLocale = ref(getLocale())
const webMapInstalled = ref(false)

// Mobile sidebar toggle (provided by AppLayout)
const toggleSidebar = inject<() => void>('toggleSidebar', () => {})

// Locale cycling: de → en → pt_br → de
const locales = ['de', 'en', 'pt_br'] as const
const localeDisplay: Record<string, string> = { de: 'DE', en: 'EN', pt_br: 'PT' }

function toggleLocale() {
  const currentIndex = locales.indexOf(currentLocale.value as typeof locales[number])
  const nextIndex = (currentIndex + 1) % locales.length
  const newLocale = locales[nextIndex]
  setLocale(newLocale)
  currentLocale.value = newLocale
}

// Current page title from route name
const currentPageTitle = computed(() => {
  const name = route.name as string
  if (!name) return ''
  const key = `nav.${name}`
  const translated = t(key)
  return translated !== key ? translated : name.charAt(0).toUpperCase() + name.slice(1)
})

function logout() {
  authStore.logout()
  showUserMenu.value = false
  router.push('/login')
}

function goToSettings() {
  showUserMenu.value = false
  router.push('/settings')
}

function openWebMap() {
  router.push('/webmap')
}

async function checkWebMapStatus() {
  try {
    const result = await modStoreApi.getAvailable()
    const webMap = result.mods.find(m => m.id === 'easywebmap')
    if (webMap && webMap.installed) {
      webMapInstalled.value = true
    }
  } catch (e) {
    // Silently fail
  }
}

onMounted(() => {
  checkWebMapStatus()
})
</script>

<template>
  <header class="h-16 bg-surface-raised/80 backdrop-blur-xl border-b border-border/60 flex items-center justify-between px-4 sm:px-6 sticky top-0 z-20">
    <!-- Left: Hamburger + Page Title -->
    <div class="flex items-center gap-3">
      <!-- Mobile menu toggle -->
      <button
        @click="toggleSidebar"
        class="lg:hidden h-10 w-10 inline-flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface-muted transition-colors"
        :aria-label="t('common.openMenu')"
      >
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <!-- v3 multi-server picker -->
      <ServerPicker class="hidden sm:flex" />
      <h2 class="text-sm font-medium text-ink-muted truncate">
        {{ currentPageTitle }}
      </h2>
    </div>

    <!-- Right: Actions -->
    <div class="flex items-center gap-1 sm:gap-2">
      <!-- Notifications bell -->
      <NotificationBell />

      <!-- Web Map Button -->
      <button
        v-if="webMapInstalled"
        @click="openWebMap"
        class="h-10 w-10 inline-flex items-center justify-center rounded-lg text-ink-muted hover:text-hytale-orange hover:bg-surface-muted transition-colors"
        :title="t('header.openMap')"
        :aria-label="t('header.openMap')"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
      </button>

      <!-- Theme Toggle -->
      <button
        @click="toggleTheme"
        class="h-10 w-10 inline-flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface-muted transition-colors"
        :aria-label="theme === 'dark' ? t('common.lightMode') : t('common.darkMode')"
        :title="t('common.toggleTheme')"
      >
        <svg v-if="theme === 'dark'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
        <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      </button>

      <!-- Language Toggle -->
      <button
        @click="toggleLocale"
        class="h-10 px-3 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink hover:bg-surface-muted transition-colors rounded-lg"
        :aria-label="`Language: ${localeDisplay[currentLocale]}`"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
        <span class="font-medium">{{ localeDisplay[currentLocale] || currentLocale.toUpperCase() }}</span>
      </button>

      <!-- User Menu -->
      <div class="relative">
        <button
          @click="showUserMenu = !showUserMenu"
          class="h-10 px-2 sm:px-3 inline-flex items-center gap-2 text-sm text-ink-muted hover:text-ink hover:bg-surface-muted transition-colors rounded-lg"
          :aria-label="t('common.userMenu')"
          :aria-expanded="showUserMenu"
          aria-haspopup="menu"
        >
          <div class="w-8 h-8 rounded-full bg-hytale-orange/20 flex items-center justify-center">
            <span class="text-hytale-orange font-medium" aria-hidden="true">
              {{ authStore.username?.charAt(0).toUpperCase() || 'U' }}
            </span>
          </div>
          <span class="hidden sm:inline">{{ authStore.username }}</span>
          <svg class="w-4 h-4 transition-transform" :class="{ 'rotate-180': showUserMenu }" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <!-- Dropdown -->
        <Transition
          enter-active-class="transition ease-out duration-100"
          enter-from-class="transform opacity-0 scale-95"
          enter-to-class="transform opacity-100 scale-100"
          leave-active-class="transition ease-in duration-75"
          leave-from-class="transform opacity-100 scale-100"
          leave-to-class="transform opacity-0 scale-95"
        >
          <div
            v-if="showUserMenu"
            class="absolute right-0 mt-2 w-56 bg-surface-overlay border border-border rounded-lg shadow-xl py-1 z-50"
            role="menu"
          >
            <div class="px-4 py-3 border-b border-border/60">
              <p class="text-sm font-medium text-ink">{{ authStore.username }}</p>
              <span
                class="inline-flex items-center mt-1 px-2 py-0.5 rounded text-xs font-medium"
                :class="authStore.isAdmin
                  ? 'bg-hytale-orange/20 text-hytale-orange'
                  : 'bg-status-info/20 text-status-info'"
              >
                {{ t(`users.roles.${authStore.role || 'viewer'}`) }}
              </span>
            </div>

            <div class="py-1">
              <button
                @click="goToSettings"
                class="w-full px-4 py-2 text-left text-sm text-ink-muted hover:text-ink hover:bg-surface-muted flex items-center gap-2 transition-colors"
                role="menuitem"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {{ t('nav.settings') }}
              </button>
            </div>

            <div class="border-t border-border/60 py-1">
              <button
                @click="logout"
                class="w-full px-4 py-2 text-left text-sm text-status-error hover:bg-status-error/10 flex items-center gap-2 transition-colors"
                role="menuitem"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                {{ t('auth.logout') }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </header>

  <!-- Click outside to close menu -->
  <div v-if="showUserMenu" class="fixed inset-0 z-40" @click="showUserMenu = false" />
</template>
