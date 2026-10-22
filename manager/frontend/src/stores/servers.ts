import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/api/client'

export interface ServerInstance {
  id: string
  name: string
  containerName: string
  status: 'ready' | 'creating' | 'broken'
  network: {
    serverPort: number
    webMapPort: number
    webMapWsPort: number
    pluginPort: number
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

const ACTIVE_KEY = 'kp-active-server-id'

/**
 * v3 multi-server registry, frontend side.
 *
 * The store hydrates from /api/servers (list + defaultId). The active server
 * is remembered in localStorage and falls back to the backend default. The
 * existing single-server views read the active id from this store; once the
 * backend per-server routing lands, requests will be retargeted via the
 * shared api client.
 *
 * Multiserver sits behind the backend's MULTISERVER_ENABLED flag. While it is
 * off (the default, and also until the flag has loaded) the active server is
 * pinned to the default server and the header picker stays hidden.
 */
export const useServersStore = defineStore('servers', () => {
  const servers = ref<ServerInstance[]>([])
  const defaultId = ref<string | null>(null)
  const activeId = ref<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null,
  )
  const multiserverEnabled = ref(false)
  const loaded = ref(false)
  const loading = ref(false)

  const activeServer = computed<ServerInstance | null>(() => {
    const id = multiserverEnabled.value ? (activeId.value ?? defaultId.value) : defaultId.value
    return servers.value.find((s) => s.id === id) ?? null
  })

  function persistActive(): void {
    if (typeof localStorage !== 'undefined' && activeId.value) {
      localStorage.setItem(ACTIVE_KEY, activeId.value)
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const { data } = await api.get<{
        servers: ServerInstance[]
        defaultId: string
        multiserverEnabled?: boolean
      }>('/servers')
      servers.value = data.servers
      defaultId.value = data.defaultId
      multiserverEnabled.value = data.multiserverEnabled === true
      // Stale active id (server got deleted), or multiserver off → default.
      if (!multiserverEnabled.value || !servers.value.some((s) => s.id === activeId.value)) {
        activeId.value = defaultId.value
        persistActive()
      }
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  /** Whether the backend would accept a delete (compose, default and last server never are). */
  function isDeletable(s: ServerInstance): boolean {
    return s.kind !== 'compose' && s.id !== defaultId.value && servers.value.length > 1
  }

  function setActive(id: string): void {
    if (!servers.value.some((s) => s.id === id)) return
    if (!multiserverEnabled.value && id !== defaultId.value) return
    activeId.value = id
    if (typeof localStorage !== 'undefined') localStorage.setItem(ACTIVE_KEY, id)
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
    await api.put('/servers/default', { id })
    await refresh()
  }

  return {
    servers,
    defaultId,
    activeId,
    multiserverEnabled,
    loaded,
    loading,
    activeServer,
    refresh,
    setActive,
    isDeletable,
    create,
    remove,
    setDefault,
  }
})
