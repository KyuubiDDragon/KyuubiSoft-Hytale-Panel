<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const route = useRoute()
const authStore = useAuthStore()

interface NavItem {
  name: string
  path: string
  icon: string
  label: string
  group?: string
  adminOnly?: boolean
}

const navItems = computed<NavItem[]>(() => [
  { name: 'dashboard', path: '/', icon: 'dashboard', label: t('nav.dashboard'), group: 'main' },
  { name: 'console', path: '/console', icon: 'console', label: t('nav.console'), group: 'main' },
  { name: 'performance', path: '/performance', icon: 'performance', label: t('nav.performance'), group: 'main' },
  { name: 'players', path: '/players', icon: 'players', label: t('nav.players'), group: 'management' },
  { name: 'whitelist', path: '/whitelist', icon: 'whitelist', label: t('nav.whitelist'), group: 'management' },
  { name: 'permissions', path: '/permissions', icon: 'permissions', label: t('nav.permissions'), group: 'management' },
  { name: 'worlds', path: '/worlds', icon: 'worlds', label: t('nav.worlds'), group: 'management' },
  { name: 'mods', path: '/mods', icon: 'mods', label: t('nav.mods'), group: 'management' },
  { name: 'backups', path: '/backups', icon: 'backup', label: t('nav.backups'), group: 'data' },
  { name: 'configuration', path: '/configuration', icon: 'configuration', label: t('nav.configuration'), group: 'data' },
  { name: 'settings', path: '/settings', icon: 'settings', label: t('nav.settings'), group: 'data' },
  { name: 'users', path: '/users', icon: 'users', label: t('nav.users'), group: 'admin', adminOnly: true },
  { name: 'activity', path: '/activity', icon: 'activity', label: t('nav.activityLog'), group: 'admin', adminOnly: true },
])

const mainItems = computed(() => navItems.value.filter(i => i.group === 'main'))
const managementItems = computed(() => navItems.value.filter(i => i.group === 'management'))
const dataItems = computed(() => navItems.value.filter(i => i.group === 'data'))
const adminItems = computed(() => navItems.value.filter(i => i.group === 'admin' && (!i.adminOnly || authStore.isAdmin)))

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

            <!-- Mods Icon -->
            <svg v-else-if="item.icon === 'mods'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
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

            <!-- Configuration Icon -->
            <svg v-else-if="item.icon === 'configuration'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
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

      <!-- Admin Section (only visible to admins) -->
      <div v-if="adminItems.length > 0">
        <p class="px-3 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Admin</p>
        <div class="space-y-1">
          <router-link
            v-for="item in adminItems"
            :key="item.name"
            :to="item.path"
            :class="[
              'sidebar-link',
              isActive(item.path) ? 'active' : ''
            ]"
          >
            <!-- Users Icon -->
            <svg v-if="item.icon === 'users'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>

            <!-- Activity Log Icon -->
            <svg v-else-if="item.icon === 'activity'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>

            <span>{{ item.label }}</span>
          </router-link>
        </div>
      </div>
    </nav>

    <!-- Footer -->
    <div class="p-4 border-t border-dark-50/50 space-y-3">
      <!-- Social Links -->
      <div class="flex justify-center gap-3">
        <a
          href="https://ko-fi.com/kyuubiddragon"
          target="_blank"
          rel="noopener noreferrer"
          class="p-2 rounded-lg bg-[#FF5E5B]/10 text-[#FF5E5B] hover:bg-[#FF5E5B]/20 transition-colors"
          title="Support on Ko-fi"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M23.881 8.948c-.773-4.085-4.859-4.593-4.859-4.593H.723c-.604 0-.679.798-.679.798s-.082 7.324-.022 11.822c.164 2.424 2.586 2.672 2.586 2.672s8.267-.023 11.966-.049c2.438-.426 2.683-2.566 2.658-3.734 4.352.24 7.422-2.831 6.649-6.916zm-11.062 3.511c-1.246 1.453-4.011 3.976-4.011 3.976s-.121.119-.31.023c-.076-.057-.108-.09-.108-.09-.443-.441-3.368-3.049-4.034-3.954-.709-.965-1.041-2.7-.091-3.71.951-1.01 3.005-1.086 4.363.407 0 0 1.565-1.782 3.468-.963 1.904.82 1.832 3.011.723 4.311zm6.173.478c-.928.116-1.682.028-1.682.028V7.284h1.77s1.971.551 1.971 2.638c0 1.913-.985 2.667-2.059 3.015z"/>
          </svg>
        </a>
        <a
          href="https://discord.com/users/kyuubiddragon"
          target="_blank"
          rel="noopener noreferrer"
          class="p-2 rounded-lg bg-[#5865F2]/10 text-[#5865F2] hover:bg-[#5865F2]/20 transition-colors"
          title="Discord: KyuubiDDragon"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
        </a>
        <a
          href="https://github.com/KyuubiDDragon/Hytale-Server"
          target="_blank"
          rel="noopener noreferrer"
          class="p-2 rounded-lg bg-gray-500/10 text-gray-400 hover:bg-gray-500/20 transition-colors"
          title="GitHub Repository"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
          </svg>
        </a>
      </div>
      <!-- Credits -->
      <div class="text-center">
        <p class="text-xs text-gray-500">Made by <a href="https://github.com/KyuubiDDragon" target="_blank" class="text-hytale-orange hover:underline">KyuubiDDragon</a></p>
        <p class="text-xs text-gray-600 mt-1">v1.0</p>
      </div>
    </div>
  </aside>
</template>
