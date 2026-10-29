/**
 * Readable messages for failed API calls.
 *
 * The backend answers with `{ detail | error, code }`. Codes the panel knows
 * have a translation under `serverErrors.<CODE>`; anything else falls back to
 * the text the backend sent.
 */

type Translate = (key: string, params?: Record<string, unknown>) => string
type Exists = (key: string) => boolean

export interface ApiErrorInfo {
  status?: number
  code?: string
  detail: string
}

export function readApiError(err: unknown): ApiErrorInfo {
  const response = (
    err as {
      response?: { status?: number; data?: { detail?: string; error?: string; code?: string } }
    }
  )?.response
  const data = response?.data
  return {
    status: response?.status,
    code: typeof data?.code === 'string' ? data.code : undefined,
    detail: data?.detail || data?.error || (err instanceof Error ? err.message : ''),
  }
}

/**
 * Message for the user: the translation of a known code, followed by the
 * backend's own text when that adds something (a port owner, a path).
 */
export function apiErrorMessage(err: unknown, t: Translate, te: Exists, fallback: string): string {
  const { code, detail } = readApiError(err)
  if (code && te(`serverErrors.${code}`)) {
    const text = t(`serverErrors.${code}`)
    return detail && detail !== text ? `${text} (${detail})` : text
  }
  return detail || fallback
}
