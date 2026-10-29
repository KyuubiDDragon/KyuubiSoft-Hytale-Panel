/**
 * Readable messages for failed API calls.
 *
 * The backend answers with `{ detail | error, code }`. Codes the panel knows
 * have a translation under `apiErrors.<CODE>` (the whole message) or
 * `serverErrors.<CODE>` (followed by the backend's detail); anything else falls back to
 * the text the backend sent, then to a message for the kind of failure.
 * axios' own "Request failed with status code 409" is never shown.
 */
import { i18n } from '@/i18n'

type Translate = (key: string, params?: Record<string, unknown>) => string
type Exists = (key: string) => boolean

export interface ApiErrorInfo {
  status?: number
  code?: string
  /** Text the backend sent; empty when it sent none. */
  detail: string
  /** The request never got an answer (offline, refused, timed out). */
  noResponse: boolean
  timedOut: boolean
}

interface ErrorLike {
  isAxiosError?: boolean
  code?: string
  message?: string
  response?: { status?: number; data?: { detail?: unknown; error?: unknown; code?: unknown } }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readApiError(err: unknown): ApiErrorInfo {
  const e = (err ?? {}) as ErrorLike
  const data = e.response?.data
  return {
    status: e.response?.status,
    code: typeof data?.code === 'string' ? data.code : undefined,
    // Errors that are not the HTTP client's keep their own message.
    detail:
      text(data?.detail) ||
      text(data?.error) ||
      (!e.isAxiosError && err instanceof Error ? err.message : ''),
    noResponse: !!e.isAxiosError && !e.response,
    timedOut: e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT',
  }
}

/**
 * The failure says nothing about the thing asked for: no answer at all (offline,
 * refused, timed out) or a server error. A 404 or 4xx is an answer.
 */
export function isTransientFailure(err: unknown): boolean {
  const info = readApiError(err)
  return info.noResponse || info.timedOut || (info.status !== undefined && info.status >= 500)
}

/** Message for a status the panel has a general wording for. */
function statusKey(status: number | undefined): string | null {
  if (status === 401) return 'errors.unauthorized'
  if (status === 403) return 'errors.forbidden'
  if (status === 404) return 'errors.notFound'
  if (status === 409) return 'errors.conflict'
  if (status === 429) return 'errors.rateLimited'
  if (status !== undefined && status >= 500) return 'errors.serverError'
  return null
}

/**
 * Message for the user: the translation of a known code, followed by the
 * backend's own text when that adds something (a port owner, a path).
 */
export function apiErrorMessage(err: unknown, t: Translate, te: Exists, fallback: string): string {
  const info = readApiError(err)
  // Codes whose translation says it all: the backend's English text is not appended.
  if (info.code && te(`apiErrors.${info.code}`)) return t(`apiErrors.${info.code}`)
  if (info.code && te(`serverErrors.${info.code}`)) {
    const known = t(`serverErrors.${info.code}`)
    return info.detail && info.detail !== known ? `${known} (${info.detail})` : known
  }
  if (info.detail) return info.detail
  if (info.timedOut) return t('errors.timeout')
  if (info.noResponse) return t('errors.connectionFailed')
  // Access and rate-limit answers say more than a generic "could not save".
  if (info.status === 403 || info.status === 429 || info.status === 401) {
    return t(statusKey(info.status) as string)
  }
  if (fallback) return fallback
  const key = statusKey(info.status)
  return t(key ?? 'errors.unknown')
}

/** `apiErrorMessage` in the panel's current language. */
export function getApiErrorMessage(err: unknown, fallback = ''): string {
  const { t, te } = i18n.global
  return apiErrorMessage(err, (key, params) => t(key, params ?? {}), te, fallback)
}
