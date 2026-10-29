/** A device login the game container waits for (from `downloader/auth-status`). */
export interface PendingLogin {
  verificationUrl: string
  userCode: string | null
  /** When the container logged the prompt (ISO), if known. */
  shownAt: string | null
}

/** A device code lives 15 minutes, like the backend assumes. */
export const DEVICE_LOGIN_LIFETIME_MS = 15 * 60 * 1000

/** Expiry in epoch milliseconds; counts from `fallbackShownAt` when the log has no time. */
export function loginExpiry(login: PendingLogin, fallbackShownAt: number): number {
  const shown = login.shownAt ? Date.parse(login.shownAt) : NaN
  return (Number.isFinite(shown) ? shown : fallbackShownAt) + DEVICE_LOGIN_LIFETIME_MS
}
