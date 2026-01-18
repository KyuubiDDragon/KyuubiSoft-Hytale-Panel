import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import { i18n } from './i18n'
import App from './App.vue'

import './assets/styles/main.css'

// Import views
import Login from './views/Login.vue'
import Dashboard from './views/Dashboard.vue'
import Console from './views/Console.vue'
import Backups from './views/Backups.vue'
import Players from './views/Players.vue'
import Settings from './views/Settings.vue'
import Whitelist from './views/Whitelist.vue'
import Permissions from './views/Permissions.vue'
import Worlds from './views/Worlds.vue'
import Performance from './views/Performance.vue'
import Configuration from './views/Configuration.vue'
import Mods from './views/Mods.vue'
import Users from './views/Users.vue'
import ActivityLog from './views/ActivityLog.vue'
import Scheduler from './views/Scheduler.vue'
import Statistics from './views/Statistics.vue'
import WebMap from './views/WebMap.vue'
import Assets from './views/Assets.vue'
import Chat from './views/Chat.vue'

// Import auth store
import { useAuthStore } from './stores/auth'

// Create router
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: Login,
      meta: { requiresAuth: false },
    },
    {
      path: '/',
      name: 'dashboard',
      component: Dashboard,
      meta: { requiresAuth: true },
    },
    {
      path: '/console',
      name: 'console',
      component: Console,
      meta: { requiresAuth: true },
    },
    {
      path: '/performance',
      name: 'performance',
      component: Performance,
      meta: { requiresAuth: true },
    },
    {
      path: '/backups',
      name: 'backups',
      component: Backups,
      meta: { requiresAuth: true },
    },
    {
      path: '/players',
      name: 'players',
      component: Players,
      meta: { requiresAuth: true },
    },
    {
      path: '/whitelist',
      name: 'whitelist',
      component: Whitelist,
      meta: { requiresAuth: true },
    },
    {
      path: '/permissions',
      name: 'permissions',
      component: Permissions,
      meta: { requiresAuth: true },
    },
    {
      path: '/worlds',
      name: 'worlds',
      component: Worlds,
      meta: { requiresAuth: true },
    },
    {
      path: '/mods',
      name: 'mods',
      component: Mods,
      meta: { requiresAuth: true },
    },
    {
      path: '/assets',
      name: 'assets',
      component: Assets,
      meta: { requiresAuth: true },
    },
    {
      path: '/configuration',
      name: 'configuration',
      component: Configuration,
      meta: { requiresAuth: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: Settings,
      meta: { requiresAuth: true },
    },
    {
      path: '/users',
      name: 'users',
      component: Users,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: '/activity',
      name: 'activity',
      component: ActivityLog,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: '/scheduler',
      name: 'scheduler',
      component: Scheduler,
      meta: { requiresAuth: true },
    },
    {
      path: '/statistics',
      name: 'statistics',
      component: Statistics,
      meta: { requiresAuth: true },
    },
    {
      path: '/webmap',
      name: 'webmap',
      component: WebMap,
      meta: { requiresAuth: true },
    },
    {
      path: '/chat',
      name: 'chat',
      component: Chat,
      meta: { requiresAuth: true },
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

// Navigation guard (must be after pinia is installed)
router.beforeEach((to, _from, next) => {
  const authStore = useAuthStore()

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
