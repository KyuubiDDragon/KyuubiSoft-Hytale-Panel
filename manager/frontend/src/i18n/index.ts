import { createI18n } from 'vue-i18n'
import { intlTag } from '@/utils/intlTag'

export type Locale = 'de' | 'en' | 'pt_br'

export const LOCALES: readonly Locale[] = ['de', 'en', 'pt_br']
const DEFAULT_LOCALE: Locale = 'de'
// pt_br may lag behind; English is the universally understood stopgap
// (German text for Brazilian users was the older, worse default).
const FALLBACK_LOCALE: Locale = 'en'

// Each language is its own chunk: only the active one (plus the fallback,
// afterwards) is downloaded.
const loaders: Record<Locale, () => Promise<{ default: Record<string, unknown> }>> = {
  de: () => import('./de.json'),
  en: () => import('./en.json'),
  pt_br: () => import('./pt_br.json'),
}

function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value)
}

function savedLocale(): Locale {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('locale') : null
    return isLocale(stored) ? stored : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: savedLocale(),
  fallbackLocale: FALLBACK_LOCALE,
  messages: {},
})

const loaded = new Set<Locale>()

/** Fetches the messages of a language once. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (loaded.has(locale)) return
  const module = await loaders[locale]()
  i18n.global.setLocaleMessage(locale, module.default)
  loaded.add(locale)
}

/**
 * Loads the active language so the first render already has its texts, and
 * the fallback language in the background.
 */
export async function setupI18n(): Promise<void> {
  const active = i18n.global.locale.value as Locale
  document.documentElement.lang = intlTag(active)
  try {
    await loadLocale(active)
  } catch (error) {
    console.error('Failed to load the language files:', error)
  }
  if (active !== FALLBACK_LOCALE) void loadLocale(FALLBACK_LOCALE).catch(() => {})
}

export async function setLocale(locale: Locale): Promise<void> {
  await loadLocale(locale)
  i18n.global.locale.value = locale
  try {
    localStorage.setItem('locale', locale)
  } catch {
    // The choice only lasts for this visit.
  }
  document.documentElement.lang = intlTag(locale)
}

export function getLocale(): string {
  return i18n.global.locale.value
}
