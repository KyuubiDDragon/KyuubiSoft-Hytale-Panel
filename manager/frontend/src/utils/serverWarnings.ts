/**
 * Hints the backend returns after creating a server are English sentences.
 * The two that every new server gets are shown in the panel language; any
 * other text is shown as it came.
 */

type Translate = (key: string, params?: Record<string, unknown>) => string

const DOWNLOADS_ON_FIRST_START = /^The new server downloads the game files on its first start\./
const NO_GAME_FILES = /^The new server has no game files yet\b.*\bin (.+)\.$/

export function translateServerWarning(text: string, t: Translate): string {
  if (DOWNLOADS_ON_FIRST_START.test(text)) return t('servers.adm.hints.downloaderLogin')
  const noFiles = NO_GAME_FILES.exec(text)
  if (noFiles) return t('servers.adm.hints.noGameFiles', { dir: noFiles[1] })
  return text
}
