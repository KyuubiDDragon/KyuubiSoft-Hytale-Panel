<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { computed } from 'vue'

const { t } = useI18n()
const route = useRoute()

interface NavItem {
  name: string
  path: string
  icon: string
  label: string
  group?: string
}

const navItems = computed<NavItem[]>(() => [
  { name: 'dashboard', path: '/', icon: 'dashboard', label: t('nav.dashboard'), group: 'main' },
  { name: 'console', path: '/console', icon: 'console', label: t('nav.console'), group: 'main' },
  { name: 'performance', path: '/performance', icon: 'performance', label: t('nav.performance'), group: 'main' },
  { name: 'players', path: '/players', icon: 'players', label: t('nav.players'), group: 'management' },
  { name: 'whitelist', path: '/whitelist', icon: 'whitelist', label: t('nav.whitelist'), group: 'management' },
  { name: 'permissions', path: '/permissions', icon: 'permissions', label: t('nav.permissions'), group: 'management' },
  { name: 'worlds', path: '/worlds', icon: 'worlds', label: t('nav.worlds'), group: 'management' },
  { name: 'backups', path: '/backups', icon: 'backup', label: t('nav.backups'), group: 'data' },
  { name: 'settings', path: '/settings', icon: 'settings', label: t('nav.settings'), group: 'data' },
])

const mainItems = computed(() => navItems.value.filter(i => i.group === 'main'))
const managementItems = computed(() => navItems.value.filter(i => i.group === 'management'))
const dataItems = computed(() => navItems.value.filter(i => i.group === 'data'))

function isActive(path: string): boolean {
  return route.path === path
}
</script>

<template>
  <aside class="w-64 bg-dark-200 border-r border-dark-50/50 flex flex-col">
    <!-- Logo -->
    <div class="h-16 flex items-center px-6 border-b border-dark-50/50">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 bg-gradient-to-br from-hytale-orange to-hytale-yellow rounded-lg flex items-center justify-center">
          <span class="text-dark font-bold text-lg">H</span>
        </div>
        <span class="text-lg font-semibold text-white">Hytale Manager</span>
      </div>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 py-4 px-3 space-y-6 overflow-y-auto">
      <!-- Main Section -->
      <div>
        <p class="px-3 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('nav.server') }}</p>
        <div class="space-y-1">
          <router-link
            v-for="item in mainItems"
            :key="item.name"
            :to="item.path"
            :class="[
              'sidebar-link',
              isActive(item.path) ? 'active' : ''
            ]"
          >
            <!-- Dashboard Icon -->
            <svg v-if="item.icon === 'dashboard'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>

            <!-- Console Icon -->
            <svg v-else-if="item.icon === 'console'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>

            <!-- Performance Icon -->
            <svg v-else-if="item.icon === 'performance'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>

            <span>{{ item.label }}</span>
          </router-link>
        </div>
      </div>

      <!-- Management Section -->
      <div>
        <p class="px-3 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('nav.management') }}</p>
        <div class="space-y-1">
          <router-link
            v-for="item in managementItems"
            :key="item.name"
            :to="item.path"
            :class="[
              'sidebar-link',
              isActive(item.path) ? 'active' : ''
            ]"
          >
            <!-- Players Icon -->
            <svg v-if="item.icon === 'players'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>

            <!-- Whitelist Icon -->
            <svg v-else-if="item.icon === 'whitelist'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>

            <!-- Permissions Icon -->
            <svg v-else-if="item.icon === 'permissions'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>

            <!-- Worlds Icon -->
            <svg v-else-if="item.icon === 'worlds'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>

            <span>{{ item.label }}</span>
          </router-link>
        </div>
      </div>

      <!-- Data Section -->
      <div>
        <p class="px-3 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('nav.data') }}</p>
        <div class="space-y-1">
          <router-link
            v-for="item in dataItems"
            :key="item.name"
            :to="item.path"
            :class="[
              'sidebar-link',
              isActive(item.path) ? 'active' : ''
            ]"
          >
            <!-- Backup Icon -->
            <svg v-if="item.icon === 'backup'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>

            <!-- Settings Icon -->
            <svg v-else-if="item.icon === 'settings'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>

            <span>{{ item.label }}</span>
          </router-link>
        </div>
      </div>
    </nav>

    <!-- Footer -->
    <div class="p-4 border-t border-dark-50/50">
      <p class="text-xs text-gray-500 text-center">Hytale Server Manager v1.0</p>
    </div>
  </aside>
</template>
