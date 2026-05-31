import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authApi } from '@/api/auth'

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
  // Refresh tokens moved into an HttpOnly cookie (kp_refresh) in v2.2.
  // We still rehydrate any value previously stored in localStorage so users
  // who upgraded mid-session aren't forced to re-login. After the next
  // successful refresh the localStorage copy is dropped (see setTokens).
  const accessToken = ref<string | null>(getStorageItem('accessToken'))
  const refreshToken = ref<string | null>(getStorageItem('refreshToken'))
  const username = ref<string | null>(getStorageItem('username'))
  const role = ref<UserRole | null>((getStorageItem('role') as UserRole) || null)
  const permissions = ref<string[]>(JSON.parse(getStorageItem('permissions') || '[]'))
  // One-shot message displayed on the login screen after a forced logout
  // (account deleted, refresh-token invalidated, role changed, ...). The
  // Login view consumes it via `consumeLogoutMessage()`.
  const logoutMessage = ref<string | null>(null)

  // Getters
  const isAuthenticated = computed(() => !!accessToken.value)
  const isAdmin = computed(() => role.value === 'admin')

  // Permission checking functions
  function hasPermission(permission: string): boolean {
    if (permissions.value.includes('*')) return true
    return permissions.value.includes(permission)
  }

  function hasAnyPermission(...perms: string[]): boolean {
    return perms.some(p => hasPermission(p))
  }

  // Permission-based computed properties
  const canManageServer = computed(() => hasAnyPermission('server.start', 'server.stop'))
  const canRestartServer = computed(() => hasPermission('server.restart'))
  const canViewConsole = computed(() => hasPermission('console.view'))
  const canViewPerformance = computed(() => hasPermission('performance.view'))
  const canManagePlayers = computed(() => hasAnyPermission('players.view', 'players.kick', 'players.ban'))
  const canManageBackups = computed(() => hasPermission('backups.view'))
  const canManageConfig = computed(() => hasPermission('config.view'))

  // Actions
  function setTokens(access: string, refresh: string) {
    accessToken.value = access
    // Refresh token lives in an HttpOnly cookie now — keep it in memory
    // only so we can still send a body fallback to /api/auth/refresh if
    // the cookie was blocked, but don't persist it to localStorage where
    // any XSS could exfiltrate it.
    refreshToken.value = refresh
    setStorageItem('accessToken', access)
    removeStorageItem('refreshToken')
  }

  function setUser(name: string, userRole?: UserRole, userPermissions?: string[]) {
    username.value = name
    setStorageItem('username', name)
    if (userRole) {
      role.value = userRole
      setStorageItem('role', userRole)
    }
    if (userPermissions) {
      permissions.value = userPermissions
      setStorageItem('permissions', JSON.stringify(userPermissions))
    }
  }

  async function login(credentials: { username: string; password: string }) {
    const response = await authApi.login(credentials)
    setTokens(response.access_token, response.refresh_token)
    setUser(credentials.username, response.role as UserRole, response.permissions)
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

  // Completes an SSO login. The provider callback set an HttpOnly refresh
  // cookie (no token is exposed in the URL); exchange it for an access token
  // here, then load identity from /me. Called by Login.vue on ?sso=success.
  async function completeSsoLogin() {
    const tokens = await authApi.refresh('') // empty body → server reads the cookie
    setTokens(tokens.access_token, tokens.refresh_token || '')
    const me = await authApi.getMe() as { username: string; role?: UserRole; permissions?: string[] }
    setUser(me.username, me.role, me.permissions || [])
    return me
  }

  function logout(message?: string | null) {
    accessToken.value = null
    refreshToken.value = null
    username.value = null
    role.value = null
    permissions.value = []
    if (message) {
      logoutMessage.value = message
    }
    removeStorageItem('accessToken')
    removeStorageItem('refreshToken')
    removeStorageItem('username')
    removeStorageItem('role')
    removeStorageItem('permissions')
  }

  function consumeLogoutMessage(): string | null {
    const m = logoutMessage.value
    logoutMessage.value = null
    return m
  }

  return {
    // State
    accessToken,
    refreshToken,
    username,
    role,
    permissions,
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
    // Logout message
    logoutMessage,
    consumeLogoutMessage,
    // Actions
    setTokens,
    setUser,
    login,
    refresh,
    completeSsoLogin,
    logout,
    hasPermission,
    hasAnyPermission,
  }
})
