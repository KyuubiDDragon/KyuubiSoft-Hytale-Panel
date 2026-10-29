import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import { i18n, setupI18n } from './i18n'
import App from './App.vue'

import './assets/styles/main.css'

// Import stores
import { useAuthStore } from './stores/auth'
import { useSetupStore } from './stores/setup'
import { routeNeedsAllServers, routePermission } from './router/navigation'
import { useServersStore } from './stores/servers'

/** Meta of a page behind the login; the permission comes from the shared navigation list. */
function guarded(name: string) {
  return {
    requiresAuth: true,
    permission: routePermission(name),
    allServers: routeNeedsAllServers(name),
  }
}

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
      meta: guarded('dashboard'),
    },
    {
      path: '/console',
      name: 'console',
      component: () => import('./views/Console.vue'),
      meta: guarded('console'),
    },
    {
      path: '/performance',
      name: 'performance',
      component: () => import('./views/Performance.vue'),
      meta: guarded('performance'),
    },
    {
      path: '/backups',
      name: 'backups',
      component: () => import('./views/Backups.vue'),
      meta: guarded('backups'),
    },
    {
      path: '/players',
      name: 'players',
      component: () => import('./views/Players.vue'),
      meta: guarded('players'),
    },
    {
      path: '/whitelist',
      name: 'whitelist',
      component: () => import('./views/Whitelist.vue'),
      meta: guarded('whitelist'),
    },
    {
      path: '/permissions',
      name: 'permissions',
      component: () => import('./views/Permissions.vue'),
      meta: guarded('permissions'),
    },
    {
      path: '/worlds',
      name: 'worlds',
      component: () => import('./views/Worlds.vue'),
      meta: guarded('worlds'),
    },
    {
      path: '/mods',
      name: 'mods',
      component: () => import('./views/Mods.vue'),
      meta: guarded('mods'),
    },
    {
      path: '/mod-status/:id?',
      name: 'modStatus',
      component: () => import('./views/ModStatus.vue'),
      meta: guarded('modStatus'),
    },
    {
      path: '/assets',
      name: 'assets',
      component: () => import('./views/Assets.vue'),
      meta: guarded('assets'),
    },
    {
      path: '/configuration',
      name: 'configuration',
      component: () => import('./views/Configuration.vue'),
      meta: guarded('configuration'),
    },
    {
      path: '/files',
      name: 'files',
      component: () => import('./views/Files.vue'),
      meta: guarded('files'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/Settings.vue'),
      meta: guarded('settings'),
    },
    {
      path: '/users',
      name: 'users',
      component: () => import('./views/Users.vue'),
      meta: guarded('users'),
    },
    {
      path: '/activity',
      name: 'activity',
      component: () => import('./views/ActivityLog.vue'),
      meta: guarded('activity'),
    },
    {
      path: '/audit',
      name: 'audit',
      component: () => import('./views/Audit.vue'),
      meta: guarded('audit'),
    },
    {
      path: '/webhooks',
      name: 'webhooks',
      component: () => import('./views/Webhooks.vue'),
      meta: guarded('webhooks'),
    },
    {
      path: '/security',
      name: 'security',
      component: () => import('./views/SecuritySettings.vue'),
      meta: guarded('security'),
    },
    {
      path: '/scheduler',
      name: 'scheduler',
      component: () => import('./views/Scheduler.vue'),
      meta: guarded('scheduler'),
    },
    {
      path: '/statistics',
      name: 'statistics',
      component: () => import('./views/Statistics.vue'),
      meta: guarded('statistics'),
    },
    {
      path: '/playtime',
      name: 'playtime',
      component: () => import('./views/Playtime.vue'),
      meta: guarded('playtime'),
    },
    {
      path: '/crashes',
      name: 'crashes',
      component: () => import('./views/Crashes.vue'),
      meta: guarded('crashes'),
    },
    {
      path: '/updates',
      name: 'updates',
      component: () => import('./views/Updates.vue'),
      meta: guarded('updates'),
    },
    {
      path: '/player/:name',
      name: 'playerProfile',
      component: () => import('./views/PlayerProfile.vue'),
      meta: guarded('playerProfile'),
    },
    {
      path: '/webmap',
      name: 'webmap',
      component: () => import('./views/WebMap.vue'),
      meta: guarded('webmap'),
    },
    {
      path: '/chat',
      name: 'chat',
      component: () => import('./views/Chat.vue'),
      meta: guarded('chat'),
    },
    {
      path: '/avatar-inventory',
      name: 'avatarInventory',
      component: () => import('./views/AvatarInventory.vue'),
      meta: guarded('avatarInventory'),
    },
    {
      path: '/help',
      name: 'help',
      component: () => import('./views/Help.vue'),
      meta: guarded('help'),
    },
    {
      path: '/live-map',
      name: 'liveMap',
      component: () => import('./views/LiveMap.vue'),
      meta: guarded('liveMap'),
    },
    {
      path: '/replay',
      name: 'replay',
      component: () => import('./views/Replay.vue'),
      meta: guarded('replay'),
    },
    {
      path: '/wiki',
      name: 'wiki',
      component: () => import('./views/Wiki.vue'),
      meta: guarded('wiki'),
    },
    {
      path: '/roles',
      name: 'roles',
      component: () => import('./views/Roles.vue'),
      meta: guarded('roles'),
    },
    {
      path: '/servers',
      name: 'servers',
      component: () => import('./views/Servers.vue'),
      meta: guarded('servers'),
    },
    {
      path: '/event-actions',
      name: 'eventActions',
      component: () => import('./views/EventActions.vue'),
      meta: guarded('eventActions'),
    },
    {
      path: '/forbidden',
      name: 'forbidden',
      component: () => import('./views/Forbidden.vue'),
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
      // No answer (offline, server restarting): carry on as a set-up panel
      // instead of sending the user into the wizard, and ask again next time.
      setupCheckDone = false
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
  } else if (
    (to.meta.permission && !authStore.hasPermission(to.meta.permission)) ||
    (to.meta.allServers && useServersStore().hasServerList)
  ) {
    // Say why the page stays closed instead of dropping the user on the dashboard.
    next({ name: 'forbidden', query: { page: to.fullPath }, replace: true })
  } else {
    next()
  }
})

app.use(router)
// The active language is loaded first, so the first render has no raw keys.
void setupI18n().then(() => app.mount('#app'))
