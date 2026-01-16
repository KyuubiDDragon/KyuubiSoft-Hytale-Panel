import { createI18n } from 'vue-i18n'
import de from './de.json'
import en from './en.json'
import pt_br from './pt_br.json'

// Get saved language or default to German
const savedLocale = typeof localStorage !== 'undefined'
  ? localStorage.getItem('locale') || 'de'
  : 'de'

export const i18n = createI18n({
  legacy: false,
  locale: savedLocale,
  fallbackLocale: 'de',
  messages: {
    de,
    en,
    pt_br,
  },
})

export function setLocale(locale: 'de' | 'en' | 'pt_br') {
  i18n.global.locale.value = locale
  localStorage.setItem('locale', locale)
  document.documentElement.lang = locale
}

export function getLocale(): string {
  return i18n.global.locale.value
}
