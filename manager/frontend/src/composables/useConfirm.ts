/**
 * useConfirm — Promise-based replacement for window.confirm.
 *
 * Returns a global `ask({title, message, variant, confirmText})` function
 * that resolves to `true` (confirmed) or `false` (cancelled / dismissed).
 * The matching `<ConfirmHost />` component must be mounted once in the
 * app shell (App.vue) so any view can call `await ask(...)` inline
 * without owning its own modal state.
 *
 * Replaces the per-view `pendingConfirm` ref pattern that crept into
 * SecuritySettings / Files / Webhooks / Replay / Roles. New code should
 * prefer this composable; existing per-view dialogs keep working.
 */
import { ref } from 'vue'

export type ConfirmVariant = 'danger' | 'primary'

export interface ConfirmOptions {
  title: string
  message: string
  variant?: ConfirmVariant
  confirmText?: string
  cancelText?: string
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

// Module-scoped state so any component can show / dismiss the dialog.
const pending = ref<PendingConfirm | null>(null)

export function useConfirm() {
  function ask(opts: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // If another dialog is already open, dismiss it as cancelled so we
      // don't stack — confirms are inherently modal.
      pending.value?.resolve(false)
      pending.value = { ...opts, resolve }
    })
  }
  function confirm() {
    const p = pending.value
    pending.value = null
    p?.resolve(true)
  }
  function cancel() {
    const p = pending.value
    pending.value = null
    p?.resolve(false)
  }
  return { ask, confirm, cancel, pending }
}
