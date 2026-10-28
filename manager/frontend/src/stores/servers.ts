import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AxiosError } from 'axios'
import api, { abortScopedRequests } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import { resolveActiveId } from '@/utils/serverScope'

export interface ServerInstance {
  id: string
  name: string
  containerName: string
  status: 'ready' | 'creating' | 'broken'
  /** `waiting_for_files`: set up, but the game files are missing. */
  state?: 'ready' | 'creating' | 'broken' | 'waiting_for_files'
  network: {
    serverPort: number
    webMapPort: number
    webMapWsPort: number
    pluginPort?: number
  }
  paths: {
    server: string
    data: string
    backups: string
    mods: string
    plugins: string
    assets: string
    auth: string
  }
  createdAt: string
  createdBy: string
  /** 'compose' = the stack's own game container; never deletable. */
  kind?: 'compose' | 'managed'
}

/** What the game container is doing right now (not what the registry says). */
export type RunState = 'running' | 'stopped' | 'unknown'

/** What the picker shows for a server. */
export type DisplayState = 'running' | 'stopped' | 'unknown' | 'creating' | 'broken' | 'waiting'

export function displayState(server: ServerInstance, run: RunState | undefined): DisplayState {
  const state = server.state ?? server.status
  if (state === 'broken') return 'broken'
  if (state === 'creating') return 'creating'
  if (state === 'waiting_for_files') return 'waiting'
  return run ?? 'unknown'
}

const ACTIVE_KEY = 'kp-active-server-id'

function readRemembered(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null
  } catch {
    return null
  }
}

function remember(id: string | null): void {
  if (!id) return
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}

/**
 * Multi-server state, frontend side.
 *
 * The list comes from /servers (already limited to the servers the account
 * may use). Accounts without `servers.list` get their server ids from
 * /auth/me/servers instead and see no picker. `scopeId` is the server the
 * api client addresses; `null` means the legacy URLs (default server), which
 * is what happens while multiserver is off.
 *
 * `epoch` changes whenever the panel moves to another server; the app
 * re-creates the current page on it, so no view keeps data of the old one.
 */
export const useServersStore = defineStore('servers', () => {
  const servers = ref<ServerInstance[]>([])
  const defaultId = ref<string | null>(null)
  const activeId = ref<string | null>(readRemembered())
  const multiserverEnabled = ref(false)
  /** False when the account lacks `servers.list`. */
  const canList = ref(true)
  /** Server ids of a restricted account; null = every server. */
  const allowedIds = ref<string[] | null>(null)
  const loaded = ref(false)
  const loading = ref(false)
  const epoch = ref(0)
  const runStates = ref<Record<string, RunState>>({})
  /** Hints after creating a server; kept here because the page is re-created on the switch. */
  const createReport = ref<{ name: string; warnings: string[] } | null>(null)
  let initPromise: Promise<void> | null = null

  /** Server the api client addresses; null = legacy URLs. */
  const scopeId = computed<string | null>(() => {
    if (!loaded.value) return null
    if (canList.value) return multiserverEnabled.value ? activeId.value : null
    return allowedIds.value && allowedIds.value.length > 0 ? activeId.value : null
  })

  const activeServer = computed<ServerInstance | null>(() => {
    const id = scopeId.value ?? defaultId.value
    return servers.value.find((s) => s.id === id) ?? null
  })

  /** The picker needs the list, multiserver on, and at least one server. */
  const pickerVisible = computed(
    () => loaded.value && canList.value && multiserverEnabled.value && servers.value.length > 0,
  )

  /** Another server became the target: drop everything that belongs to the old one. */
  function onScopeChanged(): void {
    abortScopedRequests()
    useConsoleStore().reset()
    epoch.value++
  }

  async function fetchDefaultId(): Promise<string | null> {
    const { data } = await api.get<{ defaultId: string | null }>('/servers/_default')
    return data.defaultId ?? null
  }

  async function loadFromList(): Promise<void> {
    const { data } = await api.get<{
      servers: ServerInstance[]
      defaultId?: string | null
      multiserverEnabled?: boolean
    }>('/servers')
    servers.value = data.servers
    defaultId.value = data.defaultId ?? (await fetchDefaultId())
    multiserverEnabled.value = data.multiserverEnabled === true
    canList.value = true
    allowedIds.value = null
    // The default may be one this account may not use: fall back to the first allowed.
    activeId.value = resolveActiveId(
      data.servers.map((s) => s.id),
      defaultId.value,
      activeId.value,
    )
  }

  async function loadFromOwnAccess(): Promise<void> {
    const { data } = await api.get<{ allowedServers: string[] | null }>('/auth/me/servers')
    servers.value = []
    canList.value = false
    multiserverEnabled.value = false
    allowedIds.value = data.allowedServers
    activeId.value = data.allowedServers
      ? resolveActiveId(data.allowedServers, null, activeId.value)
      : null
  }

  async function refresh(): Promise<void> {
    const wasLoaded = loaded.value
    const before = scopeId.value
    loading.value = true
    try {
      try {
        await loadFromList()
      } catch (err) {
        if ((err as AxiosError)?.response?.status !== 403) throw err
        await loadFromOwnAccess()
      }
      remember(activeId.value)
      loaded.value = true
      if (wasLoaded && scopeId.value !== before) onScopeChanged()
    } finally {
      loading.value = false
      // A failed first load must not hold the app back; it then works on legacy URLs.
      loaded.value = true
    }
  }

  /** Loads the list once; later calls share the first one. Never throws. */
  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = refresh().catch(() => {})
    }
    return initPromise
  }

  /** Forget everything (logout), so the next account starts clean. */
  function reset(): void {
    servers.value = []
    defaultId.value = null
    multiserverEnabled.value = false
    canList.value = true
    allowedIds.value = null
    runStates.value = {}
    createReport.value = null
    // The next account must not see this one's console lines or finish its requests.
    abortScopedRequests()
    useConsoleStore().reset()
    loaded.value = false
    initPromise = null
  }

  /** Whether the backend would accept a delete (compose, default and last server never are). */
  function isDeletable(s: ServerInstance): boolean {
    return s.kind !== 'compose' && s.id !== defaultId.value && servers.value.length > 1
  }

  function setActive(id: string): void {
    if (id === activeId.value) return
    const known = canList.value
      ? servers.value.some((s) => s.id === id)
      : (allowedIds.value ?? []).includes(id)
    if (!known) return
    if (canList.value && !multiserverEnabled.value && id !== defaultId.value) return
    activeId.value = id
    remember(id)
    onScopeChanged()
  }

  /** Asks every listed server whether it is running; failures show as unknown. */
  async function refreshRunStates(): Promise<void> {
    const ids = servers.value.map((s) => s.id)
    const results = await Promise.allSettled(
      ids.map((id) =>
        api.get<{ running?: boolean }>(`/servers/${encodeURIComponent(id)}/server/status`),
      ),
    )
    const next: Record<string, RunState> = {}
    results.forEach((result, i) => {
      next[ids[i]] =
        result.status === 'fulfilled'
          ? result.value.data.running
            ? 'running'
            : 'stopped'
          : 'unknown'
    })
    runStates.value = next
  }

  async function create(input: {
    name: string
    serverPort?: number
    webMapPort?: number
    pluginPort?: number
  }): Promise<ServerInstance> {
    const { data } = await api.post<{ server: ServerInstance }>('/servers', input)
    await refresh()
    return data.server
  }

  async function remove(id: string): Promise<void> {
    await api.delete(`/servers/${id}`)
    await refresh()
  }

  async function setDefault(id: string): Promise<void> {
    await api.put('/servers/_default', { id })
    await refresh()
  }

  return {
    servers,
    defaultId,
    activeId,
    multiserverEnabled,
    canList,
    allowedIds,
    loaded,
    loading,
    epoch,
    runStates,
    createReport,
    scopeId,
    activeServer,
    pickerVisible,
    init,
    refresh,
    reset,
    refreshRunStates,
    setActive,
    isDeletable,
    create,
    remove,
    setDefault,
  }
})
