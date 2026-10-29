import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()

vi.mock('./client', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

import { healthApi } from './health'

const HEALTHY = { ok: true, issues: [] }

function answer(routes: Record<string, unknown>) {
  get.mockImplementation(async (url: string) => {
    const hit = routes[url]
    if (hit instanceof Error) throw hit
    if (hit === undefined) throw new Error(`unexpected GET ${url}`)
    return { data: hit }
  })
}

const failure = (status: number) =>
  Object.assign(new Error(`status ${status}`), { response: { status } })
const asked = () => get.mock.calls.map((call) => call[0])

beforeEach(() => {
  get.mockReset()
})

// The folder check names the compose server's folders: the panel answers it
// only for settings.view and access to every server.
describe('checkPermissionsIfAllowed', () => {
  it('asks nothing without settings.view', async () => {
    answer({})
    expect(await healthApi.checkPermissionsIfAllowed(['server.view_status'])).toBeNull()
    expect(asked()).toEqual([])
  })

  it('asks nothing more for an account limited to some servers', async () => {
    answer({ '/auth/me/servers': { allowedServers: ['a'], unrestricted: false } })
    expect(await healthApi.checkPermissionsIfAllowed(['settings.view'])).toBeNull()
    expect(asked()).toEqual(['/auth/me/servers'])
  })

  it('checks for settings.view with access to every server', async () => {
    answer({
      '/auth/me/servers': { allowedServers: null, unrestricted: true },
      '/health/permissions': HEALTHY,
    })
    expect(await healthApi.checkPermissionsIfAllowed(['settings.view'])).toEqual(HEALTHY)
  })

  it('checks right away for an admin, who has every server', async () => {
    answer({ '/health/permissions': HEALTHY })
    expect(await healthApi.checkPermissionsIfAllowed(['*'])).toEqual(HEALTHY)
    expect(asked()).toEqual(['/health/permissions'])
  })

  it('stays silent when the panel refuses the check', async () => {
    answer({ '/health/permissions': failure(403) })
    expect(await healthApi.checkPermissionsIfAllowed(['*'])).toBeNull()
  })

  it('passes other failures on', async () => {
    answer({ '/health/permissions': failure(500) })
    await expect(healthApi.checkPermissionsIfAllowed(['*'])).rejects.toThrow('status 500')
  })
})
