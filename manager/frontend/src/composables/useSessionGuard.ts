import { onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { refreshAccessToken, forceLogout } from '@/api/client'

/**
 * Keeps the displayed auth state truthful.
 *
 * The access token only lives 15 minutes, but `isAuthenticated` is derived
 * from localStorage — so a tab that was hidden/asleep for hours (or a page
 * restored after the browser discarded it) happily renders "logged in as X"
 * while every API call would fail. This guard proactively validates the
 * session whenever it might have gone stale:
 *
 *  - on app start (covers reloads & restored/discarded tabs)
 *  - when the tab becomes visible again / window regains focus
 *  - when the browser comes back online
 *  - on a slow interval while the tab is active (refreshes shortly before
 *    expiry so WebSocket tickets and background polls never hit a dead token)
 *
 * If the server rejects the refresh, the user is logged out cleanly with a
 * message on the login screen — instead of being stranded on a dead page.
 * Transient failures (network blip, panel restart) keep the session and are
 * retried on the next trigger.
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

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      void ensureFreshSession()
    }
  }

  function onFocusOrOnline(): void {
    void ensureFreshSession()
  }

  onMounted(() => {
    void ensureFreshSession()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocusOrOnline)
    window.addEventListener('online', onFocusOrOnline)
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

  return { ensureFreshSession }
}
