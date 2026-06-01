import { storeToRefs } from 'pinia'
import { useThemeStore } from '@/stores/theme'

export type Theme = 'light' | 'dark'

/**
 * Backwards-compatible composable that now delegates to the single Pinia theme
 * store (storage key `kp-theme`, toggles both `dark` and `light` classes on
 * <html>).
 *
 * It used to be a *second*, independent implementation (key `panel-theme`,
 * dark-only) that fought with the store: toggling the theme in the header
 * (this composable) did not update the command palette (the store) and vice
 * versa, and a reload could show a theme different from what was persisted.
 * One source of truth removes that whole class of bugs.
 */
export function useTheme() {
  const store = useThemeStore()
  const { theme } = storeToRefs(store)

  function toggle(): void {
    store.toggle()
  }
  function setTheme(t: Theme): void {
    store.theme = t
  }

  return { theme, toggle, setTheme }
}
