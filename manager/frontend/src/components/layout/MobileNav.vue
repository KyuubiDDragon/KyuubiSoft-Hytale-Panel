<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { computed, inject } from 'vue'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/ui/Icon.vue'

/**
 * Bottom navigation bar for phones (hidden at lg+, where the static sidebar
 * is always visible). Surfaces the handful of most-used destinations plus a
 * "Menu" button that opens the full drawer. Items the user lacks permission
 * for are dropped, and the list is capped so the bar never overflows.
 */
const { t } = useI18n()
const route = useRoute()
const authStore = useAuthStore()
const toggleSidebar = inject<() => void>('toggleSidebar', () => {})

interface QuickItem { name: string; path: string; icon: string; label: string; permission: string }

const candidates = computed<QuickItem[]>(() => [
  { name: 'dashboard', path: '/', icon: 'dashboard', label: t('nav.dashboard'), permission: 'dashboard.view' },
  { name: 'console', path: '/console', icon: 'console', label: t('nav.console'), permission: 'console.view' },
  { name: 'players', path: '/players', icon: 'players', label: t('nav.players'), permission: 'players.view' },
  { name: 'performance', path: '/performance', icon: 'performance', label: t('nav.performance'), permission: 'performance.view' },
])

// At most four quick links so the bar plus the Menu button fit on one row.
const items = computed(() => candidates.value.filter(i => authStore.hasPermission(i.permission)).slice(0, 4))

function isActive(path: string): boolean {
  return path === '/' ? route.path === '/' : route.path.startsWith(path)
}
</script>

<template>
  <nav
    class="lg:hidden fixed bottom-0 inset-x-0 z-20 bg-surface-raised/95 backdrop-blur-xl border-t border-border/60 flex items-stretch justify-around pb-[env(safe-area-inset-bottom)]"
    :aria-label="t('nav.server')"
  >
    <router-link
      v-for="item in items"
      :key="item.name"
      :to="item.path"
      class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors"
      :class="isActive(item.path) ? 'text-hytale-orange' : 'text-ink-muted hover:text-ink'"
    >
      <Icon :name="item.icon" class="w-5 h-5" />
      <span class="truncate max-w-[64px]">{{ item.label }}</span>
    </router-link>
    <button
      type="button"
      @click="toggleSidebar"
      class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors"
      :aria-label="t('nav.menu')"
    >
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      <span>{{ t('nav.menu') }}</span>
    </button>
  </nav>
</template>
