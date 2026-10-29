import { describe, expect, it } from 'vitest'
import { translateServerWarning } from './serverWarnings'

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe('translateServerWarning', () => {
  it('translates the downloader hint', () => {
    const text =
      "The new server downloads the game files on its first start. The Hytale downloader needs a login for it: follow the link in the new server's console."
    expect(translateServerWarning(text, t)).toBe('servers.adm.hints.downloaderLogin')
  })

  it('translates the missing-files hint and keeps the folder', () => {
    const text =
      'The new server has no game files yet and the Hytale downloader is off (USE_HYTALE_DOWNLOADER). It waits until HytaleServer.jar and Assets.zip are in /srv/my data/server.'
    expect(translateServerWarning(text, t)).toBe(
      'servers.adm.hints.noGameFiles:{"dir":"/srv/my data/server"}',
    )
  })

  it('leaves other texts alone', () => {
    expect(translateServerWarning('Something else', t)).toBe('Something else')
  })
})
