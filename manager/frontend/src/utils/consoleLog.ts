/** Plain-text export of console entries. */

export interface ExportableEntry {
  timestamp: string
  level: string
  message: string
  logger?: string
  reply?: { pending: boolean; lines: string[]; error?: string }
}

/** One line per entry (`[time] LEVEL [logger] message`), a command's answer indented below it. */
export function formatLogForDownload(entries: readonly ExportableEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    const level = (entry.level || 'INFO').toUpperCase()
    const logger = entry.logger ? ` [${entry.logger}]` : ''
    lines.push(`[${entry.timestamp}] ${level}${logger} ${entry.message}`)
    if (entry.reply && !entry.reply.pending) {
      for (const line of entry.reply.lines) lines.push(`    ${line}`)
      if (entry.reply.error && !entry.reply.lines.includes(entry.reply.error)) {
        lines.push(`    ${entry.reply.error}`)
      }
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** File name for the export, e.g. `console-main-2026-10-29T12-00-00.txt`. */
export function logFileName(serverId: string | null, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const server = (serverId ?? 'server').replace(/[^A-Za-z0-9_-]/g, '_')
  return `console-${server}-${stamp}.txt`
}
