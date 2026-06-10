import { onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { authApi } from '@/api/auth'
import { refreshAccessToken, forceLogout } from '@/api/client'
import type { UserRole } from '@/stores/auth'

/**
 * Keeps the displayed auth state truthful AND current.
 *
 * Two failure modes this guards against:
 *
 *  1. **Stale token** — the access token only lives 15 minutes, but
 *     `isAuthenticated` is derived from localStorage, so a tab asleep for hours
 *     happily renders "logged in" while every call would 401. We proactively
 *     refresh before expiry (and log out cleanly if the refresh is rejected).
 *
 *  2. **Stale identity** — role + permissions used to be cached at login and
 *     never refreshed, while the cookie-based silent refresh kept the session
 *     alive indefinitely. So after a role change (or a degraded first login)
 *     the UI was stuck on outdated permissions — looking like a read-only
 *     "viewer" — and the only escape was deleting the refresh cookie. We now
 *     re-sync identity from `/me` on every app start and tab re-focus, so the
 *     displayed permissions always match the server.
 *
 * Triggers: app start, tab becomes visible / window focus, back online, and a
 * slow interval (token freshness only) while the tab is active.
 */

const EXPIRY_SLACK_MS = 60_000 // refresh when less than 1 min of validity left
const CHECK_INTERVAL_MS = 60_000

function tokenNeedsRefresh(token: string): boolean {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(base64)) as { exp?: number }
    if (typeof payload.exp !== 'number') return false
    return payload.exp * 1000 - Date.now() < EXPIRY_SLACK_MS
  } catch {
    // Unreadable token — treat as expired so it gets replaced or cleared.
    return true
  }
}

export function useSessionGuard() {
  const authStore = useAuthStore()
  let checkTimer: ReturnType<typeof setInterval> | null = null

  async function ensureFreshSession(): Promise<void> {
    if (!authStore.accessToken) return
    if (!tokenNeedsRefresh(authStore.accessToken)) return

    try {
      await refreshAccessToken()
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status
      if (status === 400 || status === 401 || status === 403) {
        forceLogout()
      }
      // No response (offline / panel restarting): keep the session, the next
      // trigger or the axios interceptor will retry.
    }
  }

  // Pull the authoritative identity (role + permissions) from the server so a
  // long-lived session can never drift onto stale/limited permissions. A 401
  // here is handled by the axios interceptor (refresh + retry, or logout); we
  // swallow other errors so an offline blip leaves the cached identity intact.
  async function syncIdentity(): Promise<void> {
    if (!authStore.accessToken) return
    try {
      const me = await authApi.getMe()
      if (me?.username) {
        // Never downgrade to an EMPTY permission set: a real account always has
        // at least one permission (or '*'), so an empty array signals a
        // transient/edge backend state — not a legitimate "no access" user.
        // Passing undefined makes setUser keep the existing (good) permissions
        // instead of persisting an empty set that would lock the UI into a
        // permission-less "viewer" across reloads.
        const perms = Array.isArray(me.permissions) && me.permissions.length > 0
          ? me.permissions
          : undefined
        authStore.setUser(me.username, me.role as UserRole | undefined, perms)
      }
    } catch {
      /* interceptor handles auth failures; ignore transient errors */
    }
  }

  async function refreshAndSync(): Promise<void> {
    if (!authStore.accessToken) return
    await ensureFreshSession()
    if (!authStore.accessToken) return // logged out during refresh
    await syncIdentity()
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      void refreshAndSync()
    }
  }

  function onFocusOrOnline(): void {
    void refreshAndSync()
  }

  onMounted(() => {
    void refreshAndSync()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocusOrOnline)
    window.addEventListener('online', onFocusOrOnline)
    // The interval only keeps the token fresh; identity is re-synced on the
    // boot/focus triggers above, which is enough to catch role changes.
    checkTimer = setInterval(() => void ensureFreshSession(), CHECK_INTERVAL_MS)
  })

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('focus', onFocusOrOnline)
    window.removeEventListener('online', onFocusOrOnline)
    if (checkTimer) {
      clearInterval(checkTimer)
      checkTimer = null
    }
  })

  return { ensureFreshSession, syncIdentity }
}
