/**
 * Command history of the console: the commands a user sent, per server, to
 * step through with the arrow keys. Pure helpers; storage is passed in.
 */

export const MAX_HISTORY = 100
// Every history key starts with this; the current ones add `v2.<account>.<server>`.
const ALL_KEYS_PREFIX = 'console.history.'
const KEY_PREFIX = `${ALL_KEYS_PREFIX}v2.`

export interface HistoryStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The history belongs to an account on a server; accounts sharing a browser do not see each other's. */
function storageKey(owner: string, serverId: string | null): string {
  return `${KEY_PREFIX}${encodeURIComponent(owner)}.${serverId ?? 'default'}`
}

/** Oldest first. A repeat of the newest entry is not added again. */
export function addToHistory(list: readonly string[], command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed || list[list.length - 1] === trimmed) return [...list]
  const next = [...list, trimmed]
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
}

export function loadHistory(
  storage: HistoryStorage | null,
  owner: string,
  serverId: string | null,
): string[] {
  if (!storage) return []
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(owner, serverId)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string').slice(-MAX_HISTORY)
  } catch {
    return []
  }
}

export function saveHistory(
  storage: HistoryStorage | null,
  owner: string,
  serverId: string | null,
  list: readonly string[],
): void {
  if (!storage) return
  try {
    storage.setItem(storageKey(owner, serverId), JSON.stringify(list))
  } catch {
    // Storage full or blocked: the history only lasts for this visit.
  }
}

function historyKeys(storage: HistoryStorage): string[] {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key?.startsWith(ALL_KEYS_PREFIX)) keys.push(key)
  }
  return keys
}

/** Removes the histories of every account and server (at sign-out). */
export function clearAllHistory(storage: HistoryStorage | null): void {
  if (!storage) return
  try {
    for (const key of historyKeys(storage)) storage.removeItem(key)
  } catch {
    // Nothing more to do without usable storage.
  }
}

/** Removes histories saved before they were kept per account (keyed by server only). */
export function removeLegacyHistory(storage: HistoryStorage | null): void {
  if (!storage) return
  try {
    for (const key of historyKeys(storage)) {
      if (!key.startsWith(KEY_PREFIX)) storage.removeItem(key)
    }
  } catch {
    // Nothing more to do without usable storage.
  }
}

export interface HistoryCursor {
  /** Position in the list, or null while the user types a fresh line. */
  index: number | null
  /** What the user had typed before stepping back. */
  draft: string
}

export interface HistoryStep {
  cursor: HistoryCursor
  /** Text for the input line. */
  text: string
}

export const FRESH_CURSOR: HistoryCursor = { index: null, draft: '' }

/** One step with the arrow keys: 'older' (up) or 'newer' (down). */
export function stepHistory(
  list: readonly string[],
  cursor: HistoryCursor,
  direction: 'older' | 'newer',
  current: string,
): HistoryStep {
  if (direction === 'older') {
    if (list.length === 0) return { cursor, text: current }
    if (cursor.index === null) {
      const index = list.length - 1
      return { cursor: { index, draft: current }, text: list[index] }
    }
    const index = Math.max(cursor.index - 1, 0)
    return { cursor: { ...cursor, index }, text: list[index] }
  }
  if (cursor.index === null) return { cursor, text: current }
  if (cursor.index >= list.length - 1) return { cursor: FRESH_CURSOR, text: cursor.draft }
  const index = cursor.index + 1
  return { cursor: { ...cursor, index }, text: list[index] }
}
