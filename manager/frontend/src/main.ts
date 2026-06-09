import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import { i18n } from './i18n'
import App from './App.vue'

import './assets/styles/main.css'

// Import stores
import { useAuthStore } from './stores/auth'
import { useSetupStore } from './stores/setup'

// Create router with lazy-loaded views
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/setup',
      name: 'setup',
      component: () => import('./views/SetupWizard.vue'),
      meta: { requiresAuth: false, isSetup: true },
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/Login.vue'),
      meta: { requiresAuth: false },
    },
    {
      path: '/',
      name: 'dashboard',
      component: () => import('./views/Dashboard.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/console',
      name: 'console',
      component: () => import('./views/Console.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/performance',
      name: 'performance',
      component: () => import('./views/Performance.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/backups',
      name: 'backups',
      component: () => import('./views/Backups.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/players',
      name: 'players',
      component: () => import('./views/Players.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/whitelist',
      name: 'whitelist',
      component: () => import('./views/Whitelist.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/permissions',
      name: 'permissions',
      component: () => import('./views/Permissions.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/worlds',
      name: 'worlds',
      component: () => import('./views/Worlds.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/mods',
      name: 'mods',
      component: () => import('./views/Mods.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/assets',
      name: 'assets',
      component: () => import('./views/Assets.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/configuration',
      name: 'configuration',
      component: () => import('./views/Configuration.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/files',
      name: 'files',
      component: () => import('./views/Files.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/Settings.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/users',
      name: 'users',
      component: () => import('./views/Users.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: '/activity',
      name: 'activity',
      component: () => import('./views/ActivityLog.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: '/audit',
      name: 'audit',
      component: () => import('./views/Audit.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: '/webhooks',
      name: 'webhooks',
      component: () => import('./views/Webhooks.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: '/security',
      name: 'security',
      component: () => import('./views/SecuritySettings.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/scheduler',
      name: 'scheduler',
      component: () => import('./views/Scheduler.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/statistics',
      name: 'statistics',
      component: () => import('./views/Statistics.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/playtime',
      name: 'playtime',
      component: () => import('./views/Playtime.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/crashes',
      name: 'crashes',
      component: () => import('./views/Crashes.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/updates',
      name: 'updates',
      component: () => import('./views/Updates.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/player/:name',
      name: 'playerProfile',
      component: () => import('./views/PlayerProfile.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/webmap',
      name: 'webmap',
      component: () => import('./views/WebMap.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/chat',
      name: 'chat',
      component: () => import('./views/Chat.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/avatar-inventory',
      name: 'avatarInventory',
      component: () => import('./views/AvatarInventory.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/help',
      name: 'help',
      component: () => import('./views/Help.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/live-map',
      name: 'liveMap',
      component: () => import('./views/LiveMap.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/replay',
      name: 'replay',
      component: () => import('./views/Replay.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/wiki',
      name: 'wiki',
      component: () => import('./views/Wiki.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/roles',
      name: 'roles',
      component: () => import('./views/Roles.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: '/servers',
      name: 'servers',
      component: () => import('./views/Servers.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/status',
      name: 'publicStatus',
      component: () => import('./views/PublicStatus.vue'),
      meta: { requiresAuth: false, public: true },
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})

// Create app
const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)

// Setup check cache to avoid repeated API calls
let setupCheckDone = false
let setupRequired = false

// Navigation guard (must be after pinia is installed)
router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore()
  const setupStore = useSetupStore()

  // Check setup status once on first navigation (unless going to setup page)
  if (!setupCheckDone && !to.meta.isSetup) {
    try {
      setupRequired = await setupStore.loadSetupStatus()
      setupCheckDone = true
    } catch {
      // If setup check fails, assume setup is not required
      setupCheckDone = true
      setupRequired = false
    }
  }

  // Public pages (e.g. the read-only status page) bypass setup/auth gates.
  if (to.meta.public) {
    next()
    return
  }

  // If setup is required and not going to setup page, redirect to setup
  if (setupRequired && !to.meta.isSetup) {
    next('/setup')
    return
  }

  // If setup is complete and trying to access setup page, redirect away
  if (!setupRequired && setupCheckDone && to.meta.isSetup) {
    next('/login')
    return
  }

  // Standard auth checks
  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    next('/login')
  } else if (to.path === '/login' && authStore.isAuthenticated) {
    next('/')
  } else if (to.meta.requiresAdmin && !authStore.isAdmin) {
    next('/')
  } else {
    next()
  }
})

app.use(router)
app.mount('#app')
