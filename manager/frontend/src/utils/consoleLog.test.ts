import { describe, expect, it } from 'vitest'
import { formatLogForDownload, logFileName } from './consoleLog'

describe('formatLogForDownload', () => {
  it('writes one line per entry with level and logger', () => {
    const text = formatLogForDownload([
      { timestamp: '2026-10-29T10:00:00Z', level: 'info', message: 'Booted' },
      { timestamp: '2026-10-29T10:00:01Z', level: 'WARN', logger: 'World', message: 'Slow tick' },
    ])
    expect(text).toBe(
      '[2026-10-29T10:00:00Z] INFO Booted\n[2026-10-29T10:00:01Z] WARN [World] Slow tick\n',
    )
  })

  it('indents the answer of a command below it', () => {
    const text = formatLogForDownload([
      {
        timestamp: 't',
        level: 'INFO',
        message: '> list',
        reply: { pending: false, lines: ['2 players'], error: 'nope' },
      },
      { timestamp: 't', level: 'INFO', message: '> wait', reply: { pending: true, lines: ['x'] } },
    ])
    expect(text).toBe('[t] INFO > list\n    2 players\n    nope\n[t] INFO > wait\n')
  })

  it('is empty without entries', () => {
    expect(formatLogForDownload([])).toBe('')
  })
})

describe('logFileName', () => {
  it('has no characters a file system dislikes', () => {
    const name = logFileName('my server/1', new Date('2026-10-29T12:00:00Z'))
    expect(name).toBe('console-my_server_1-2026-10-29T12-00-00.txt')
    expect(logFileName(null, new Date('2026-10-29T12:00:00Z'))).toBe(
      'console-server-2026-10-29T12-00-00.txt',
    )
  })
})
