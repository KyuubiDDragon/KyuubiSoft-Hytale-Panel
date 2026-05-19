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
    server: string; data: string; backups: string;
    mods: string; plugins: string; assets: string; auth: string;
  }
  createdAt: string
  createdBy: string
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
 */
export const useServersStore = defineStore('servers', () => {
  const servers = ref<ServerInstance[]>([])
  const defaultId = ref<string | null>(null)
  const activeId = ref<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) : null
  )
  const loaded = ref(false)
  const loading = ref(false)

  const activeServer = computed<ServerInstance | null>(() =>
    servers.value.find(s => s.id === (activeId.value ?? defaultId.value)) ?? null
  )

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const { data } = await api.get<{ servers: ServerInstance[]; defaultId: string }>('/servers')
      servers.value = data.servers
      defaultId.value = data.defaultId
      // Stale active id (server got deleted) → fall back to default.
      if (!servers.value.some(s => s.id === activeId.value)) {
        activeId.value = defaultId.value
        if (typeof localStorage !== 'undefined' && activeId.value) {
          localStorage.setItem(ACTIVE_KEY, activeId.value)
        }
      }
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  function setActive(id: string): void {
    if (!servers.value.some(s => s.id === id)) return
    activeId.value = id
    if (typeof localStorage !== 'undefined') localStorage.setItem(ACTIVE_KEY, id)
  }

  async function create(input: { name: string; serverPort?: number; webMapPort?: number; pluginPort?: number }): Promise<ServerInstance> {
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
    servers, defaultId, activeId, loaded, loading,
    activeServer,
    refresh, setActive, create, remove, setDefault,
  }
})
