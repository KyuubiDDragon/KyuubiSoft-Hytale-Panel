import { describe, expect, it } from 'vitest'
import { rememberLogoutReason, takeLogoutReason, type ReasonStorage } from './logoutReason'

function memoryStorage(): ReasonStorage {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

describe('logout reason', () => {
  it('is handed to the login screen exactly once', () => {
    const storage = memoryStorage()
    rememberLogoutReason('expired', storage)
    expect(takeLogoutReason(storage)).toBe('expired')
    expect(takeLogoutReason(storage)).toBeNull()
  })

  it('ignores values it does not know', () => {
    const storage = memoryStorage()
    storage.setItem('logoutReason', 'something else')
    expect(takeLogoutReason(storage)).toBeNull()
    expect(storage.getItem('logoutReason')).toBeNull()
  })

  it('works without any storage', () => {
    expect(() => rememberLogoutReason('userDeleted', null)).not.toThrow()
    expect(takeLogoutReason(null)).toBeNull()
  })

  it('survives a storage that throws', () => {
    const broken: ReasonStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => rememberLogoutReason('expired', broken)).not.toThrow()
    expect(takeLogoutReason(broken)).toBeNull()
  })
})
