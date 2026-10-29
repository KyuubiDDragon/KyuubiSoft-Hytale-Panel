/**
 * Dates and numbers in the language chosen in the panel, not the browser's.
 * (`toLocaleString()` without a locale follows the browser, so a German panel
 * in an English browser showed US dates.)
 */
import { i18n } from '@/i18n'
import { intlTag } from './intlTag'

export { intlTag }

type DateInput = string | number | Date | null | undefined

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'medium' }
const DATE_ONLY: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }
const TIME_ONLY: Intl.DateTimeFormatOptions = { timeStyle: 'medium' }

function formatWith(
  locale: string,
  value: DateInput,
  options: Intl.DateTimeFormatOptions,
  empty: string,
): string {
  const date = toDate(value)
  if (!date) return typeof value === 'string' ? value || empty : empty
  return new Intl.DateTimeFormat(intlTag(locale), options).format(date)
}

/** Reading `i18n.global.locale` inside a render function keeps the text reactive to language changes. */
function currentLocale(): string {
  return i18n.global.locale.value
}

export function formatDateTime(value: DateInput, empty = ''): string {
  return formatWith(currentLocale(), value, DATE_TIME, empty)
}

export function formatDate(value: DateInput, empty = ''): string {
  return formatWith(currentLocale(), value, DATE_ONLY, empty)
}

export function formatTime(value: DateInput, empty = ''): string {
  return formatWith(currentLocale(), value, TIME_ONLY, empty)
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(intlTag(currentLocale())).format(value)
}

export const __testing = { formatWith, DATE_TIME, DATE_ONLY, TIME_ONLY }
