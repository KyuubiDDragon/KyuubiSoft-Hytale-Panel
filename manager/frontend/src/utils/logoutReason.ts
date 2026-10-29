/**
 * Why the panel signed someone out. The sign-out ends in a full page load of
 * the login screen, so the reason travels in sessionStorage; the login screen
 * takes it once and shows the matching text (`auth.logoutReason.<reason>`).
 */

export const LOGOUT_REASONS = ['expired', 'userDeleted', 'tokenInvalidated'] as const
export type LogoutReason = (typeof LOGOUT_REASONS)[number]

const STORAGE_KEY = 'logoutReason'

export interface ReasonStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): ReasonStorage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

function isReason(value: string | null): value is LogoutReason {
  return !!value && (LOGOUT_REASONS as readonly string[]).includes(value)
}

export function rememberLogoutReason(
  reason: LogoutReason,
  storage: ReasonStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, reason)
  } catch {
    // Without storage the login screen simply shows no reason.
  }
}

/** The remembered reason, once: reading it clears it. */
export function takeLogoutReason(
  storage: ReasonStorage | null = browserStorage(),
): LogoutReason | null {
  if (!storage) return null
  try {
    const value = storage.getItem(STORAGE_KEY)
    storage.removeItem(STORAGE_KEY)
    return isReason(value) ? value : null
  } catch {
    return null
  }
}
