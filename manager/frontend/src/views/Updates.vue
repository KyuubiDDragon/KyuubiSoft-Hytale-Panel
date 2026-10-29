<script setup lang="ts">
import { formatDateTime } from '@/utils/formatDate'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import {
  serverApi,
  type NativeUpdateStatus,
  type UpdateConfig,
  type UpdateHistoryEntry,
  type JarSnapshot,
  type DownloaderVersion,
  type UpdateActionState,
} from '@/api/server'

const { t, te } = useI18n()
const authStore = useAuthStore()
const { addToast } = useToast()
const { ask } = useConfirm()

const loading = ref(true)
const status = ref<NativeUpdateStatus | null>(null)
const config = ref<UpdateConfig | null>(null)
const history = ref<UpdateHistoryEntry[]>([])
const snapshots = ref<JarSnapshot[]>([])
const downloader = ref<DownloaderVersion | null>(null)

const busy = ref(false)
const checking = ref(false)
const savingConfig = ref(false)
const downloaderBusy = ref(false)

const canApply = computed(() => authStore.hasPermission('updates.apply'))
const canConfig = computed(() => authStore.hasPermission('updates.config'))
const canDownload = computed(() => authStore.hasPermission('updates.download'))
const canCheck = computed(() => authStore.hasPermission('updates.check'))

const staged = computed(() => status.value?.staged ?? null)
const lastCheck = computed(() => status.value?.lastCheck ?? null)
// A stop/start/rollback/restore runs on the server (also one started from
// another tab, or one this page stopped waiting for): no second one.
const lifecycleBusy = computed(() => status.value?.lifecycleBusy === true)
const actionsLocked = computed(() => busy.value || lifecycleBusy.value)
// The main server's updater folder is not the one the game container uses.
const updaterProblem = computed(() =>
  status.value?.actions.rollbackSnapshot?.reason === 'no_updater'
    ? status.value.updaterMount === 'not_shared'
      ? t('updates.updaterNotShared')
      : t('updates.updaterMissing')
    : null,
)
// A newer version is known from the last check (and not downloaded yet).
const newerKnown = computed(() => {
  const s = status.value
  const latest = s?.lastCheck?.latestVersion
  return !!s && !s.staged && !!latest && latest !== 'unknown' && latest !== s.currentVersion
})

type ApiError = { response?: { status?: number; data?: { error?: string; message?: string; requiresRestart?: boolean; reason?: string } } }
const errorText = (e: unknown, fallback: string) => {
  const data = (e as ApiError)?.response?.data
  if (data?.reason && te('updates.reasons.' + data.reason)) return t('updates.reasons.' + data.reason)
  return data?.error || data?.message || fallback
}
// The page gave up waiting; the server is still working on the request.
const isTimeout = (e: unknown) => (e as { code?: string })?.code === 'ECONNABORTED'

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

function fmtDate(iso: string): string {
  return formatDateTime(iso)
}

function reasonText(action: UpdateActionState | undefined): string | null {
  if (!action || action.allowed || !action.reason) return null
  return t('updates.reasons.' + action.reason)
}

const diskFree = computed(() => {
  const vols = status.value?.disk?.volumes ?? []
  return vols.length ? Math.min(...vols.map((v) => v.freeBytes)) : 0
})

async function loadStatus() {
  try {
    const res = await serverApi.getUpdateStatus()
    if (res.success && res.data) status.value = res.data
  } catch { /* panel offline */ }
}

async function loadLists() {
  const [hist, snaps] = await Promise.allSettled([serverApi.getUpdateHistory(), serverApi.getJarSnapshots()])
  if (hist.status === 'fulfilled') history.value = hist.value.history
  if (snaps.status === 'fulfilled') snapshots.value = snaps.value.snapshots
}

async function loadDownloader(refresh = false) {
  try {
    const res = await serverApi.getDownloaderVersion(refresh)
    if (res.success && res.data) downloader.value = res.data
  } catch { /* container not running */ }
}

async function loadAll() {
  loading.value = true
  try {
    const [, cfg] = await Promise.allSettled([loadStatus(), serverApi.getUpdateConfig(), loadLists()])
    if (cfg.status === 'fulfilled') config.value = cfg.value
  } finally {
    loading.value = false
  }
  loadDownloader()
}

async function checkForUpdate() {
  checking.value = true
  try {
    const res = await serverApi.checkForNativeUpdate()
    if (res.data) status.value = res.data
    addToast(newerKnown.value ? t('updates.updateFound') : t('updates.upToDate'), 'info')
  } catch (e: unknown) {
    const data = (e as ApiError)?.response?.data as { data?: NativeUpdateStatus; authRequired?: boolean } | undefined
    if (data?.data) status.value = data.data
    const authRequired = data?.authRequired === true
    addToast(authRequired ? t('updates.checkNeedsDownloaderLogin') : errorText(e, t('updates.checkFailed')), 'error')
  } finally {
    checking.value = false
  }
}

async function download() {
  busy.value = true
  try {
    await serverApi.downloadNativeUpdate()
    addToast(t('updates.downloadRequested'), 'success')
  } catch (e: unknown) {
    addToast(errorText(e, t('updates.downloadFailed')), 'error')
  } finally {
    busy.value = false
    loadStatus()
  }
}

async function apply() {
  const s = status.value
  if (!s?.staged) return
  const version = s.staged.version || '—'
  const ok = await ask({
    title: t('updates.applyTitle'),
    message: s.serverRunning
      ? t('updates.applyConfirmRunning', { version })
      : t('updates.applyConfirmStopped', { version }),
    confirmText: t('updates.applyNow'),
    variant: 'danger',
  })
  if (!ok) return
  const allowPatchlineSwitch =
    !!s.staged.patchline && !!s.currentPatchline && s.staged.patchline !== s.currentPatchline
  if (allowPatchlineSwitch) {
    const switchOk = await ask({
      title: t('updates.applyTitle'),
      message: t('updates.patchlineMismatchConfirm', {
        version,
        staged: s.staged.patchline,
        installed: s.currentPatchline,
      }),
      confirmText: t('updates.applyAnyway'),
      variant: 'danger',
    })
    if (!switchOk) return
  }
  const force = !!s.disk?.checked && !s.disk.sufficient
  if (force && s.disk) {
    const diskOk = await ask({
      title: t('updates.diskTitle'),
      message: t('updates.diskLowConfirm', {
        free: fmtBytes(diskFree.value),
        required: fmtBytes(s.disk.requiredBytes),
      }),
      confirmText: t('updates.applyAnyway'),
      variant: 'danger',
    })
    if (!diskOk) return
  }
  busy.value = true
  try {
    const res = await serverApi.applyNativeUpdate({ force, allowPatchlineSwitch })
    addToast(res.message || t('updates.applyRequested'), 'success')
    setTimeout(loadAll, 5000)
  } catch (e: unknown) {
    addToast(errorText(e, t('updates.applyFailed')), 'error')
  } finally {
    busy.value = false
  }
}

async function discard() {
  const ok = await ask({
    title: t('updates.discardTitle'),
    message: t('updates.discardConfirm', { version: staged.value?.version || '—' }),
    confirmText: t('updates.discard'),
    variant: 'danger',
  })
  if (!ok) return
  busy.value = true
  try {
    const res = await serverApi.cancelNativeUpdate()
    if (res.discarded) {
      addToast(t('updates.discarded'), 'success')
      await loadStatus()
    } else {
      // A running server discards it itself, shortly after the command.
      addToast(t('updates.discardRequested'), 'info')
      setTimeout(loadStatus, 1500)
    }
  } catch (e: unknown) {
    addToast(errorText(e, t('updates.applyFailed')), 'error')
  } finally {
    busy.value = false
  }
}

async function saveConfig() {
  if (!config.value) return
  savingConfig.value = true
  try {
    let res
    try {
      res = await serverApi.saveUpdateConfig(config.value)
    } catch (e: unknown) {
      if (!(e as ApiError)?.response?.data?.requiresRestart) throw e
      // The server must be stopped to take the settings: offer the restart.
      const ok = await ask({
        title: t('updates.restartRequiredTitle'),
        message: t('updates.restartRequiredConfirm'),
        confirmText: t('updates.saveAndRestart'),
        variant: 'danger',
      })
      if (!ok) return
      res = await serverApi.saveUpdateConfig(config.value, { restart: true })
    }
    if (res.data) config.value = res.data
    addToast(res.restarted ? t('updates.configSavedRestarted') : t('updates.configSaved'), 'success')
  } catch (e: unknown) {
    if (isTimeout(e)) {
      addToast(t('updates.saveStillRunning'), 'warning', 8000)
      loadStatus()
    } else {
      addToast(errorText(e, t('updates.configSaveFailed')), 'error')
    }
  } finally {
    savingConfig.value = false
  }
}

async function createSnapshot() {
  busy.value = true
  try {
    const res = await serverApi.createJarSnapshot()
    if (res.success) {
      addToast(t('updates.snapshotCreated'), 'success')
      snapshots.value = (await serverApi.getJarSnapshots()).snapshots
    } else {
      addToast(res.error || t('updates.snapshotFailed'), 'error')
    }
  } catch (e: unknown) {
    addToast(errorText(e, t('updates.snapshotFailed')), 'error')
  } finally {
    busy.value = false
  }
}

async function runRollback(message: string, action: () => Promise<{ message?: string; warning?: string }>) {
  if (actionsLocked.value) return
  const ok = await ask({ title: t('updates.rollbackTitle'), message, confirmText: t('updates.rollbackNow'), variant: 'danger' })
  if (!ok || actionsLocked.value) return
  busy.value = true
  try {
    const res = await action()
    addToast(res.message || t('updates.rollbackStarted'), 'success')
    if (res.warning) addToast(res.warning, 'warning', 8000)
    await loadAll()
  } catch (e: unknown) {
    if (isTimeout(e)) {
      // Not a failure: the status poll keeps the buttons locked until it is done.
      addToast(t('updates.rollbackStillRunning'), 'warning', 10000)
      await loadStatus()
    } else {
      addToast(errorText(e, t('updates.rollbackFailed')), 'error')
    }
  } finally {
    busy.value = false
  }
}

// A downloaded update would be installed again by the next start, so the
// rollback discards it; the confirmation says so.
const stagedNote = () =>
  staged.value ? ' ' + t('updates.rollbackDiscardsStaged', { version: staged.value.version || '—' }) : ''

const rollback = (snap: JarSnapshot) =>
  runRollback(
    t('updates.rollbackConfirm', { version: snap.version || '—' }) +
      (snap.hasAssets ? '' : ' ' + t('updates.rollbackJarOnlyWarning')) +
      stagedNote(),
    () => serverApi.rollbackJar(snap.id, { discardStaged: !!staged.value }),
  )

const rollbackNative = () =>
  runRollback(
    t('updates.rollbackNativeConfirm', { version: status.value?.backup?.version || '—' }) + stagedNote(),
    () => serverApi.rollbackNative({ discardStaged: !!staged.value }),
  )

async function updateDownloader() {
  const ok = await ask({
    title: t('updates.downloader.update'),
    message: t('updates.downloader.updateConfirm'),
    confirmText: t('updates.downloader.update'),
    variant: 'primary',
  })
  if (!ok) return
  downloaderBusy.value = true
  try {
    const res = await serverApi.updateDownloader()
    if (res.data) downloader.value = res.data
    addToast(t('updates.downloader.updated'), 'success')
  } catch (e: unknown) {
    addToast(errorText(e, t('updates.downloader.updateFailed')), 'error')
  } finally {
    downloaderBusy.value = false
  }
}

async function checkDownloader() {
  downloaderBusy.value = true
  try {
    await loadDownloader(true)
  } finally {
    downloaderBusy.value = false
  }
}

let poll: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  loadAll()
  // The status comes from the files, so polling is cheap; a finished
  // download shows up as the staged version.
  poll = setInterval(() => {
    if (document.visibilityState !== 'hidden') loadStatus()
  }, 5000)
})
onUnmounted(() => { if (poll) clearInterval(poll) })
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('updates.title') }}</h1>
        <p class="text-sm text-ink-muted mt-1">{{ t('updates.subtitle') }}</p>
      </div>
      <button
        v-if="canCheck"
        @click="checkForUpdate"
        :disabled="checking"
        class="flex items-center gap-2 px-4 py-2 bg-surface-overlay text-ink rounded-lg hover:bg-border transition-colors disabled:opacity-50"
      >
        <svg class="w-4 h-4" :class="{ 'animate-spin': checking }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {{ t('updates.checkNow') }}
      </button>
    </div>

    <div v-if="loading" class="text-center py-12 text-ink-muted">{{ t('common.loading') }}</div>

    <template v-else-if="status">
      <!-- Version / action card -->
      <Card>
        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div class="flex items-center gap-4">
            <div
              class="w-14 h-14 rounded-xl flex items-center justify-center"
              :class="staged || newerKnown ? 'bg-hytale-orange/20' : 'bg-emerald-500/20'"
            >
              <svg class="w-7 h-7" :class="staged || newerKnown ? 'text-hytale-orange' : 'text-emerald-400'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
              </svg>
            </div>
            <div>
              <p class="text-sm text-ink-muted">{{ t('updates.installedVersion') }}</p>
              <p class="text-2xl font-bold text-ink">
                {{ status.currentVersion }}
                <span v-if="status.currentPatchline" class="text-sm font-normal text-ink-muted">({{ status.currentPatchline }})</span>
              </p>
              <p v-if="staged" class="text-sm text-hytale-orange mt-0.5">
                {{ t('updates.stagedReady', { version: staged.version || '—' }) }}
              </p>
              <p v-else-if="newerKnown" class="text-sm text-hytale-orange mt-0.5">
                {{ t('updates.newVersionAvailable', { version: lastCheck?.latestVersion }) }}
              </p>
              <p v-else-if="lastCheck && lastCheck.latestVersion !== 'unknown'" class="text-sm text-emerald-400 mt-0.5">{{ t('updates.upToDate') }}</p>
              <p class="text-xs text-ink-subtle mt-0.5">
                <template v-if="lastCheck">
                  {{ t('updates.latestOnPatchline', { patchline: lastCheck.patchline, version: lastCheck.latestVersion }) }}
                  · {{ t('updates.checkedAt', { time: fmtDate(lastCheck.checkedAt) }) }}
                </template>
                <template v-else>{{ t('updates.notChecked') }}</template>
              </p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <span class="px-2.5 py-1 rounded-full text-xs bg-surface-overlay text-ink-muted">{{ t('updates.states.' + status.state) }}</span>
            <button
              v-if="!staged && newerKnown && canDownload"
              @click="download"
              :disabled="actionsLocked || !status.actions.download.allowed"
              class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50"
            >
              {{ t('updates.download') }}
            </button>
            <button
              v-if="staged && canDownload"
              @click="discard"
              :disabled="actionsLocked || !status.actions.cancel.allowed"
              class="px-4 py-2 bg-surface-overlay text-ink rounded-lg font-medium hover:bg-border transition-colors disabled:opacity-50"
            >
              {{ t('updates.discard') }}
            </button>
            <button
              v-if="staged && canApply"
              @click="apply"
              :disabled="actionsLocked || ['staged_invalid', 'lifecycle_busy', 'no_updater'].includes(status.actions.apply.reason ?? '')"
              class="px-4 py-2 bg-emerald-500 text-white rounded-lg font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50"
            >
              {{ t('updates.applyNow') }}
            </button>
          </div>
        </div>

        <div class="mt-4 space-y-1 text-xs">
          <p v-if="!staged && newerKnown && reasonText(status.actions.download)" class="text-status-warning">
            {{ reasonText(status.actions.download) }}
          </p>
          <p v-else-if="!staged && newerKnown" class="text-ink-subtle">{{ t('updates.downloadHint') }}</p>
          <p v-if="staged" class="text-ink-subtle">
            {{ t('updates.stagedAt', { time: fmtDate(staged.stagedAt) }) }} · {{ fmtBytes(staged.jarBytes + staged.assetsBytes) }}
          </p>
          <p v-if="staged && status.actions.apply.reason === 'staged_invalid'" class="text-red-400">
            {{ reasonText(status.actions.apply) }}
          </p>
          <p
            v-if="staged && ['patchline_mismatch', 'lifecycle_busy'].includes(status.actions.apply.reason ?? '')"
            class="text-status-warning"
          >
            {{ reasonText(status.actions.apply) }}
          </p>
          <p v-if="staged && reasonText(status.actions.cancel)" class="text-ink-subtle">{{ t('updates.discard') }}: {{ reasonText(status.actions.cancel) }}</p>
          <p v-if="staged && status.disk?.checked" :class="status.disk.sufficient ? 'text-ink-subtle' : 'text-red-400'">
            {{ t('updates.diskTitle') }}:
            {{ status.disk.sufficient
              ? t('updates.diskOk', { required: fmtBytes(status.disk.requiredBytes), free: fmtBytes(diskFree) })
              : t('updates.diskLow', { required: fmtBytes(status.disk.requiredBytes), free: fmtBytes(diskFree) }) }}
          </p>
          <p v-if="status.layoutValid === false" class="text-status-warning">{{ t('updates.reasons.invalid_layout') }}</p>
          <p v-if="updaterProblem" class="text-status-warning">{{ updaterProblem }}</p>
          <p v-else-if="!status.updaterMounted" class="text-status-warning">{{ t('updates.reasons.no_updater') }}</p>
          <p v-if="lifecycleBusy" class="text-status-warning">{{ t('updates.reasons.lifecycle_busy') }}</p>
        </div>
      </Card>

      <!-- Native update settings (config.json "Update") -->
      <Card v-if="config" :title="t('updates.autoSettings')">
        <div class="space-y-4">
          <label class="flex items-center justify-between gap-4">
            <span>
              <span class="text-sm font-medium text-ink">{{ t('updates.enableAuto') }}</span>
              <span class="block text-xs text-ink-subtle">{{ t('updates.enableAutoDesc') }}</span>
            </span>
            <input v-model="config.enabled" :disabled="!canConfig" type="checkbox" class="accent-hytale-orange w-5 h-5" />
          </label>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('updates.patchline') }}</label>
              <input :value="config.patchline" disabled class="w-full bg-surface text-ink-muted px-4 py-2.5 rounded-lg border border-border" />
              <p class="text-xs text-ink-subtle mt-1">{{ t('updates.patchlineHint') }}</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('updates.autoApplyMode') }}</label>
              <select v-model="config.autoApplyMode" :disabled="!canConfig" class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none">
                <option value="DISABLED">{{ t('updates.modes.DISABLED') }}</option>
                <option value="WHEN_EMPTY">{{ t('updates.modes.WHEN_EMPTY') }}</option>
                <option value="SCHEDULED">{{ t('updates.modes.SCHEDULED') }}</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('updates.checkInterval') }}</label>
              <input v-model.number="config.checkIntervalSeconds" :disabled="!canConfig" type="number" min="60" class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none" />
            </div>
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('updates.autoApplyDelay') }}</label>
              <input v-model.number="config.autoApplyDelayMinutes" :disabled="!canConfig || config.autoApplyMode !== 'SCHEDULED'" type="number" min="1" class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none disabled:opacity-60" />
              <p class="text-xs text-ink-subtle mt-1">{{ t('updates.autoApplyDelayHint') }}</p>
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <label class="flex items-center gap-2">
              <input v-model="config.notifyPlayersOnAvailable" :disabled="!canConfig" type="checkbox" class="accent-hytale-orange" />
              <span class="text-sm text-ink-muted">{{ t('updates.notifyPlayers') }}</span>
            </label>
            <label class="flex items-center gap-2">
              <input v-model="config.runBackupBeforeUpdate" :disabled="!canConfig" type="checkbox" class="accent-hytale-orange" />
              <span class="text-sm text-ink-muted">{{ t('updates.backupBefore') }}</span>
            </label>
          </div>

          <div v-if="canConfig" class="flex justify-end">
            <button @click="saveConfig" :disabled="savingConfig || lifecycleBusy" class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50">
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- Rollback: previous version (updater/backup) + JAR snapshots -->
      <Card :title="t('updates.rollbackTitle')">
        <template v-if="canApply" #actions>
          <button @click="createSnapshot" :disabled="actionsLocked" class="flex items-center gap-2 px-3 py-1.5 bg-surface-overlay text-ink rounded-lg text-sm hover:bg-border transition-colors disabled:opacity-50">
            {{ t('updates.snapshotNow') }}
          </button>
        </template>
        <div class="space-y-3">
          <p class="text-sm text-ink-muted">{{ t('updates.rollbackDesc') }}</p>

          <div class="flex items-center gap-3 p-3 bg-surface rounded-lg">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-ink">{{ t('updates.previousVersion') }}</p>
              <p v-if="status.backup" class="text-xs text-ink-subtle">
                {{ t('updates.version') }} {{ status.backup.version || '—' }} · {{ fmtDate(status.backup.createdAt) }} ·
                {{ status.backup.hasAssets ? t('updates.withAssets') : t('updates.jarOnly') }}
              </p>
              <p v-else class="text-xs text-ink-subtle">{{ t('updates.noPreviousVersion') }}</p>
              <p v-if="status.backup" class="text-xs text-ink-subtle">{{ t('updates.previousVersionDesc') }}</p>
            </div>
            <button
              v-if="canApply && status.backup"
              @click="rollbackNative"
              :disabled="actionsLocked || !status.actions.rollbackNative.allowed"
              class="px-3 py-1.5 text-sm bg-surface-overlay text-ink rounded-lg hover:bg-red-500/20 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              {{ t('updates.rollbackNow') }}
            </button>
          </div>

          <div v-if="snapshots.length === 0" class="text-sm text-ink-subtle py-3 text-center">{{ t('updates.noSnapshots') }}</div>
          <div v-for="snap in snapshots" :key="snap.id" class="flex items-center gap-3 p-3 bg-surface rounded-lg">
            <div class="w-9 h-9 bg-surface-overlay rounded-lg flex items-center justify-center shrink-0">
              <svg class="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-ink">{{ t('updates.version') }} {{ snap.version || '—' }}</p>
              <p class="text-xs text-ink-subtle">
                {{ fmtDate(snap.createdAt) }} · {{ fmtBytes(snap.sizeBytes) }} ·
                {{ snap.hasAssets ? t('updates.withAssets') : t('updates.jarOnly') }}
              </p>
            </div>
            <button
              v-if="canApply"
              @click="rollback(snap)"
              :disabled="actionsLocked || status.actions.rollbackSnapshot?.allowed === false"
              class="px-3 py-1.5 text-sm bg-surface-overlay text-ink rounded-lg hover:bg-red-500/20 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              {{ t('updates.rollbackNow') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- Downloader version (reported; replaced only after confirmation) -->
      <Card :title="t('updates.downloader.title')">
        <template v-if="canCheck" #actions>
          <button @click="checkDownloader" :disabled="downloaderBusy" class="px-3 py-1.5 bg-surface-overlay text-ink rounded-lg text-sm hover:bg-border transition-colors disabled:opacity-50">
            {{ t('updates.downloader.check') }}
          </button>
        </template>
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div class="text-sm">
            <p class="text-ink-muted">{{ t('updates.downloader.desc') }}</p>
            <template v-if="downloader">
              <p v-if="!downloader.installed" class="text-ink-subtle mt-1">{{ t('updates.downloader.notInstalled') }}</p>
              <template v-else>
                <p class="text-ink mt-1">{{ t('updates.downloader.installed', { version: downloader.version || '—' }) }}</p>
                <p v-if="downloader.busy" class="text-status-warning">{{ t('updates.downloader.busy') }}</p>
                <p v-else-if="downloader.updateAvailable" class="text-hytale-orange">
                  {{ t('updates.downloader.updateAvailable', { version: downloader.latestVersion }) }}
                </p>
                <p v-else class="text-emerald-400">{{ t('updates.downloader.upToDate') }}</p>
              </template>
            </template>
          </div>
          <button
            v-if="canApply && downloader?.updateAvailable"
            @click="updateDownloader"
            :disabled="downloaderBusy"
            class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50 shrink-0"
          >
            {{ t('updates.downloader.update') }}
          </button>
        </div>
      </Card>

      <!-- History -->
      <Card :title="t('updates.history')">
        <div v-if="history.length === 0" class="text-sm text-ink-subtle py-3 text-center">{{ t('updates.noHistory') }}</div>
        <div v-else class="space-y-2">
          <div v-for="h in history" :key="h.id" class="flex items-center gap-3 p-2.5 bg-surface rounded-lg text-sm">
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="h.pending ? 'bg-amber-400' : h.success ? 'bg-emerald-400' : 'bg-red-400'"
            ></span>
            <span class="px-2 py-0.5 rounded text-xs shrink-0" :class="h.action === 'rollback' ? 'bg-amber-500/20 text-amber-400' : 'bg-sky-500/20 text-sky-400'">
              {{ t('updates.actions.' + h.action) }}
            </span>
            <span class="text-ink flex-1 min-w-0 truncate">
              {{ h.fromVersion || '—' }} → {{ h.toVersion || '—' }}
              <span v-if="h.pending" class="text-amber-400">· {{ t('updates.pending') }}</span>
              <span v-else-if="h.note" :class="h.success ? 'text-ink-subtle' : 'text-red-400'">· {{ h.note }}</span>
            </span>
            <span class="text-ink-subtle shrink-0 hidden sm:inline">{{ h.by || 'system' }}</span>
            <span class="text-ink-subtle shrink-0">{{ fmtDate(h.at) }}</span>
          </div>
        </div>
      </Card>
    </template>
  </div>
</template>
