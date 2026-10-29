import axios from 'axios'
import type { AxiosInstance, AxiosError } from 'axios'
import { useAuthStore } from '@/stores/auth'
import { useServersStore } from '@/stores/servers'
import { scopeUrl } from '@/utils/serverScope'
import type { LogoutReason } from '@/utils/logoutReason'

// Create axios instance.
// `withCredentials: true` makes the browser send the HttpOnly kp_refresh
// cookie back on /api/auth/refresh — the access token still rides as a
// Bearer header so XHR endpoints behind authMiddleware see it as before.
const api: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Create axios instance with extended timeout for long-running setup operations
export const setupApiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 120000, // 2 minutes for setup operations like server start
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Requests aimed at one server are cancelled together when the panel switches
// to another server, so a late answer of the old server never lands in the
// new server's view.
let scopedRequests = new AbortController()

export function abortScopedRequests(): void {
  scopedRequests.abort()
  scopedRequests = new AbortController()
}

// Request interceptor - add auth token and address the active server
api.interceptors.request.use(
  (config) => {
    const authStore = useAuthStore()
    if (authStore.accessToken) {
      config.headers.Authorization = `Bearer ${authStore.accessToken}`
    }
    if (typeof config.url === 'string') {
      const scoped = scopeUrl(config.url, useServersStore().scopeId)
      if (scoped !== config.url) {
        config.url = scoped
        if (!config.signal) config.signal = scopedRequests.signal
      }
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  },
)

// Add same interceptors to setupApiClient
setupApiClient.interceptors.request.use(
  (config) => {
    const authStore = useAuthStore()
    if (authStore.accessToken) {
      config.headers.Authorization = `Bearer ${authStore.accessToken}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  },
)

// ============================================================
// Single-flight token refresh
// ============================================================
// When a long-idle tab wakes up, every polling component fires at once and
// every request 401s simultaneously. Without coordination each of them would
// POST /api/auth/refresh on its own — tripping the server-side refresh rate
// limit (10/min) and kicking the user out even though their refresh token was
// perfectly valid. All callers therefore share one in-flight refresh promise.
let refreshPromise: Promise<string> | null = null

export function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    const authStore = useAuthStore()
    // Cookie is the primary path; in-memory token is the legacy body fallback
    // for installs where the HttpOnly cookie was blocked or not yet set.
    const payload = authStore.refreshToken ? { refresh_token: authStore.refreshToken } : {}
    refreshPromise = axios
      .post('/api/auth/refresh', payload, { withCredentials: true })
      .then((response) => {
        const { access_token, refresh_token } = response.data
        authStore.setTokens(access_token, refresh_token)
        return access_token as string
      })
      .finally(() => {
        refreshPromise = null
      })
  }
  return refreshPromise
}

/**
 * Returns true when a failed refresh means the session is genuinely dead
 * (server said the token is invalid/expired) as opposed to a transient
 * problem (network down, panel restarting, rate limit). Only the former
 * should force a logout — transient errors used to log people out for no
 * reason whenever the panel container restarted mid-poll.
 */
function isSessionDeadError(error: unknown): boolean {
  const status = (error as AxiosError)?.response?.status
  return status === 400 || status === 401 || status === 403
}

export function forceLogout(reason: LogoutReason = 'expired'): void {
  const authStore = useAuthStore()
  // Actively clear the HttpOnly refresh cookie too. Without this the dead
  // session's kp_refresh cookie would linger and could silently revive the
  // session on the next refresh — the reason users had to delete cookies by
  // hand. Fire-and-forget via fetch (not the axios client, to avoid the
  // interceptor looping on its own 401). The endpoint clears the cookie even
  // without a valid token.
  if (typeof fetch !== 'undefined') {
    void fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
  }
  authStore.logout(reason)
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.href = '/login'
  }
}

// The active server was deleted or taken away while the panel was open: every
// poll then fails with 404 / SERVER_NOT_ALLOWED. Reload the server list once;
// the store falls back to a server the account may still use.
let serverListRecheck: Promise<void> | null = null

function recheckServersOnLostScope(error: AxiosError<{ detail?: string; code?: string }>): void {
  const url = error.config?.url ?? ''
  if (!/^\/servers\/[^/?#]+\/./.test(url)) return
  const data = error.response?.data
  const lost =
    (error.response?.status === 404 && data?.detail === 'Server not found') ||
    (error.response?.status === 403 && data?.code === 'SERVER_NOT_ALLOWED')
  if (!lost || serverListRecheck) return
  serverListRecheck = useServersStore()
    .refresh()
    .catch(() => {})
    .finally(() => {
      serverListRecheck = null
    })
}

// Response interceptor - handle token refresh and forced logout.
// Applied to BOTH clients (the setup client previously had no 401 handling
// at all, so an expired token during a long setup step surfaced as a dead UI).
function attachAuthRefreshInterceptor(client: AxiosInstance): void {
  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError<{ detail?: string; code?: string }>) => {
      const originalRequest = error.config
      const authStore = useAuthStore()
      const responseData = error.response?.data

      // Check for token invalidation codes - immediate logout, no refresh attempt
      if (error.response?.status === 401) {
        const invalidationCodes = ['USER_DELETED', 'TOKEN_INVALIDATED']
        if (responseData?.code && invalidationCodes.includes(responseData.code)) {
          forceLogout(responseData.code === 'USER_DELETED' ? 'userDeleted' : 'tokenInvalidated')
          return Promise.reject(error)
        }
      }

      // 401 → try a refresh. We rely on the HttpOnly kp_refresh cookie (sent
      // automatically because withCredentials: true) and fall back to the
      // in-memory refresh token for installations that haven't picked up the
      // cookie flow yet.
      if (error.response?.status === 401 && originalRequest && !(originalRequest as any)._retry) {
        Object.assign(originalRequest, { _retry: true })
        const hadSession = !!authStore.accessToken

        try {
          const accessToken = await refreshAccessToken()

          // Retry original request
          originalRequest.headers.Authorization = `Bearer ${accessToken}`
          return client(originalRequest)
        } catch (refreshError) {
          // Only end the session when the server explicitly rejected the
          // refresh token — and only if there was a session to begin with
          // (unauthenticated setup-wizard calls must not bounce to /login).
          if (hadSession && isSessionDeadError(refreshError)) {
            forceLogout()
          }
          return Promise.reject(refreshError)
        }
      }

      recheckServersOnLostScope(error)
      return Promise.reject(error)
    },
  )
}

attachAuthRefreshInterceptor(api)
attachAuthRefreshInterceptor(setupApiClient)

export default api
