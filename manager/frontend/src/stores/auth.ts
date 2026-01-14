import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authApi, type TokenResponse } from '@/api/auth'

// Safe localStorage access for SSR/build compatibility
const getStorageItem = (key: string): string | null => {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key)
  }
  return null
}

const setStorageItem = (key: string, value: string): void => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value)
  }
}

const removeStorageItem = (key: string): void => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(key)
  }
}

export type UserRole = 'admin' | 'moderator' | 'operator' | 'viewer'

export const useAuthStore = defineStore('auth', () => {
  // State
  const accessToken = ref<string | null>(getStorageItem('accessToken'))
  const refreshToken = ref<string | null>(getStorageItem('refreshToken'))
  const username = ref<string | null>(getStorageItem('username'))
  const role = ref<UserRole | null>((getStorageItem('role') as UserRole) || null)

  // Getters
  const isAuthenticated = computed(() => !!accessToken.value)
  const isAdmin = computed(() => role.value === 'admin')
  const canManageServer = computed(() => role.value === 'admin' || role.value === 'moderator')

  // Operator permissions: can view dashboard, console, performance + restart server
  const canRestartServer = computed(() => ['admin', 'moderator', 'operator'].includes(role.value || ''))
  const canViewConsole = computed(() => ['admin', 'moderator', 'operator'].includes(role.value || ''))
  const canViewPerformance = computed(() => ['admin', 'moderator', 'operator'].includes(role.value || ''))

  // Only admin/moderator can manage players, backups, mods, etc.
  const canManagePlayers = computed(() => ['admin', 'moderator'].includes(role.value || ''))
  const canManageBackups = computed(() => ['admin', 'moderator'].includes(role.value || ''))
  const canManageConfig = computed(() => ['admin', 'moderator'].includes(role.value || ''))

  // Actions
  function setTokens(access: string, refresh: string) {
    accessToken.value = access
    refreshToken.value = refresh
    setStorageItem('accessToken', access)
    setStorageItem('refreshToken', refresh)
  }

  function setUser(name: string, userRole?: UserRole) {
    username.value = name
    setStorageItem('username', name)
    if (userRole) {
      role.value = userRole
      setStorageItem('role', userRole)
    }
  }

  async function login(credentials: { username: string; password: string }) {
    const response = await authApi.login(credentials)
    setTokens(response.access_token, response.refresh_token)
    setUser(credentials.username, response.role as UserRole)
    return response
  }

  async function refresh() {
    if (!refreshToken.value) {
      throw new Error('No refresh token')
    }
    const response = await authApi.refresh(refreshToken.value)
    setTokens(response.access_token, response.refresh_token)
    return response
  }

  function logout() {
    accessToken.value = null
    refreshToken.value = null
    username.value = null
    role.value = null
    removeStorageItem('accessToken')
    removeStorageItem('refreshToken')
    removeStorageItem('username')
    removeStorageItem('role')
  }

  return {
    // State
    accessToken,
    refreshToken,
    username,
    role,
    // Getters
    isAuthenticated,
    isAdmin,
    canManageServer,
    canRestartServer,
    canViewConsole,
    canViewPerformance,
    canManagePlayers,
    canManageBackups,
    canManageConfig,
    // Actions
    setTokens,
    setUser,
    login,
    refresh,
    logout,
  }
})
