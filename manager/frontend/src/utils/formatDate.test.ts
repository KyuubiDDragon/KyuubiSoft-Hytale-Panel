import { describe, expect, it } from 'vitest'
import { __testing, intlTag } from './formatDate'

const { formatWith, DATE_ONLY, TIME_ONLY } = __testing

describe('intlTag', () => {
  it('maps the panel language names to BCP 47', () => {
    expect(intlTag('pt_br')).toBe('pt-BR')
    expect(intlTag('de')).toBe('de')
    expect(intlTag('en')).toBe('en')
  })
})

describe('formatWith', () => {
  const noon = new Date(Date.UTC(2026, 9, 29, 12, 0, 0))

  it('follows the given language, not the environment', () => {
    const options = { ...DATE_ONLY, timeZone: 'UTC' }
    expect(formatWith('de', noon, options, '')).toBe('29.10.2026')
    expect(formatWith('en', noon, options, '')).toBe('Oct 29, 2026')
    expect(formatWith('pt_br', noon, options, '')).toMatch(/29/)
    expect(formatWith('pt_br', noon, options, '')).toMatch(/2026/)
  })

  it('formats times', () => {
    expect(formatWith('de', noon, { ...TIME_ONLY, timeZone: 'UTC' }, '')).toBe('12:00:00')
  })

  it('accepts ISO strings and timestamps', () => {
    const options = { ...DATE_ONLY, timeZone: 'UTC' }
    expect(formatWith('de', '2026-10-29T12:00:00Z', options, '')).toBe('29.10.2026')
    expect(formatWith('de', noon.getTime(), options, '')).toBe('29.10.2026')
  })

  it('gives back unreadable input instead of "Invalid Date"', () => {
    expect(formatWith('de', 'not a date', DATE_ONLY, '–')).toBe('not a date')
    expect(formatWith('de', null, DATE_ONLY, '–')).toBe('–')
    expect(formatWith('de', undefined, DATE_ONLY, '')).toBe('')
  })
})
