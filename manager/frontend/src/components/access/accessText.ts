/**
 * Texts the access pages (whitelist, bans, permissions) show for the answers
 * of the access routes.
 */
import { accessError, type AccessWriteMeta } from '@/api/management'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** A refusal as a sentence the admin can act on; the server's own words go into it. */
export function accessErrorText(err: unknown, t: Translate): string {
  const { status, code, detail, required } = accessError(err)
  if (code) return t(`access.errors.${code}`, { detail: detail ?? '' })
  if (status === 403) {
    return required?.includes('players.op')
      ? t('access.errors.operatorRight')
      : t('access.errors.forbidden')
  }
  return detail || t('errors.serverError')
}

/** How a change that went through is reported: saved, unchanged, or sent but not confirmed. */
export function writeNotice(
  result: AccessWriteMeta,
  t: Translate,
): { type: 'success' | 'info' | 'warning'; text: string } {
  if (!result.verified) return { type: 'warning', text: t('access.notConfirmed') }
  if (!result.changed) return { type: 'info', text: t('access.unchanged') }
  return { type: 'success', text: t('access.saved') }
}
