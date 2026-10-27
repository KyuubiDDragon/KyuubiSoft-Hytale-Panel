<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import PageHeader from '@/components/ui/PageHeader.vue'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import ModPanelSnapshotView from '@/components/modPanel/ModPanelSnapshotView.vue'
import ModActionDialog from '@/components/modPanel/ModActionDialog.vue'
import {
  modPanelApi,
  type ModPanelAction,
  type ModPanelActionResult,
  type ModPanelList,
  type ModPanelSnapshotResponse,
  type ModPanelValue,
} from '@/api/modPanel'

/**
 * Mod status: status pages and admin actions that KS mods (Pets, ...) register
 * with the KyuubiSoft API plugin. Read with mods.panel.view, actions need
 * mods.panel.action and land in the audit log.
 */
const AUTO_REFRESH_MS = 15_000

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const toast = useToast()

const list = ref<ModPanelList | null>(null)
const listLoading = ref(true)
const listError = ref('')
const current = ref<ModPanelSnapshotResponse | null>(null)
const snapshotLoading = ref(false)
const snapshotError = ref('')
const autoRefresh = ref(true)
const dialogAction = ref<ModPanelAction | null>(null)
const runningAction = ref<string | null>(null)
const lastResult = ref<{ action: string; result: ModPanelActionResult } | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const canRun = computed(() => authStore.hasPermission('mods.panel.action'))
// Actions the mod marks dangerous also need the admin console tier (checked by the backend too).
const canRunDangerous = computed(() => authStore.hasPermission('console.execute.admin'))
const selectedId = computed(() => {
  const id = route.params.id
  return typeof id === 'string' && id ? id : (list.value?.providers[0]?.id ?? null)
})
const selectedProvider = computed(
  () => list.value?.providers.find((p) => p.id === selectedId.value) ?? null,
)
const actions = computed(() => current.value?.actions ?? selectedProvider.value?.actions ?? [])

function errorText(error: unknown): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data
  return data?.error || t('common.errorLoading')
}

async function loadList(): Promise<void> {
  try {
    list.value = await modPanelApi.list(locale.value)
    listError.value = ''
  } catch (error) {
    listError.value = errorText(error)
  } finally {
    listLoading.value = false
  }
}

async function loadSnapshot(): Promise<void> {
  const id = selectedId.value
  if (!id || snapshotLoading.value) return
  snapshotLoading.value = true
  try {
    const response = await modPanelApi.snapshot(id, locale.value)
    if (id === selectedId.value) {
      current.value = response
      snapshotError.value = ''
    }
  } catch (error) {
    if (id === selectedId.value) snapshotError.value = errorText(error)
  } finally {
    snapshotLoading.value = false
  }
  // The admin picked another mod while this request ran: load that one now.
  if (id !== selectedId.value) await loadSnapshot()
}

async function refresh(): Promise<void> {
  await loadList()
  await loadSnapshot()
}

function select(id: string): void {
  if (id === selectedId.value) return
  current.value = null
  snapshotError.value = ''
  lastResult.value = null
  void router.replace({ name: 'modStatus', params: { id } })
}

function startAction(action: ModPanelAction): void {
  if (action.params.length > 0 || action.requiresConfirmation) {
    dialogAction.value = action
    return
  }
  void runAction(action, {})
}

async function runAction(action: ModPanelAction, params: Record<string, ModPanelValue>): Promise<void> {
  const id = selectedId.value
  if (!id) return
  runningAction.value = action.id
  try {
    const result = await modPanelApi.runAction(id, action.id, params, action.requiresConfirmation, locale.value)
    lastResult.value = { action: action.label, result }
    const message = result.message || t(`modPanel.status.${result.status}`)
    if (result.success) toast.success(message)
    else toast.error(message)
    dialogAction.value = null
    await loadSnapshot()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    runningAction.value = null
  }
}

function unavailableText(reason?: string): string {
  return t(`modPanel.unavailable.${reason ?? 'error'}`)
}

function formatTime(iso?: string): string {
  return iso ? new Date(iso).toLocaleTimeString() : ''
}

watch(selectedId, () => void loadSnapshot())

onMounted(async () => {
  await refresh()
  timer = setInterval(() => {
    if (autoRefresh.value && !document.hidden && !dialogAction.value) void loadSnapshot()
  }, AUTO_REFRESH_MS)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('modPanel.title')" :subtitle="t('modPanel.subtitle')">
      <template #actions>
        <label class="flex items-center gap-2 text-sm text-ink-muted">
          <input v-model="autoRefresh" type="checkbox" class="rounded" />
          {{ t('modPanel.autoRefresh') }}
        </label>
        <Button variant="secondary" size="sm" :loading="snapshotLoading" @click="refresh">
          {{ t('common.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <Card v-if="listLoading">
      <p class="text-center text-ink-subtle py-6">{{ t('common.loading') }}</p>
    </Card>

    <Card v-else-if="listError">
      <p class="text-status-error text-sm">{{ listError }}</p>
    </Card>

    <Card v-else-if="list && !list.available">
      <EmptyState :title="t('modPanel.unavailableTitle')" :description="unavailableText(list.reason)" />
      <p v-if="list.error" class="text-xs text-ink-subtle text-center font-mono">{{ list.error }}</p>
    </Card>

    <Card v-else-if="list && list.providers.length === 0">
      <EmptyState :title="t('modPanel.emptyTitle')" :description="t('modPanel.emptyDescription')" />
    </Card>

    <div v-else-if="list" class="grid grid-cols-1 lg:grid-cols-[16rem_1fr] gap-6">
      <nav class="space-y-1" :aria-label="t('modPanel.providers')">
        <button
          v-for="provider in list.providers"
          :key="provider.id"
          type="button"
          class="w-full text-left px-3 py-2 rounded-lg transition-colors"
          :class="provider.id === selectedId
            ? 'bg-hytale-orange/10 text-hytale-orange'
            : 'text-ink-muted hover:bg-surface-muted/60 hover:text-ink'"
          :aria-current="provider.id === selectedId ? 'page' : undefined"
          @click="select(provider.id)"
        >
          <span class="block text-sm font-medium truncate">{{ provider.displayName }}</span>
          <span class="block text-xs text-ink-subtle truncate">{{ provider.version ? `v${provider.version}` : provider.id }}</span>
        </button>
      </nav>

      <div class="space-y-6 min-w-0">
        <Card>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <h2 class="text-lg font-semibold text-ink truncate">
                {{ current?.displayName ?? selectedProvider?.displayName }}
                <span v-if="current?.version ?? selectedProvider?.version" class="text-sm font-normal text-ink-subtle">
                  v{{ current?.version ?? selectedProvider?.version }}
                </span>
              </h2>
              <p v-if="current?.description ?? selectedProvider?.description" class="text-sm text-ink-muted">
                {{ current?.description ?? selectedProvider?.description }}
              </p>
            </div>
            <div class="flex items-center gap-2 text-xs text-ink-subtle">
              <Badge v-if="current && current.status !== 'ok'" :variant="current.status === 'busy' ? 'warning' : 'error'">
                {{ t(`modPanel.status.${current.status}`) }}
              </Badge>
              <span v-if="current?.generatedAt">{{ t('modPanel.updatedAt', { time: formatTime(current.generatedAt) }) }}</span>
            </div>
          </div>
        </Card>

        <Card v-if="actions.length && canRun" :title="t('modPanel.actions')">
          <div class="flex flex-wrap gap-2">
            <Button
              v-for="action in actions"
              :key="action.id"
              size="sm"
              :variant="action.dangerous ? 'danger' : 'secondary'"
              :loading="runningAction === action.id"
              :disabled="runningAction !== null || (action.dangerous && !canRunDangerous)"
              :title="action.dangerous && !canRunDangerous ? t('modPanel.dangerousNeedsAdmin') : undefined"
              :aria-label="action.description || action.label"
              @click="startAction(action)"
            >
              {{ action.label }}
            </Button>
          </div>
          <div v-if="lastResult" class="mt-4 text-sm" role="status">
            <p :class="lastResult.result.success ? 'text-status-success' : 'text-status-error'">
              {{ lastResult.action }}: {{ lastResult.result.message || t(`modPanel.status.${lastResult.result.status}`) }}
            </p>
            <dl v-if="lastResult.result.data && Object.keys(lastResult.result.data).length" class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <template v-for="(value, key) in lastResult.result.data" :key="key">
                <dt class="text-ink-subtle font-mono">{{ key }}</dt>
                <dd class="text-ink">{{ value === null ? '–' : String(value) }}</dd>
              </template>
            </dl>
          </div>
        </Card>

        <Card v-if="snapshotError">
          <p class="text-status-error text-sm">{{ snapshotError }}</p>
        </Card>
        <Card v-else-if="current && current.status !== 'ok'">
          <p class="text-sm text-status-error">{{ current.error || t(`modPanel.status.${current.status}`) }}</p>
        </Card>
        <Card v-else-if="!current">
          <p class="text-center text-ink-subtle py-6">{{ t('common.loading') }}</p>
        </Card>
        <ModPanelSnapshotView v-else-if="current.snapshot" :snapshot="current.snapshot" />
      </div>
    </div>

    <ModActionDialog
      :open="dialogAction !== null"
      :action="dialogAction"
      :running="runningAction !== null"
      @close="dialogAction = null"
      @submit="(params) => dialogAction && runAction(dialogAction, params)"
    />
  </div>
</template>
