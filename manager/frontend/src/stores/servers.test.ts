import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const get = vi.fn()
const abortScopedRequests = vi.fn()

vi.mock('@/api/client', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  abortScopedRequests: () => abortScopedRequests(),
}))

import { useServersStore, displayState, type ServerInstance } from './servers'
import { useConsoleStore } from './console'

function server(id: string, extra: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id,
    name: id,
    containerName: `c-${id}`,
    status: 'ready',
    network: { serverPort: 5520, webMapPort: 0, webMapWsPort: 0 },
    paths: { server: '', data: '', backups: '', mods: '', plugins: '', assets: '', auth: '' },
    createdAt: '',
    createdBy: '',
    ...extra,
  }
}

function answer(routes: Record<string, unknown>) {
  get.mockImplementation(async (url: string) => {
    const hit = routes[url]
    if (hit instanceof Error) throw hit
    if (hit === undefined) throw new Error(`unexpected GET ${url}`)
    return { data: hit }
  })
}

function forbidden(): Error {
  return Object.assign(new Error('forbidden'), { response: { status: 403 } })
}

const list = (ids: string[], defaultId: string, multiserverEnabled = true) => ({
  servers: ids.map((id) => server(id)),
  defaultId,
  multiserverEnabled,
})

beforeEach(() => {
  setActivePinia(createPinia())
  get.mockReset()
  abortScopedRequests.mockReset()
  const items: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items[k] ?? null,
    setItem: (k: string, v: string) => {
      items[k] = v
    },
  })
})

describe('servers store scope', () => {
  it('uses legacy URLs while multiserver is off', async () => {
    answer({ '/servers': list(['default'], 'default', false) })
    const store = useServersStore()
    await store.init()
    expect(store.scopeId).toBeNull()
    expect(store.pickerVisible).toBe(false)
  })

  it('scopes to the remembered server and shows the picker', async () => {
    localStorage.setItem('kp-active-server-id', 'b')
    answer({ '/servers': list(['a', 'b'], 'a') })
    const store = useServersStore()
    await store.init()
    expect(store.scopeId).toBe('b')
    expect(store.pickerVisible).toBe(true)
  })

  it('falls back to the first allowed server when the default is not in the list', async () => {
    answer({ '/servers': list(['b', 'c'], 'a') })
    const store = useServersStore()
    await store.init()
    expect(store.activeId).toBe('b')
    expect(store.scopeId).toBe('b')
  })

  it('without servers.list takes the ids from the own access and hides the picker', async () => {
    answer({
      '/servers': forbidden(),
      '/auth/me/servers': { allowedServers: ['x', 'y'], unrestricted: false },
    })
    const store = useServersStore()
    await store.init()
    expect(store.canList).toBe(false)
    expect(store.pickerVisible).toBe(false)
    expect(store.scopeId).toBe('x')
  })

  it('without servers.list and without a restriction stays on legacy URLs', async () => {
    answer({
      '/servers': forbidden(),
      '/auth/me/servers': { allowedServers: null, unrestricted: true },
    })
    const store = useServersStore()
    await store.init()
    expect(store.scopeId).toBeNull()
  })

  it('still lets the app start when the list cannot be loaded', async () => {
    answer({ '/servers': new Error('network') })
    const store = useServersStore()
    await store.init()
    expect(store.loaded).toBe(true)
    expect(store.scopeId).toBeNull()
  })
})

describe('switching servers', () => {
  async function twoServers() {
    answer({ '/servers': list(['a', 'b'], 'a') })
    const store = useServersStore()
    await store.init()
    return store
  }

  it('resets view stores, cancels requests and bumps the epoch', async () => {
    const store = await twoServers()
    const consoleStore = useConsoleStore()
    consoleStore.addLog({ timestamp: 't', level: 'INFO', message: 'from A' })
    consoleStore.addServerEntries([
      { timestamp: 't', level: 'INFO', message: 'm', stream: 'stdout', cursor: '99' } as never,
    ])
    const epoch = store.epoch

    store.setActive('b')

    expect(store.scopeId).toBe('b')
    expect(store.epoch).toBe(epoch + 1)
    expect(abortScopedRequests).toHaveBeenCalledTimes(1)
    expect(consoleStore.logs).toHaveLength(0)
    // The cursor of A must not hide B's history.
    consoleStore.addServerEntries(
      [{ timestamp: 't', level: 'INFO', message: 'B', stream: 'stdout', cursor: '5' } as never],
      true,
    )
    expect(consoleStore.logs).toHaveLength(1)
  })

  it('ignores the already active and unknown servers', async () => {
    const store = await twoServers()
    const epoch = store.epoch
    store.setActive('a')
    store.setActive('nope')
    expect(store.epoch).toBe(epoch)
    expect(abortScopedRequests).not.toHaveBeenCalled()
  })

  it('moves on when a refresh drops the active server', async () => {
    const store = await twoServers()
    store.setActive('b')
    abortScopedRequests.mockClear()
    answer({ '/servers': list(['a'], 'a') })
    await store.refresh()
    expect(store.scopeId).toBe('a')
    expect(abortScopedRequests).toHaveBeenCalledTimes(1)
  })

  it('forgets everything on reset', async () => {
    const store = await twoServers()
    store.reset()
    expect(store.loaded).toBe(false)
    expect(store.servers).toHaveLength(0)
    expect(store.scopeId).toBeNull()
  })
})

describe('run state', () => {
  it('reports the real state of every server and unknown on failure', async () => {
    answer({
      '/servers': list(['a', 'b', 'c'], 'a'),
      '/servers/a/server/status': { running: true },
      '/servers/b/server/status': { running: false },
      '/servers/c/server/status': new Error('no access'),
    })
    const store = useServersStore()
    await store.init()
    await store.refreshRunStates()
    expect(store.runStates).toEqual({ a: 'running', b: 'stopped', c: 'unknown' })
  })

  it('shows registry problems before the run state', () => {
    expect(displayState(server('a'), 'running')).toBe('running')
    expect(displayState(server('a', { status: 'broken' }), 'running')).toBe('broken')
    expect(displayState(server('a', { status: 'creating' }), undefined)).toBe('creating')
    expect(displayState(server('a', { state: 'waiting_for_files' }), 'stopped')).toBe('waiting')
    expect(displayState(server('a'), undefined)).toBe('unknown')
  })
})
