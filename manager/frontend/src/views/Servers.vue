<script setup lang="ts">
import { translateServerWarning } from '@/utils/serverWarnings'
import { formatDateTime } from '@/utils/formatDate'
import { onMounted, ref, computed, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useServersStore, displayState, type ServerInstance } from '@/stores/servers'
import { useToast } from '@/composables/useToast'
import { apiErrorMessage, readApiError } from '@/utils/apiErrors'
import { buildLimits, bytesToGib } from '@/utils/serverLimits'
import Modal from '@/components/ui/Modal.vue'
import Button from '@/components/ui/Button.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import LimitsFields from '@/components/servers/LimitsFields.vue'
import TrashPanel from '@/components/servers/TrashPanel.vue'
import DownloaderLoginNotice from '@/components/servers/DownloaderLoginNotice.vue'

const { t, te } = useI18n()

/**
 * Servers fleet management view.
 *
 * Create, limits, delete (optionally moving the data to the trash), default
 * server and the Docker reconcile. POST /api/servers also creates the
 * container; when that fails the backend answers 502/503 and, for a 502, the
 * server stays registered as "broken", so the list is reloaded either way.
 */

type FilesState = 'present' | 'missing' | 'unknown'

/** What GET /servers adds to the registry entry. */
type ServerView = ServerInstance & {
  files?: FilesState
  limits?: { memory?: number; cpus?: number }
}

interface ReconcileReport {
  checked: number
  changes: { serverId: string; from: string; to: string; reason: string }[]
  orphans: { containerId: string; containerName: string; serverId: string; state: string }[]
  skipped?: string
}

const authStore = useAuthStore()
const serversStore = useServersStore()
const toast = useToast()
const router = useRouter()

const loading = ref(false)
const showAddModal = ref(false)
const submitting = ref(false)
const confirmDelete = ref<ServerView | null>(null)
const deleteData = ref(false)
// Set when the backend refused to touch the container (no panel labels for
// this server): offers removing only the registry entry.
const confirmKeepContainer = ref<ServerView | null>(null)
const deleting = ref(false)
const trashPanel = ref<InstanceType<typeof TrashPanel> | null>(null)

// Kept in the store: choosing the new server re-creates this page.
const createReport = computed(() => serversStore.createReport)
const editLimitsTarget = ref<ServerView | null>(null)
const savingLimits = ref(false)
const reconcileReport = ref<ReconcileReport | null>(null)
const reconciling = ref(false)

interface FormState {
  name: string
  serverPort: number | null
  webMapPort: number | null
  webMapWsPort: number | null
  memoryGib: number | null
  cpus: number | null
  autoStart: boolean
}

const form = reactive<FormState>(emptyForm())
const limitForm = reactive<{ memoryGib: number | null; cpus: number | null }>({ memoryGib: null, cpus: null })

function emptyForm(): FormState {
  return {
    name: '',
    serverPort: null,
    webMapPort: null,
    webMapWsPort: null,
    memoryGib: null,
    cpus: null,
    autoStart: true,
  }
}

function resetForm() {
  Object.assign(form, emptyForm())
}

const servers = computed(() => serversStore.servers as ServerView[])
const canList = computed(() => authStore.hasPermission('servers.list'))
const canCreate = computed(() => authStore.hasPermission('servers.create'))
const canDelete = computed(() => authStore.hasPermission('servers.delete'))
const canManage = computed(() => authStore.hasPermission('servers.manage'))
const canRestart = computed(() => authStore.hasPermission('server.restart'))

function errorText(err: unknown, fallback: string): string {
  return apiErrorMessage(err, t, te, fallback)
}

async function refresh() {
  loading.value = true
  try {
    await serversStore.refresh()
  } catch (err) {
    toast.error(t('servers.adm.loadFailed', { error: errorText(err, t('servers.adm.unknownError')) }))
  } finally {
    loading.value = false
  }
}

function limitsError(kind: 'memory' | 'cpus') {
  toast.warning(t(kind === 'memory' ? 'servers.adm.limits.memoryInvalid' : 'servers.adm.limits.cpusInvalid'))
}

async function submitCreate() {
  if (!form.name.trim()) {
    toast.warning(t('servers.adm.nameRequired'))
    return
  }
  const built = buildLimits(form.memoryGib, form.cpus)
  if (built.error) {
    limitsError(built.error)
    return
  }
  submitting.value = true
  try {
    // Strip empty optional fields so the backend uses its port-finder.
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      autoStart: form.autoStart,
    }
    if (form.serverPort) payload.serverPort = form.serverPort
    if (form.webMapPort) payload.webMapPort = form.webMapPort
    if (form.webMapWsPort) payload.webMapWsPort = form.webMapWsPort
    if (built.limits) payload.limits = built.limits

    const { data } = await api.post<{
      server: ServerInstance
      container: { id?: string; started?: boolean }
      warnings?: string[]
    }>('/servers', payload)

    toast.success(
      t(data.container?.started ? 'servers.adm.createdStarted' : 'servers.adm.created', {
        name: data.server.name,
      }),
    )
    if (data.warnings?.length) {
      serversStore.createReport = { name: data.server.name, warnings: data.warnings }
    }

    showAddModal.value = false
    resetForm()
    await serversStore.refresh()
    serversStore.setActive(data.server.id)
  } catch (err) {
    toast.error(t('servers.adm.createFailed', { error: errorText(err, t('servers.adm.unknownError')) }))
    // A failed container still leaves a "broken" entry (502): show it and let
    // the form go. Everything else (409, 400, 503) keeps the form for another try.
    const body = (err as { response?: { data?: { server?: ServerInstance } } })?.response?.data
    if (body?.server) {
      showAddModal.value = false
      resetForm()
    }
    await refresh()
  } finally {
    submitting.value = false
  }
}

function openDelete(s: ServerView) {
  deleteData.value = false
  confirmDelete.value = s
}

async function performDelete() {
  if (!confirmDelete.value) return
  const target = confirmDelete.value
  deleting.value = true
  try {
    const { data } = await api.delete<{ data?: { trashEntry?: string } }>(`/servers/${target.id}`, {
      params: deleteData.value ? { removeData: 'true' } : undefined,
    })
    toast.success(
      data.data?.trashEntry
        ? t('servers.adm.deletedToTrash', { name: target.name, entry: data.data.trashEntry })
        : t('servers.adm.deleted', { name: target.name }),
    )
    confirmDelete.value = null
    // The hints of a server that is gone no longer apply.
    if (serversStore.createReport?.name === target.name) serversStore.createReport = null
    await serversStore.refresh()
    if (data.data?.trashEntry) await trashPanel.value?.load()
  } catch (err) {
    const { code } = readApiError(err)
    if (code === 'CONTAINER_NOT_MANAGED') {
      confirmDelete.value = null
      confirmKeepContainer.value = target
    } else {
      toast.error(t('servers.adm.deleteFailed', { error: errorText(err, t('servers.adm.unknownError')) }))
      // The container may be gone while the entry stayed (data move failed).
      await refresh()
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
    toast.error(t('servers.adm.deleteFailed', { error: errorText(err, t('servers.adm.unknownError')) }))
  } finally {
    deleting.value = false
  }
}

async function makeDefault(s: ServerView) {
  try {
    await serversStore.setDefault(s.id)
    toast.success(t('servers.adm.defaultSet', { name: s.name }))
  } catch (err) {
    toast.error(t('servers.adm.defaultFailed', { error: errorText(err, t('servers.adm.unknownError')) }))
  }
}

function openLimits(s: ServerView) {
  limitForm.memoryGib = bytesToGib(s.limits?.memory)
  limitForm.cpus = s.limits?.cpus ?? null
  editLimitsTarget.value = s
}

async function saveLimits() {
  const target = editLimitsTarget.value
  if (!target) return
  const built = buildLimits(limitForm.memoryGib, limitForm.cpus)
  if (built.error) {
    limitsError(built.error)
    return
  }
  if (!built.limits) {
    editLimitsTarget.value = null
    return
  }
  savingLimits.value = true
  try {
    await api.put(`/servers/${target.id}`, { limits: built.limits })
    toast.success(t('servers.adm.limits.saved', { name: target.name }))
    editLimitsTarget.value = null
    await serversStore.refresh()
  } catch (err) {
    toast.error(t('servers.adm.limits.saveFailed', { error: errorText(err, t('servers.adm.unknownError')) }))
  } finally {
    savingLimits.value = false
  }
}

async function reconcile() {
  reconciling.value = true
  try {
    const { data } = await api.post<ReconcileReport>('/servers/_reconcile')
    reconcileReport.value = data
    await serversStore.refresh()
  } catch (err) {
    toast.error(t('servers.adm.reconcile.failed', { error: errorText(err, t('servers.adm.unknownError')) }))
  } finally {
    reconciling.value = false
  }
}

const DISPLAY_STATE_BADGES: Record<string, { key: string; cls: string }> = {
  running: { key: 'serverScope.running', cls: 'bg-status-success/15 text-status-success' },
  stopped: { key: 'serverScope.stopped', cls: 'bg-surface-overlay text-ink-muted' },
  unknown: { key: 'serverScope.unknown', cls: 'bg-surface-overlay text-ink-muted' },
  creating: { key: 'servers.creating', cls: 'bg-status-warning/15 text-status-warning' },
  waiting: { key: 'servers.adm.waitingForFiles', cls: 'bg-status-warning/15 text-status-warning' },
  broken: { key: 'servers.broken', cls: 'bg-status-error/15 text-status-error' },
}

// What the container is doing, like the picker shows it (not the registry state).
function statusBadge(s: ServerView): { label: string; cls: string } {
  const badge = DISPLAY_STATE_BADGES[displayState(s, serversStore.runStates[s.id])]
  return { label: t(badge.key), cls: badge.cls }
}

function limitsText(s: ServerView): string {
  if (s.kind === 'compose') return t('servers.adm.limits.composeManaged')
  const memory = bytesToGib(s.limits?.memory)
  const parts: string[] = []
  if (memory !== null) parts.push(t('servers.adm.limits.memoryValue', { gib: memory }))
  if (s.limits?.cpus) parts.push(t('servers.adm.limits.cpusValue', { cpus: s.limits.cpus }))
  return parts.length > 0 ? parts.join(', ') : t('servers.adm.limits.inheritedFromPrimary')
}

function goToDashboard(s: ServerView) {
  serversStore.setActive(s.id)
  router.push('/')
}

onMounted(() => {
  void serversStore.refreshRunStates()
  return refresh()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('servers.title') }}</h1>
        <p class="text-sm text-ink-muted">{{ t('servers.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="secondary" size="sm" :loading="loading" @click="refresh">
          {{ t('common.refresh') }}
        </Button>
        <Button
          v-if="canManage"
          variant="secondary"
          size="sm"
          :loading="reconciling"
          :title="t('servers.adm.reconcile.hint')"
          @click="reconcile"
        >
          {{ t('servers.adm.reconcile.button') }}
        </Button>
        <Button
          v-if="canCreate && serversStore.multiserverEnabled"
          variant="primary"
          size="sm"
          @click="showAddModal = true"
        >
          {{ t('servers.addServer') }}
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

    <div v-if="createReport" class="rounded-xl p-4 border bg-status-warning/10 border-status-warning/30" role="status">
      <div class="flex items-start justify-between gap-3">
        <p class="text-sm font-semibold text-status-warning">
          {{ t('servers.adm.warningsTitle', { name: createReport.name }) }}
        </p>
        <button
          type="button"
          class="text-xs text-ink-muted hover:text-ink"
          :aria-label="t('common.close')"
          @click="serversStore.createReport = null"
        >
          {{ t('common.close') }}
        </button>
      </div>
      <ul class="list-disc pl-5 mt-1 space-y-1 text-xs text-ink-muted">
        <li v-for="(w, i) in createReport.warnings" :key="i">{{ translateServerWarning(w, t) }}</li>
      </ul>
    </div>

    <div v-if="!canList" class="bg-surface-raised border border-border rounded-xl p-6 text-center text-ink-muted">
      {{ t('servers.adm.noPermission') }}
    </div>

    <div v-else-if="loading && servers.length === 0" class="bg-surface-raised border border-border rounded-xl p-6 text-center text-ink-muted">
      {{ t('common.loading') }}
    </div>

    <div v-else-if="servers.length === 0" class="bg-surface-raised border border-border rounded-xl p-6 text-center text-ink-muted">
      {{ t('servers.adm.empty') }}
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="s in servers"
        :key="s.id"
        class="bg-surface-raised border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-start gap-4"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold text-ink">{{ s.name }}</span>
            <span :class="['text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold', statusBadge(s).cls]">
              {{ statusBadge(s).label }}
            </span>
            <span v-if="serversStore.defaultId === s.id" class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold bg-hytale-orange/15 text-hytale-orange">
              {{ t('servers.default') }}
            </span>
            <span v-if="s.kind === 'compose'" class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold bg-surface-overlay text-ink-muted">
              {{ t('servers.guard.composeBadge') }}
            </span>
            <span
              v-if="s.files === 'missing'"
              class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold bg-status-warning/15 text-status-warning"
            >
              {{ t('servers.adm.files.missing') }}
            </span>
            <span
              v-else-if="s.files === 'unknown'"
              class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold bg-surface-overlay text-ink-muted"
              :title="t('servers.adm.files.unknownHint')"
            >
              {{ t('servers.adm.files.unknown') }}
            </span>
          </div>
          <div class="text-xs text-ink-muted mt-1 font-mono break-all">
            <span class="mr-3">id: {{ s.id }}</span>
            <span class="mr-3">{{ t('servers.adm.container') }}: {{ s.containerName }}</span>
            <span class="mr-3">{{ t('servers.adm.gamePort') }}: {{ s.network.serverPort }}/udp</span>
            <span class="mr-3">{{ t('servers.adm.webMapPort') }}: {{ s.network.webMapPort }}/tcp</span>
          </div>
          <div class="text-xs text-ink-muted mt-1">
            {{ t('servers.adm.limits.label') }}: {{ limitsText(s) }}
          </div>
          <div class="text-[11px] text-ink-subtle mt-1">
            {{ t('servers.adm.createdBy', { date: formatDateTime(s.createdAt), user: s.createdBy }) }}
          </div>
          <template v-if="(s.state ?? s.status) === 'waiting_for_files'">
            <p class="text-xs text-status-warning mt-2">{{ t('servers.adm.waitingHint') }}</p>
            <DownloaderLoginNotice :server-id="s.id" :can-restart="canRestart" />
          </template>
        </div>
        <div class="flex sm:flex-col gap-2 flex-wrap flex-shrink-0">
          <Button
            v-if="serversStore.multiserverEnabled || serversStore.defaultId === s.id"
            variant="secondary"
            size="sm"
            @click="goToDashboard(s)"
          >
            {{ t('servers.adm.open') }}
          </Button>
          <!-- With multiserver off the default may only move back to the compose server. -->
          <Button
            v-if="canManage && serversStore.defaultId !== s.id && (serversStore.multiserverEnabled || s.kind === 'compose')"
            variant="ghost"
            size="sm"
            @click="makeDefault(s)"
          >
            {{ t('servers.setDefault') }}
          </Button>
          <!-- The compose server's limits live in docker-compose.yml. -->
          <Button
            v-if="canManage && s.kind !== 'compose'"
            variant="ghost"
            size="sm"
            @click="openLimits(s)"
          >
            {{ t('servers.adm.limits.edit') }}
          </Button>
          <!-- The backend refuses the compose, default and last server; do not offer it. -->
          <Button
            v-if="canDelete && serversStore.isDeletable(s)"
            variant="danger"
            size="sm"
            @click="openDelete(s)"
          >
            {{ t('common.delete') }}
          </Button>
        </div>
      </div>
    </div>

    <TrashPanel v-if="canDelete" ref="trashPanel" />

    <Modal :open="showAddModal" :title="t('servers.addServer')" @close="showAddModal = false">
      <div class="space-y-3">
        <div>
          <label class="block text-xs font-semibold text-ink-muted mb-1">{{ t('servers.adm.form.name') }} *</label>
          <input
            v-model="form.name"
            :placeholder="t('servers.adm.form.namePlaceholder')"
            maxlength="64"
            class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
          />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-xs font-semibold text-ink-muted mb-1">{{ t('servers.adm.form.serverPort') }}</label>
            <input
              v-model.number="form.serverPort"
              type="number"
              :placeholder="t('servers.adm.form.auto')"
              class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
            />
          </div>
          <div></div>
          <div>
            <label class="block text-xs font-semibold text-ink-muted mb-1">{{ t('servers.adm.form.webMapPort') }}</label>
            <input
              v-model.number="form.webMapPort"
              type="number"
              :placeholder="t('servers.adm.form.auto')"
              class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-ink-muted mb-1">{{ t('servers.adm.form.webMapWsPort') }}</label>
            <input
              v-model.number="form.webMapWsPort"
              type="number"
              :placeholder="t('servers.adm.form.auto')"
              class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
            />
          </div>
        </div>
        <p class="text-[11px] text-ink-subtle">{{ t('servers.adm.form.webMapHint') }}</p>
        <LimitsFields v-model:memory-gib="form.memoryGib" v-model:cpus="form.cpus" />
        <label class="flex items-center gap-2 text-sm text-ink">
          <input v-model="form.autoStart" type="checkbox" class="rounded" />
          {{ t('servers.adm.form.autoStart') }}
        </label>
        <p class="text-[11px] text-ink-subtle">{{ t('servers.adm.form.imageHint') }}</p>
      </div>
      <template #footer>
        <Button variant="secondary" size="sm" :disabled="submitting" @click="showAddModal = false">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="primary" size="sm" :loading="submitting" @click="submitCreate">
          {{ t('servers.adm.form.create') }}
        </Button>
      </template>
    </Modal>

    <Modal
      :open="!!editLimitsTarget"
      :title="t('servers.adm.limits.editTitle', { name: editLimitsTarget?.name ?? '' })"
      @close="editLimitsTarget = null"
    >
      <div class="space-y-3">
        <LimitsFields v-model:memory-gib="limitForm.memoryGib" v-model:cpus="limitForm.cpus" />
        <p class="text-[11px] text-ink-subtle">{{ t('servers.adm.limits.liveHint') }}</p>
      </div>
      <template #footer>
        <Button variant="secondary" size="sm" :disabled="savingLimits" @click="editLimitsTarget = null">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="primary" size="sm" :loading="savingLimits" @click="saveLimits">
          {{ t('common.save') }}
        </Button>
      </template>
    </Modal>

    <Modal :open="!!confirmDelete" :title="t('servers.adm.delete.title')" @close="confirmDelete = null">
      <div v-if="confirmDelete" class="space-y-3">
        <p class="text-sm text-ink">
          {{ t('servers.adm.delete.message', { name: confirmDelete.name, container: confirmDelete.containerName }) }}
        </p>
        <label class="flex items-start gap-2 text-sm text-ink">
          <input v-model="deleteData" type="checkbox" class="rounded mt-0.5" />
          <span>
            {{ t('servers.adm.delete.moveData') }}
            <span class="block text-[11px] text-ink-subtle">{{ t('servers.adm.delete.moveDataHint') }}</span>
          </span>
        </label>
        <p v-if="!deleteData" class="text-[11px] text-ink-subtle">{{ t('servers.adm.delete.keepDataHint') }}</p>
      </div>
      <template #footer>
        <Button variant="secondary" size="sm" :disabled="deleting" @click="confirmDelete = null">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" size="sm" :loading="deleting" @click="performDelete">
          {{ t('common.delete') }}
        </Button>
      </template>
    </Modal>

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

    <Modal :open="!!reconcileReport" :title="t('servers.adm.reconcile.title')" @close="reconcileReport = null">
      <div v-if="reconcileReport" class="space-y-3 text-sm text-ink">
        <p v-if="reconcileReport.skipped" class="text-ink-muted">{{ reconcileReport.skipped }}</p>
        <template v-else>
          <p>{{ t('servers.adm.reconcile.checked', { count: reconcileReport.checked }) }}</p>
          <p v-if="reconcileReport.changes.length === 0 && reconcileReport.orphans.length === 0" class="text-status-success">
            {{ t('servers.adm.reconcile.noChanges') }}
          </p>
          <div v-if="reconcileReport.changes.length > 0">
            <p class="font-semibold">{{ t('servers.adm.reconcile.changes') }}</p>
            <ul class="list-disc pl-5 text-xs text-ink-muted space-y-1">
              <li v-for="c in reconcileReport.changes" :key="c.serverId">
                <span class="font-mono">{{ c.serverId }}</span>: {{ c.from }} → {{ c.to }} ({{ c.reason }})
              </li>
            </ul>
          </div>
          <div v-if="reconcileReport.orphans.length > 0">
            <p class="font-semibold">{{ t('servers.adm.reconcile.orphans') }}</p>
            <p class="text-[11px] text-ink-subtle">{{ t('servers.adm.reconcile.orphansHint') }}</p>
            <ul class="list-disc pl-5 text-xs text-ink-muted space-y-1">
              <li v-for="o in reconcileReport.orphans" :key="o.containerId">
                <span class="font-mono">{{ o.containerName }}</span> ({{ o.state }}, id {{ o.serverId }})
              </li>
            </ul>
          </div>
        </template>
      </div>
      <template #footer>
        <Button variant="primary" size="sm" @click="reconcileReport = null">{{ t('common.close') }}</Button>
      </template>
    </Modal>
  </div>
</template>
