import { describe, expect, it } from 'vitest'
import {
  FRESH_CURSOR,
  MAX_HISTORY,
  addToHistory,
  clearAllHistory,
  loadHistory,
  removeLegacyHistory,
  saveHistory,
  stepHistory,
  type HistoryStorage,
} from './commandHistory'

function memoryStorage(initial: Record<string, string> = {}): HistoryStorage & {
  keys: () => string[]
} {
  const data = new Map(Object.entries(initial))
  return {
    get length() {
      return data.size
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    keys: () => [...data.keys()],
  }
}

describe('addToHistory', () => {
  it('appends the newest command last and leaves the old list alone', () => {
    const before = ['a']
    expect(addToHistory(before, 'b')).toEqual(['a', 'b'])
    expect(before).toEqual(['a'])
  })

  it('skips empty input and a repeat of the newest entry', () => {
    expect(addToHistory(['a'], '   ')).toEqual(['a'])
    expect(addToHistory(['a'], 'a')).toEqual(['a'])
    expect(addToHistory(['a', 'b'], 'a')).toEqual(['a', 'b', 'a'])
  })

  it('keeps at most MAX_HISTORY entries, dropping the oldest', () => {
    const full = Array.from({ length: MAX_HISTORY }, (_, i) => `c${i}`)
    const next = addToHistory(full, 'new')
    expect(next).toHaveLength(MAX_HISTORY)
    expect(next[0]).toBe('c1')
    expect(next[MAX_HISTORY - 1]).toBe('new')
  })
})

describe('histories per account', () => {
  it('keeps the history of one account from another', () => {
    const storage = memoryStorage()
    saveHistory(storage, 'alice', 'one', ['/secret'])
    expect(loadHistory(storage, 'alice', 'one')).toEqual(['/secret'])
    expect(loadHistory(storage, 'bob', 'one')).toEqual([])
  })

  it('removes every history at sign-out, other keys stay', () => {
    const storage = memoryStorage({ locale: 'de', 'console.history.main': '["old"]' })
    saveHistory(storage, 'alice', 'one', ['/a'])
    saveHistory(storage, 'bob', 'two', ['/b'])
    clearAllHistory(storage)
    expect(storage.keys()).toEqual(['locale'])
  })

  it('removes histories of the old per-server layout only', () => {
    const storage = memoryStorage({ 'console.history.main': '["old"]', other: 'x' })
    saveHistory(storage, 'alice', 'main', ['/a'])
    removeLegacyHistory(storage)
    expect(storage.keys().sort()).toEqual(['console.history.v2.alice.main', 'other'])
  })

  it('does nothing without storage', () => {
    expect(() => clearAllHistory(null)).not.toThrow()
    expect(() => removeLegacyHistory(null)).not.toThrow()
  })
})

describe('loadHistory / saveHistory', () => {
  it('keeps one history per server', () => {
    const storage = memoryStorage()
    saveHistory(storage, 'me', 'one', ['/list'])
    saveHistory(storage, 'me', 'two', ['/stop'])
    expect(loadHistory(storage, 'me', 'one')).toEqual(['/list'])
    expect(loadHistory(storage, 'me', 'two')).toEqual(['/stop'])
    expect(loadHistory(storage, 'me', null)).toEqual([])
  })

  it('ignores damaged or foreign data', () => {
    const key = 'console.history.v2.me.a'
    expect(loadHistory(memoryStorage({ [key]: '{oops' }), 'me', 'a')).toEqual([])
    expect(loadHistory(memoryStorage({ [key]: '{"x":1}' }), 'me', 'a')).toEqual([])
    expect(loadHistory(memoryStorage({ [key]: '["ok",5,null]' }), 'me', 'a')).toEqual(['ok'])
    expect(loadHistory(null, 'me', 'a')).toEqual([])
  })

  it('survives a storage that refuses to write', () => {
    const broken: HistoryStorage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => saveHistory(broken, 'me', 'a', ['x'])).not.toThrow()
  })
})

describe('stepHistory', () => {
  const list = ['one', 'two', 'three']

  it('walks back to the oldest entry and stays there', () => {
    let step = stepHistory(list, FRESH_CURSOR, 'older', 'typing')
    expect(step.text).toBe('three')
    step = stepHistory(list, step.cursor, 'older', step.text)
    expect(step.text).toBe('two')
    step = stepHistory(list, step.cursor, 'older', step.text)
    step = stepHistory(list, step.cursor, 'older', step.text)
    expect(step.text).toBe('one')
  })

  it('returns to the unsent text after the newest entry', () => {
    let step = stepHistory(list, FRESH_CURSOR, 'older', 'half a comm')
    step = stepHistory(list, step.cursor, 'newer', step.text)
    step = stepHistory(list, step.cursor, 'newer', step.text)
    step = stepHistory(list, step.cursor, 'newer', step.text)
    expect(step.text).toBe('half a comm')
    expect(step.cursor).toEqual(FRESH_CURSOR)
  })

  it('does nothing without history or while typing fresh text', () => {
    expect(stepHistory([], FRESH_CURSOR, 'older', 'x').text).toBe('x')
    expect(stepHistory(list, FRESH_CURSOR, 'newer', 'x').text).toBe('x')
  })
})
