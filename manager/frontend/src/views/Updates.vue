<script setup lang="ts">
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
} from '@/api/server'

const { t } = useI18n()
const authStore = useAuthStore()
const { addToast } = useToast()
const { ask } = useConfirm()

const loading = ref(true)
const status = ref<NativeUpdateStatus | null>(null)
const config = ref<UpdateConfig | null>(null)
const history = ref<UpdateHistoryEntry[]>([])
const snapshots = ref<JarSnapshot[]>([])

const busy = ref(false)
const checking = ref(false)
const savingConfig = ref(false)

const canApply = computed(() => authStore.hasPermission('updates.apply'))
const canConfig = computed(() => authStore.hasPermission('updates.config'))
const canDownload = computed(() => authStore.hasPermission('updates.download'))
const canCheck = computed(() => authStore.hasPermission('updates.check'))

const updateAvailable = computed(() => {
  const s = status.value
  if (!s) return false
  return s.available || (s.state === 'READY') ||
    (s.latestVersion !== 'unknown' && s.currentVersion !== s.latestVersion && s.latestVersion !== s.currentVersion)
})

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

async function loadStatus() {
  try {
    const res = await serverApi.getUpdateStatus()
    if (res.success && res.data) status.value = res.data
  } catch { /* server may be offline */ }
}

async function loadAll() {
  loading.value = true
  try {
    const [, cfg, hist, snaps] = await Promise.allSettled([
      loadStatus(),
      serverApi.getUpdateConfig(),
      serverApi.getUpdateHistory(),
      serverApi.getJarSnapshots(),
    ])
    if (cfg.status === 'fulfilled') config.value = cfg.value
    if (hist.status === 'fulfilled') history.value = hist.value.history
    if (snaps.status === 'fulfilled') snapshots.value = snaps.value.snapshots
  } finally {
    loading.value = false
  }
}

async function checkForUpdate() {
  checking.value = true
  try {
    const res = await serverApi.checkForNativeUpdate()
    if (res.success && res.data) {
      status.value = res.data
      addToast(updateAvailable.value ? t('updates.updateFound') : t('updates.upToDate'), 'info')
    } else {
      addToast(res.error || res.message || t('updates.checkFailed'), 'error')
    }
  } catch (e: any) {
    addToast(e?.response?.data?.message || t('updates.checkFailed'), 'error')
  } finally {
    checking.value = false
  }
}

async function download() {
  busy.value = true
  try {
    const res = await serverApi.downloadNativeUpdate()
    if (res.success) {
      addToast(t('updates.downloadStarted'), 'success')
      setTimeout(loadStatus, 1500)
    } else {
      addToast(res.error || res.message || t('updates.downloadFailed'), 'error')
    }
  } finally {
    busy.value = false
  }
}

async function apply() {
  const ok = await ask({
    title: t('updates.applyTitle'),
    message: t('updates.applyConfirm'),
    confirmText: t('updates.applyNow'),
    variant: 'danger',
  })
  if (!ok) return
  busy.value = true
  try {
    const res = await serverApi.applyNativeUpdate()
    if (res.success) {
      addToast(res.message || t('updates.applyStarted'), 'success')
      setTimeout(loadAll, 3000)
    } else {
      addToast(res.error || res.message || t('updates.applyFailed'), 'error')
    }
  } finally {
    busy.value = false
  }
}

async function cancel() {
  busy.value = true
  try {
    await serverApi.cancelNativeUpdate()
    addToast(t('updates.cancelled'), 'info')
    setTimeout(loadStatus, 1000)
  } finally {
    busy.value = false
  }
}

async function saveConfig() {
  if (!config.value) return
  savingConfig.value = true
  try {
    const res = await serverApi.saveUpdateConfig(config.value)
    if (res.success) {
      if (res.data) config.value = res.data
      addToast(t('updates.configSaved'), 'success')
    } else {
      addToast(t('updates.configSaveFailed'), 'error')
    }
  } catch (e: any) {
    addToast(e?.response?.data?.error || t('updates.configSaveFailed'), 'error')
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
  } finally {
    busy.value = false
  }
}

async function rollback(snap: JarSnapshot) {
  const ok = await ask({
    title: t('updates.rollbackTitle'),
    message: t('updates.rollbackConfirm', { version: snap.version || '—' }),
    confirmText: t('updates.rollbackNow'),
    variant: 'danger',
  })
  if (!ok) return
  busy.value = true
  try {
    const res = await serverApi.rollbackJar(snap.id)
    if (res.success) {
      addToast(res.message || t('updates.rollbackStarted'), 'success')
      setTimeout(loadAll, 3000)
    } else {
      addToast(res.error || t('updates.rollbackFailed'), 'error')
    }
  } finally {
    busy.value = false
  }
}

let poll: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  loadAll()
  // Refresh status periodically so download/apply progress is visible live.
  poll = setInterval(loadStatus, 5000)
})
onUnmounted(() => { if (poll) clearInterval(poll) })

const stateLabel = computed(() => {
  const s = status.value?.state
  if (!s) return ''
  return t('updates.states.' + s)
})
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

    <template v-else>
      <!-- Version / action card -->
      <Card>
        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div class="flex items-center gap-4">
            <div
              class="w-14 h-14 rounded-xl flex items-center justify-center"
              :class="updateAvailable ? 'bg-hytale-orange/20' : 'bg-emerald-500/20'"
            >
              <svg class="w-7 h-7" :class="updateAvailable ? 'text-hytale-orange' : 'text-emerald-400'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
              </svg>
            </div>
            <div>
              <p class="text-sm text-ink-muted">{{ t('updates.installedVersion') }}</p>
              <p class="text-2xl font-bold text-ink">{{ status?.currentVersion || '—' }}</p>
              <p v-if="updateAvailable" class="text-sm text-hytale-orange mt-0.5">
                {{ t('updates.newVersionAvailable', { version: status?.latestVersion }) }}
              </p>
              <p v-else class="text-sm text-emerald-400 mt-0.5">{{ t('updates.upToDate') }}</p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <span class="px-2.5 py-1 rounded-full text-xs bg-surface-overlay text-ink-muted">{{ stateLabel }}</span>
            <span v-if="config" class="px-2.5 py-1 rounded-full text-xs bg-surface-overlay text-ink-muted">
              {{ t('updates.patchline') }}: {{ config.patchline }}
            </span>

            <button
              v-if="updateAvailable && status?.state !== 'READY' && status?.state !== 'DOWNLOADING' && canDownload"
              @click="download"
              :disabled="busy"
              class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50"
            >
              {{ t('updates.download') }}
            </button>
            <button
              v-if="status?.state === 'DOWNLOADING' && canDownload"
              @click="cancel"
              :disabled="busy"
              class="px-4 py-2 bg-surface-overlay text-ink rounded-lg font-medium hover:bg-border transition-colors disabled:opacity-50"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              v-if="status?.state === 'READY' && canApply"
              @click="apply"
              :disabled="busy"
              class="px-4 py-2 bg-emerald-500 text-white rounded-lg font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50"
            >
              {{ t('updates.applyNow') }}
            </button>
          </div>
        </div>

        <!-- Download progress -->
        <div v-if="status?.state === 'DOWNLOADING' && typeof status.progress === 'number'" class="mt-4">
          <div class="flex justify-between text-xs text-ink-muted mb-1">
            <span>{{ t('updates.downloading') }}</span>
            <span>{{ Math.round(status.progress) }}%</span>
          </div>
          <div class="h-2 w-full rounded-full bg-surface-overlay overflow-hidden">
            <div class="h-full bg-hytale-orange transition-all" :style="{ width: status.progress + '%' }"></div>
          </div>
        </div>
        <p v-if="status?.error" class="mt-3 text-sm text-red-400">{{ status.error }}</p>
      </Card>

      <!-- Auto-update settings -->
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
              <select v-model="config.patchline" :disabled="!canConfig" class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none">
                <option value="release">release</option>
                <option value="pre-release">pre-release</option>
              </select>
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
              <input v-model.number="config.autoApplyDelayMinutes" :disabled="!canConfig" type="number" min="1" class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none" />
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
            <button @click="saveConfig" :disabled="savingConfig" class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50">
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- Rollback / JAR snapshots -->
      <Card :title="t('updates.rollbackTitle')">
        <template v-if="canApply" #actions>
          <button @click="createSnapshot" :disabled="busy" class="flex items-center gap-2 px-3 py-1.5 bg-surface-overlay text-ink rounded-lg text-sm hover:bg-border transition-colors disabled:opacity-50">
            {{ t('updates.snapshotNow') }}
          </button>
        </template>
        <div class="space-y-3">
          <p class="text-sm text-ink-muted">{{ t('updates.rollbackDesc') }}</p>
          <div v-if="snapshots.length === 0" class="text-sm text-ink-subtle py-3 text-center">{{ t('updates.noSnapshots') }}</div>
          <div v-for="snap in snapshots" :key="snap.id" class="flex items-center gap-3 p-3 bg-surface rounded-lg">
            <div class="w-9 h-9 bg-surface-overlay rounded-lg flex items-center justify-center shrink-0">
              <svg class="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-ink">{{ t('updates.version') }} {{ snap.version || '—' }}</p>
              <p class="text-xs text-ink-subtle">{{ fmtDate(snap.createdAt) }} · {{ fmtBytes(snap.sizeBytes) }}</p>
            </div>
            <button
              v-if="canApply"
              @click="rollback(snap)"
              :disabled="busy"
              class="px-3 py-1.5 text-sm bg-surface-overlay text-ink rounded-lg hover:bg-red-500/20 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              {{ t('updates.rollbackNow') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- History -->
      <Card :title="t('updates.history')">
        <div v-if="history.length === 0" class="text-sm text-ink-subtle py-3 text-center">{{ t('updates.noHistory') }}</div>
        <div v-else class="space-y-2">
          <div v-for="h in history" :key="h.id" class="flex items-center gap-3 p-2.5 bg-surface rounded-lg text-sm">
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="h.success ? 'bg-emerald-400' : 'bg-red-400'"
            ></span>
            <span class="px-2 py-0.5 rounded text-xs shrink-0" :class="h.action === 'rollback' ? 'bg-amber-500/20 text-amber-400' : 'bg-sky-500/20 text-sky-400'">
              {{ t('updates.actions.' + h.action) }}
            </span>
            <span class="text-ink flex-1 min-w-0 truncate">
              {{ h.fromVersion || '—' }} → {{ h.toVersion || '—' }}
              <span v-if="h.note" class="text-red-400">· {{ h.note }}</span>
            </span>
            <span class="text-ink-subtle shrink-0 hidden sm:inline">{{ h.by || 'system' }}</span>
            <span class="text-ink-subtle shrink-0">{{ fmtDate(h.at) }}</span>
          </div>
        </div>
      </Card>
    </template>
  </div>
</template>
