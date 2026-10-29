import { describe, expect, it } from 'vitest'
import { apiErrorMessage, isTransientFailure, readApiError } from './apiErrors'

const MESSAGES: Record<string, string> = {
  'apiErrors.ACCOUNT_TAKEN': 'Name vergeben.',
  'serverErrors.PORT_CONFLICT': 'Port belegt.',
  'errors.timeout': 'Zeitüberschreitung',
  'errors.connectionFailed': 'Verbindung fehlgeschlagen',
  'errors.forbidden': 'Nicht erlaubt',
  'errors.rateLimited': 'Zu viele Anfragen',
  'errors.unauthorized': 'Nicht angemeldet',
  'errors.notFound': 'Nicht gefunden',
  'errors.conflict': 'Konflikt',
  'errors.serverError': 'Serverfehler',
  'errors.unknown': 'Unbekannter Fehler',
}
const t = (key: string) => MESSAGES[key] ?? key
const te = (key: string) => key in MESSAGES

function httpError(
  status: number,
  data: unknown = {},
  message = `Request failed with status code ${status}`,
) {
  return Object.assign(new Error(message), { isAxiosError: true, response: { status, data } })
}

describe('apiErrorMessage', () => {
  it('uses the whole translation of a known code and drops the English text', () => {
    const err = httpError(400, {
      code: 'ACCOUNT_TAKEN',
      error: 'An account with this name already exists.',
    })
    expect(apiErrorMessage(err, t, te, 'fallback')).toBe('Name vergeben.')
  })

  it('appends the backend detail to a server error code', () => {
    const err = httpError(409, { code: 'PORT_CONFLICT', detail: 'in use by x' })
    expect(apiErrorMessage(err, t, te, 'fallback')).toBe('Port belegt. (in use by x)')
  })

  it('shows the backend text when it sent one', () => {
    expect(apiErrorMessage(httpError(400, { error: 'Name too short' }), t, te, 'fallback')).toBe(
      'Name too short',
    )
    expect(apiErrorMessage(httpError(400, { detail: 'Bad value' }), t, te, 'fallback')).toBe(
      'Bad value',
    )
  })

  it('never shows the HTTP client\'s own "Request failed" text', () => {
    expect(apiErrorMessage(httpError(409), t, te, 'Speichern fehlgeschlagen')).toBe(
      'Speichern fehlgeschlagen',
    )
    expect(apiErrorMessage(httpError(409), t, te, '')).toBe('Konflikt')
    expect(apiErrorMessage(httpError(500), t, te, '')).toBe('Serverfehler')
  })

  it('prefers the access and rate-limit wording over a generic fallback', () => {
    expect(apiErrorMessage(httpError(403), t, te, 'Speichern fehlgeschlagen')).toBe('Nicht erlaubt')
    expect(apiErrorMessage(httpError(429), t, te, 'Speichern fehlgeschlagen')).toBe(
      'Zu viele Anfragen',
    )
  })

  it('tells a timeout and a missing connection apart', () => {
    const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    })
    const offline = Object.assign(new Error('Network Error'), {
      isAxiosError: true,
      code: 'ERR_NETWORK',
    })
    expect(apiErrorMessage(timeout, t, te, 'fallback')).toBe('Zeitüberschreitung')
    expect(apiErrorMessage(offline, t, te, 'fallback')).toBe('Verbindung fehlgeschlagen')
  })

  it('keeps the message of an error that is not an HTTP failure', () => {
    expect(apiErrorMessage(new Error('Kaputt'), t, te, 'fallback')).toBe('Kaputt')
  })

  it('falls back to a general text for anything else', () => {
    expect(apiErrorMessage(undefined, t, te, '')).toBe('Unbekannter Fehler')
    expect(apiErrorMessage('boom', t, te, 'fallback')).toBe('fallback')
  })
})

describe('readApiError', () => {
  it('reads status, code and text from the response', () => {
    expect(readApiError(httpError(409, { code: 'X', error: 'y' }))).toMatchObject({
      status: 409,
      code: 'X',
      detail: 'y',
      noResponse: false,
    })
  })
})

describe('isTransientFailure', () => {
  it('counts a missing answer and server errors, not an answer', () => {
    const offline = Object.assign(new Error('Network Error'), { isAxiosError: true })
    const timeout = Object.assign(new Error('timeout'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    })
    expect(isTransientFailure(offline)).toBe(true)
    expect(isTransientFailure(timeout)).toBe(true)
    expect(isTransientFailure(httpError(502))).toBe(true)
    expect(isTransientFailure(httpError(404))).toBe(false)
    expect(isTransientFailure(httpError(403))).toBe(false)
    expect(isTransientFailure(new Error('plain'))).toBe(false)
  })
})
