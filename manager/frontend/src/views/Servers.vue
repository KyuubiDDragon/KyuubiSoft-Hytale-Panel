<script setup lang="ts">
import { onMounted, ref, computed, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useServersStore, type ServerInstance } from '@/stores/servers'
import { useToast } from '@/composables/useToast'
import Modal from '@/components/ui/Modal.vue'
import Button from '@/components/ui/Button.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

const { t } = useI18n()

/**
 * Servers fleet management view.
 *
 * Pure CRUD over the v3 multi-server registry. POST /api/servers now also
 * creates the Docker container (dockerImageManager.ts on the backend) — the
 * "Auto-start after create" checkbox here drives that behaviour. The list
 * uses the shared servers store so the active-server pill in the header
 * updates in lock-step when the operator deletes the currently active one.
 */

const authStore = useAuthStore()
const serversStore = useServersStore()
const toast = useToast()
const router = useRouter()

const loading = ref(false)
const showAddModal = ref(false)
const submitting = ref(false)
const confirmDelete = ref<ServerInstance | null>(null)
// Set when the backend refused to touch the container (no panel labels for
// this server): offers removing only the registry entry.
const confirmKeepContainer = ref<ServerInstance | null>(null)
const deleting = ref(false)

function apiError(err: unknown): { detail: string; code?: string } {
  const data = (err as { response?: { data?: { detail?: string; error?: string; code?: string } } })?.response?.data
  return {
    detail: data?.detail || data?.error || (err instanceof Error ? err.message : 'Unknown error'),
    code: data?.code,
  }
}

interface FormState {
  name: string
  serverPort: number | null
  webMapPort: number | null
  webMapWsPort: number | null
  pluginPort: number | null
  autoStart: boolean
}

const form = reactive<FormState>({
  name: '',
  serverPort: null,
  webMapPort: null,
  webMapWsPort: null,
  pluginPort: null,
  autoStart: true,
})

function resetForm() {
  form.name = ''
  form.serverPort = null
  form.webMapPort = null
  form.webMapWsPort = null
  form.pluginPort = null
  form.autoStart = true
}

const canList = computed(() => authStore.hasPermission('servers.list'))
const canCreate = computed(() => authStore.hasPermission('servers.create'))
const canDelete = computed(() => authStore.hasPermission('servers.delete'))

async function refresh() {
  loading.value = true
  try {
    await serversStore.refresh()
  } catch (err) {
    toast.error('Failed to load servers: ' + (err instanceof Error ? err.message : 'unknown'))
  } finally {
    loading.value = false
  }
}

async function submitCreate() {
  if (!form.name.trim()) {
    toast.warning('Server name is required')
    return
  }
  submitting.value = true
  try {
    // Strip empty optional fields so the backend uses its port-finder.
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      autoStart: form.autoStart,
    }
    if (form.serverPort)  payload.serverPort = form.serverPort
    if (form.webMapPort)  payload.webMapPort = form.webMapPort
    if (form.webMapWsPort) payload.webMapWsPort = form.webMapWsPort
    if (form.pluginPort)  payload.pluginPort = form.pluginPort

    const { data } = await api.post<{
      server: ServerInstance
      container: { id?: string; started?: boolean; error?: string }
    }>('/servers', payload)

    if (data.container?.error) {
      toast.warning(`Server "${data.server.name}" registered, but container failed: ${data.container.error}`)
    } else {
      toast.success(`Container created${data.container?.started ? ' and started' : ''} — ${data.server.name}`)
    }

    showAddModal.value = false
    resetForm()
    await serversStore.refresh()

    // Surface the new entry by switching active server in the store so the
    // header's per-server controls hop to it. Skip when create succeeded
    // but the container itself is broken — staying on the previous server
    // is less surprising.
    if (!data.container?.error) {
      serversStore.setActive(data.server.id)
    }
  } catch (err) {
    toast.error('Create failed: ' + apiError(err).detail)
  } finally {
    submitting.value = false
  }
}

async function performDelete() {
  if (!confirmDelete.value) return
  const target = confirmDelete.value
  deleting.value = true
  try {
    await api.delete(`/servers/${target.id}`)
    toast.success(`Server "${target.name}" deleted`)
    confirmDelete.value = null
    await serversStore.refresh()
  } catch (err) {
    const { detail, code } = apiError(err)
    if (code === 'CONTAINER_NOT_MANAGED') {
      confirmDelete.value = null
      confirmKeepContainer.value = target
    } else {
      toast.error('Delete failed: ' + detail)
    }
  } finally {
    deleting.value = false
  }
}

async function performDeleteEntryOnly() {
  if (!confirmKeepContainer.value) return
  const target = confirmKeepContainer.value
  deleting.value = true
  try {
    await api.delete(`/servers/${target.id}`, { params: { keepContainer: 'true' } })
    toast.success(t('servers.guard.entryRemoved', { name: target.name }))
    confirmKeepContainer.value = null
    await serversStore.refresh()
  } catch (err) {
    toast.error('Delete failed: ' + apiError(err).detail)
  } finally {
    deleting.value = false
  }
}

async function makeDefault(s: ServerInstance) {
  try {
    await serversStore.setDefault(s.id)
    toast.success(`Default server set to "${s.name}"`)
  } catch (err) {
    toast.error('Could not set default: ' + apiError(err).detail)
  }
}

function statusBadge(s: ServerInstance): { label: string; cls: string } {
  switch (s.status) {
    case 'ready':    return { label: 'Ready',    cls: 'bg-status-success/15 text-status-success' }
    case 'creating': return { label: 'Creating', cls: 'bg-status-warning/15 text-status-warning' }
    case 'broken':   return { label: 'Broken',   cls: 'bg-status-error/15 text-status-error' }
    default:         return { label: s.status,   cls: 'bg-surface-overlay text-ink-muted' }
  }
}

function goToDashboard(s: ServerInstance) {
  serversStore.setActive(s.id)
  router.push('/')
}

onMounted(refresh)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('servers.title') }}</h1>
        <p class="text-sm text-ink-muted">{{ t('servers.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="secondary" size="sm" :loading="loading" @click="refresh">
          Refresh
        </Button>
        <Button
          v-if="canCreate && serversStore.multiserverEnabled"
          variant="primary"
          size="sm"
          @click="showAddModal = true"
        >
          + Add Server
        </Button>
      </div>
    </div>

    <div
      v-if="canList && serversStore.loaded"
      class="rounded-xl p-4 border"
      :class="serversStore.multiserverEnabled ? 'bg-status-warning/10 border-status-warning/30' : 'bg-surface-raised border-border'"
      role="status"
    >
      <p class="text-sm font-semibold" :class="serversStore.multiserverEnabled ? 'text-status-warning' : 'text-ink'">
        {{ serversStore.multiserverEnabled ? t('servers.guard.experimentalTitle') : t('servers.guard.disabledTitle') }}
      </p>
      <p class="text-xs text-ink-muted mt-1">
        {{ serversStore.multiserverEnabled ? t('servers.guard.experimentalHint') : t('servers.guard.disabledHint') }}
      </p>
    </div>

    <div v-if="!canList" class="bg-surface-raised border border-border rounded-xl p-6 text-center text-ink-muted">
      You do not have permission to view server instances.
    </div>

    <div v-else-if="loading && serversStore.servers.length === 0" class="bg-surface-raised border border-border rounded-xl p-6 text-center text-ink-muted">
      Loading…
    </div>

    <div v-else-if="serversStore.servers.length === 0" class="bg-surface-raised border border-border rounded-xl p-6 text-center text-ink-muted">
      No server instances registered yet.
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="s in serversStore.servers"
        :key="s.id"
        class="bg-surface-raised border border-border rounded-xl p-4 flex items-start gap-4"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold text-ink">{{ s.name }}</span>
            <span :class="['text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold', statusBadge(s).cls]">
              {{ statusBadge(s).label }}
            </span>
            <span v-if="serversStore.defaultId === s.id" class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold bg-hytale-orange/15 text-hytale-orange">
              Default
            </span>
            <span v-if="s.kind === 'compose'" class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold bg-surface-overlay text-ink-muted">
              {{ t('servers.guard.composeBadge') }}
            </span>
          </div>
          <div class="text-xs text-ink-muted mt-1 font-mono">
            <span class="mr-3">id: {{ s.id }}</span>
            <span class="mr-3">container: {{ s.containerName }}</span>
            <span class="mr-3">server: {{ s.network.serverPort }}/udp</span>
            <span class="mr-3">webmap: {{ s.network.webMapPort }}/tcp</span>
            <span class="mr-3">plugin: {{ s.network.pluginPort }}/tcp</span>
          </div>
          <div class="text-[11px] text-ink-subtle mt-1">
            Created {{ new Date(s.createdAt).toLocaleString() }} by {{ s.createdBy }}
          </div>
        </div>
        <div class="flex flex-col gap-2 flex-shrink-0">
          <Button
            v-if="serversStore.multiserverEnabled || serversStore.defaultId === s.id"
            variant="secondary"
            size="sm"
            @click="goToDashboard(s)"
          >
            Open
          </Button>
          <!-- With multiserver off the default may only move back to the compose server. -->
          <Button
            v-if="canCreate && serversStore.defaultId !== s.id && (serversStore.multiserverEnabled || s.kind === 'compose')"
            variant="ghost"
            size="sm"
            @click="makeDefault(s)"
          >
            Set default
          </Button>
          <!-- The backend refuses the compose, default and last server; do not offer it. -->
          <Button
            v-if="canDelete && serversStore.isDeletable(s)"
            variant="danger"
            size="sm"
            @click="confirmDelete = s"
          >
            Delete
          </Button>
        </div>
      </div>
    </div>

    <Modal :open="showAddModal" title="Add Server" @close="showAddModal = false">
      <div class="space-y-3">
        <div>
          <label class="block text-xs font-semibold text-ink-muted mb-1">Name *</label>
          <input
            v-model="form.name"
            placeholder="e.g. Survival #2"
            class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
          />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-xs font-semibold text-ink-muted mb-1">Server port (UDP)</label>
            <input
              v-model.number="form.serverPort"
              type="number"
              placeholder="auto"
              class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-ink-muted mb-1">Plugin port (TCP)</label>
            <input
              v-model.number="form.pluginPort"
              type="number"
              placeholder="auto"
              class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-ink-muted mb-1">WebMap port (TCP)</label>
            <input
              v-model.number="form.webMapPort"
              type="number"
              placeholder="auto"
              class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-ink-muted mb-1">WebMap WS port (TCP)</label>
            <input
              v-model.number="form.webMapWsPort"
              type="number"
              placeholder="auto"
              class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
            />
          </div>
        </div>
        <label class="flex items-center gap-2 text-sm text-ink">
          <input v-model="form.autoStart" type="checkbox" class="rounded" />
          Auto-start after create
        </label>
        <p class="text-[11px] text-ink-subtle">
          Empty ports default to the next free slot. The Docker container is
          created from the same image as the primary <code>hytale</code>
          service (override via the <code>HYTALE_IMAGE</code> env var on the
          manager).
        </p>
      </div>
      <template #footer>
        <Button variant="secondary" size="sm" :disabled="submitting" @click="showAddModal = false">
          Cancel
        </Button>
        <Button variant="primary" size="sm" :loading="submitting" @click="submitCreate">
          Create
        </Button>
      </template>
    </Modal>

    <ConfirmDialog
      :show="!!confirmDelete"
      title="Delete server?"
      :message="confirmDelete ? `This stops and removes the Docker container ${confirmDelete.containerName} and drops the registry entry. Host bind-mount data is preserved.` : ''"
      variant="danger"
      :loading="deleting"
      confirm-text="Delete"
      @confirm="performDelete"
      @cancel="confirmDelete = null"
    />

    <ConfirmDialog
      :show="!!confirmKeepContainer"
      :title="t('servers.guard.notManagedTitle')"
      :message="confirmKeepContainer ? t('servers.guard.notManagedMessage', { container: confirmKeepContainer.containerName }) : ''"
      variant="danger"
      :loading="deleting"
      :confirm-text="t('servers.guard.removeEntryOnly')"
      @confirm="performDeleteEntryOnly"
      @cancel="confirmKeepContainer = null"
    />
  </div>
</template>
