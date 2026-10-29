/**
 * Saving settings the game server owns (config.json, world configs and the
 * other files of the server folder).
 *
 * The running server keeps them in memory and writes its own copy back, so
 * the panel answers 409 `requiresRestart` when a change only takes effect at
 * the next start. saveWithRestartPrompt asks once and repeats the save with
 * a restart; saveErrorMessage turns the panel's other answers into a
 * message.
 */
import { useI18n } from 'vue-i18n'
import { useConfirm } from '@/composables/useConfirm'

export interface SaveRefusal {
  requiresRestart?: boolean
  reason?: string
  restartFields?: string[]
  liveFields?: string[]
  error?: string
  /** On 403: the rights the request lacked. */
  required?: string[]
}

function responseOf(e: unknown): { status?: number; data?: SaveRefusal } | undefined {
  return (e as { response?: { status?: number; data?: SaveRefusal } })?.response
}

export function useServerFileSave() {
  const { t } = useI18n()
  const { ask } = useConfirm()

  /**
   * Runs save(false); when the panel asks for a restart, confirms with the
   * user and runs save(true). Resolves to null when the user declined.
   */
  async function saveWithRestartPrompt<T>(
    save: (restart: boolean) => Promise<T>,
    fieldLabel: (field: string) => string = (f) => f,
  ): Promise<{ result: T; restarted: boolean } | null> {
    try {
      return { result: await save(false), restarted: false }
    } catch (e) {
      const data = responseOf(e)?.data
      if (responseOf(e)?.status !== 409 || !data?.requiresRestart) throw e
      const fields = (data.restartFields ?? []).map(fieldLabel).join(', ')
      const ok = await ask({
        title: t('serverFiles.restartTitle'),
        message:
          data.reason === 'live_unavailable'
            ? t('serverFiles.liveUnavailableConfirm')
            : fields
              ? t('serverFiles.restartConfirmFields', { fields })
              : t('serverFiles.restartConfirm'),
        confirmText: t('serverFiles.saveAndRestart'),
        variant: 'danger',
      })
      if (!ok) return null
      return { result: await save(true), restarted: true }
    }
  }

  function saveErrorMessage(e: unknown): string {
    // A timeout only means the page stopped waiting for the restart.
    if ((e as { code?: string })?.code === 'ECONNABORTED') return t('serverFiles.stillRunning')
    const res = responseOf(e)
    const detail = res?.data?.error ?? ''
    // "Save and restart" also needs the right to restart the server.
    if (res?.status === 403) {
      return res.data?.required?.includes('server.restart')
        ? t('serverFiles.restartForbidden')
        : t('serverFiles.forbidden')
    }
    switch (res?.data?.reason) {
      case 'not_confirmed':
        return t('serverFiles.notConfirmed', { detail })
      case 'lifecycle_busy':
        return t('serverFiles.busy')
      case 'invalid_json':
      case 'invalid_config':
      case 'unsafe_file':
        return t('serverFiles.rejected', { detail })
    }
    if (res?.status === 400 && detail) return t('serverFiles.rejected', { detail })
    return t('errors.serverError')
  }

  return { saveWithRestartPrompt, saveErrorMessage }
}
