<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import ErrorState from '@/components/ui/ErrorState.vue'
import EmptyTableState from '@/components/ui/EmptyTableState.vue'
import ResponsiveTable, { type TableColumn } from '@/components/ui/ResponsiveTable.vue'

interface AuditEvent {
  id: number
  ts: string
  actorUsername: string
  actorType: string
  action: string
  target: string | null
  ip: string | null
  metadata: Record<string, unknown> | null
  success: boolean
}

const { t } = useI18n()
const events = ref<AuditEvent[]>([])
const actions = ref<string[]>([])
const loading = ref(false)
const error = ref('')
const nextCursor = ref<number | null>(null)
const filter = ref<{ actor?: string; action?: string; from?: string; to?: string }>({})

const columns: TableColumn[] = [
  { key: 'ts', label: t('audit.time'), nowrap: true },
  { key: 'actor', label: t('audit.actor') },
  { key: 'action', label: t('audit.action') },
  { key: 'target', label: t('audit.target') },
  { key: 'ip', label: t('audit.ip'), hideOnMobile: true },
  { key: 'success', label: t('audit.result'), align: 'center', width: '6rem' },
]

async function load(reset = true) {
  loading.value = true
  if (reset) error.value = ''
  try {
    const params: Record<string, string | number> = { limit: 50 }
    if (filter.value.actor) params.actor = filter.value.actor
    if (filter.value.action) params.action = filter.value.action
    if (filter.value.from) params.from = filter.value.from
    if (filter.value.to) params.to = filter.value.to
    if (!reset && nextCursor.value) params.cursor = nextCursor.value
    const { data } = await api.get<{ events: AuditEvent[]; nextCursor: number | null }>('/audit-log', { params })
    events.value = reset ? data.events : [...events.value, ...data.events]
    nextCursor.value = data.nextCursor
  } catch (err) {
    console.error('audit load failed', err)
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function loadActions() {
  try {
    const { data } = await api.get<{ actions: string[] }>('/audit-log/actions')
    actions.value = data.actions
  } catch { /* */ }
}

function exportCsv() {
  const params = new URLSearchParams({ format: 'csv' })
  if (filter.value.actor) params.set('actor', filter.value.actor)
  if (filter.value.action) params.set('action', filter.value.action)
  if (filter.value.from) params.set('from', filter.value.from)
  if (filter.value.to) params.set('to', filter.value.to)
  window.open(`/api/audit-log/export?${params.toString()}`, '_blank')
}

function resetFilter() {
  filter.value = {}
  void load()
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleString()
}

onMounted(() => {
  void load()
  void loadActions()
})
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('audit.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('audit.subtitle') }}</p>
      </div>
      <Button variant="secondary" size="sm" @click="exportCsv">
        <Icon name="download" class="w-4 h-4 mr-2" />
        {{ t('audit.exportCsv') }}
      </Button>
    </div>

    <!-- Filters -->
    <Card>
      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <input
          v-model="filter.actor"
          :placeholder="t('audit.actorPlaceholder')"
          class="input"
          :aria-label="t('audit.actor')"
        />
        <select v-model="filter.action" class="input" :aria-label="t('audit.action')">
          <option value="">{{ t('audit.allActions') }}</option>
          <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
        </select>
        <input
          v-model="filter.from"
          type="datetime-local"
          class="input"
          :aria-label="t('audit.from')"
        />
        <input
          v-model="filter.to"
          type="datetime-local"
          class="input"
          :aria-label="t('audit.to')"
        />
      </div>
      <div class="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" @click="resetFilter">{{ t('common.clear') }}</Button>
        <Button size="sm" @click="() => load()">{{ t('audit.apply') }}</Button>
      </div>
    </Card>

    <!-- Body -->
    <ErrorState
      v-if="error && events.length === 0"
      :message="error"
      @retry="() => load()"
    />

    <div v-else-if="loading && events.length === 0" class="space-y-2">
      <Skeleton v-for="i in 5" :key="i" height="3rem" />
    </div>

    <EmptyTableState
      v-else-if="events.length === 0"
      icon="activity"
      :title="t('audit.noEvents')"
      :subtitle="t('audit.noEventsSubtitle')"
    />

    <template v-else>
      <ResponsiveTable
        :columns="columns"
        :rows="events"
        row-key="id"
        :aria-label="t('audit.title')"
        :mobile-card-label="(e) => `${e.action} — ${e.actorUsername}`"
      >
        <template #cell:ts="{ row }">
          <span class="text-ink-muted whitespace-nowrap">{{ formatTime(row.ts) }}</span>
        </template>
        <template #cell:actor="{ row }">
          <span class="text-ink font-medium">{{ row.actorUsername }}</span>
          <span class="ml-1 text-xs text-ink-subtle">{{ row.actorType }}</span>
        </template>
        <template #cell:action="{ row }">
          <span class="font-mono text-sm text-hytale-orange break-all">{{ row.action }}</span>
        </template>
        <template #cell:target="{ row }">
          <span class="text-ink-muted break-all">{{ row.target ?? '—' }}</span>
        </template>
        <template #cell:ip="{ row }">
          <span class="font-mono text-xs text-ink-subtle">{{ row.ip ?? '—' }}</span>
        </template>
        <template #cell:success="{ row }">
          <span
            v-if="row.success"
            class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-status-success/20 text-status-success"
            :aria-label="t('audit.success')"
            role="img"
          >
            <Icon name="check" class="w-4 h-4" />
          </span>
          <span
            v-else
            class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-status-error/20 text-status-error"
            :aria-label="t('audit.failed')"
            role="img"
          >
            <Icon name="close" class="w-4 h-4" />
          </span>
        </template>
      </ResponsiveTable>

      <div v-if="nextCursor" class="flex justify-center">
        <Button variant="secondary" size="sm" :loading="loading" @click="() => load(false)">
          {{ t('common.loadMore') }}
        </Button>
      </div>
    </template>
  </div>
</template>
