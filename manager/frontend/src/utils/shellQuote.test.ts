import { describe, expect, it } from 'vitest'
import { shellQuote } from './shellQuote'

describe('shellQuote', () => {
  it('wraps a plain path in single quotes', () => {
    expect(shellQuote('/opt/hytale')).toBe("'/opt/hytale'")
  })

  it('keeps a path with spaces as one word', () => {
    expect(shellQuote('/srv/my data')).toBe("'/srv/my data'")
  })

  it('escapes a single quote inside the path', () => {
    expect(shellQuote("/srv/it's")).toBe("'/srv/it'\\''s'")
  })
})
