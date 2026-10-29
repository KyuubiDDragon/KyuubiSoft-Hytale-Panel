/**
 * Keyboard behaviour of a modal dialog: focus moves into it when it opens,
 * Tab stays inside, Escape asks to close it, and focus returns to whatever had
 * it before. With dialogs stacked, only the top one reacts.
 */
import { nextTick, watch, type Ref } from 'vue'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Open dialogs, oldest first.
const openDialogs: object[] = []

export function useFocusTrap(
  dialogRef: Ref<HTMLElement | null>,
  isOpen: () => boolean,
  onEscape: () => void,
): void {
  const token = {}

  function focusable(): HTMLElement[] {
    return dialogRef.value
      ? Array.from(dialogRef.value.querySelectorAll<HTMLElement>(FOCUSABLE))
      : []
  }

  function onKeydown(e: KeyboardEvent): void {
    if (openDialogs[openDialogs.length - 1] !== token) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
      return
    }
    if (e.key !== 'Tab') return
    const items = focusable()
    if (items.length === 0) {
      e.preventDefault()
      dialogRef.value?.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && (active === first || !dialogRef.value?.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !dialogRef.value?.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  // The cleanup comes from the watcher's onCleanup argument: a function
  // returned from the callback is not a cleanup and would leak a listener.
  watch(
    isOpen,
    async (open, _previous, onCleanup) => {
      if (!open) return
      const previouslyFocused = document.activeElement as HTMLElement | null
      openDialogs.push(token)
      document.addEventListener('keydown', onKeydown)
      onCleanup(() => {
        document.removeEventListener('keydown', onKeydown)
        const at = openDialogs.indexOf(token)
        if (at >= 0) openDialogs.splice(at, 1)
        previouslyFocused?.focus?.()
      })
      await nextTick()
      ;(focusable()[0] ?? dialogRef.value)?.focus()
    },
    { immediate: true },
  )
}
