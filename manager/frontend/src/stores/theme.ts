import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'kp-theme'

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const saved = localStorage.getItem(STORAGE_KEY) as Theme | null
  if (saved === 'dark' || saved === 'light') return saved
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyToDom(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.classList.toggle('light', theme === 'light')
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<Theme>(readInitial())

  // Apply immediately so we don't get a flash of the wrong theme on hot reload.
  applyToDom(theme.value)

  watch(theme, (next) => {
    applyToDom(next)
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, next)
  })

  function toggle(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  return { theme, toggle }
})
