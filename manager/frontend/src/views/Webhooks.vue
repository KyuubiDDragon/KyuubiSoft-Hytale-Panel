<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import ErrorState from '@/components/ui/ErrorState.vue'
import EmptyTableState from '@/components/ui/EmptyTableState.vue'
import ResponsiveTable, { type TableColumn } from '@/components/ui/ResponsiveTable.vue'

interface Webhook {
  id: string
  name: string
  url: string
  type: 'discord' | 'slack' | 'generic'
  events: string[]
  enabled: boolean
  createdAt: string
}

const { t } = useI18n()

const hooks = ref<Webhook[]>([])
const availableEvents = ref<string[]>([])
const loading = ref(true)
const error = ref('')

const showAdd = ref(false)
const form = ref<{ name: string; url: string; type: Webhook['type']; events: string[]; secret?: string }>({
  name: '', url: '', type: 'discord', events: [],
})

const testResult = ref<Record<string, { success: boolean; code: number | null; body: string | null } | null>>({})

const columns = computed<TableColumn[]>(() => [
  { key: 'name', label: t('webhooks.name') },
  { key: 'url', label: t('webhooks.url') },
  { key: 'events', label: t('webhooks.events'), align: 'center', width: '7rem' },
  { key: 'status', label: t('webhooks.status'), align: 'center', width: '7rem' },
])

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get<{ webhooks: Webhook[]; availableEvents: string[] }>('/webhooks')
    hooks.value = data.webhooks
    availableEvents.value = data.availableEvents
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!form.value.name || !form.value.url || form.value.events.length === 0) return
  await api.post('/webhooks', form.value)
  showAdd.value = false
  form.value = { name: '', url: '', type: 'discord', events: [] }
  await load()
}

async function toggle(h: Webhook) {
  await api.put(`/webhooks/${h.id}`, { enabled: !h.enabled })
  await load()
}

async function remove(h: Webhook) {
  if (!confirm(t('webhooks.confirmDelete', { name: h.name }))) return
  await api.delete(`/webhooks/${h.id}`)
  await load()
}

async function test(h: Webhook) {
  testResult.value[h.id] = null
  try {
    const { data } = await api.post<{ success: boolean; code: number | null; body: string | null }>(`/webhooks/${h.id}/test`)
    testResult.value[h.id] = data
  } catch (err) {
    testResult.value[h.id] = { success: false, code: null, body: (err as Error).message }
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('webhooks.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('webhooks.subtitle') }}</p>
      </div>
      <Button @click="showAdd = !showAdd" class="flex items-center gap-2">
        <Icon name="plus" class="w-5 h-5" />
        {{ t('webhooks.add') }}
      </Button>
    </div>

    <!-- Add Form -->
    <Card v-if="showAdd">
      <div class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            v-model="form.name"
            :placeholder="t('webhooks.namePlaceholder')"
            class="input"
            :aria-label="t('webhooks.name')"
          />
          <select v-model="form.type" class="input" :aria-label="t('webhooks.type')">
            <option value="discord">Discord</option>
            <option value="slack">Slack</option>
            <option value="generic">{{ t('webhooks.typeGeneric') }}</option>
          </select>
        </div>
        <input
          v-model="form.url"
          :placeholder="t('webhooks.urlPlaceholder')"
          class="input"
          :aria-label="t('webhooks.url')"
        />
        <input
          v-if="form.type === 'generic'"
          v-model="form.secret"
          :placeholder="t('webhooks.secretPlaceholder')"
          class="input"
          :aria-label="t('webhooks.secret')"
        />
        <div>
          <div class="text-sm text-ink-muted mb-2">{{ t('webhooks.events') }}</div>
          <div class="flex flex-wrap gap-2">
            <label
              v-for="ev in availableEvents"
              :key="ev"
              :class="[
                'text-xs px-2 py-1 rounded-full cursor-pointer transition-colors',
                form.events.includes(ev)
                  ? 'bg-hytale-orange text-ink-inverse'
                  : 'bg-surface-overlay text-ink-muted hover:text-ink',
              ]"
            >
              <input type="checkbox" class="sr-only" :value="ev" v-model="form.events" />
              {{ ev }}
            </label>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="secondary" size="sm" @click="showAdd = false">{{ t('common.cancel') }}</Button>
          <Button size="sm" @click="save">{{ t('webhooks.create') }}</Button>
        </div>
      </div>
    </Card>

    <!-- Body -->
    <ErrorState
      v-if="error && hooks.length === 0"
      :message="error"
      @retry="load"
    />

    <div v-else-if="loading && hooks.length === 0" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" height="4rem" />
    </div>

    <EmptyTableState
      v-else-if="hooks.length === 0"
      icon="chat"
      :title="t('webhooks.noHooks')"
      :subtitle="t('webhooks.noHooksSubtitle')"
    >
      <Button size="sm" @click="showAdd = true">{{ t('webhooks.add') }}</Button>
    </EmptyTableState>

    <ResponsiveTable
      v-else
      :columns="columns"
      :rows="hooks"
      row-key="id"
      :aria-label="t('webhooks.title')"
      :mobile-card-label="(h) => h.name"
    >
      <template #cell:name="{ row }">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-medium text-ink">{{ row.name }}</span>
            <span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-overlay text-ink-muted">
              {{ row.type }}
            </span>
          </div>
          <div v-if="testResult[row.id]" class="text-xs" :class="testResult[row.id]?.success ? 'text-status-success' : 'text-status-error'">
            {{ t('webhooks.testResult') }}: HTTP {{ testResult[row.id]?.code ?? '—' }}
          </div>
        </div>
      </template>
      <template #cell:url="{ row }">
        <span class="font-mono text-xs text-ink-muted break-all">{{ row.url }}</span>
      </template>
      <template #cell:events="{ row }">
        <span class="text-sm text-ink-muted">{{ t('webhooks.eventCount', { count: row.events.length }) }}</span>
      </template>
      <template #cell:status="{ row }">
        <span
          :class="[
            'inline-flex px-2 py-0.5 rounded text-xs font-medium',
            row.enabled
              ? 'bg-status-success/20 text-status-success'
              : 'bg-surface-overlay text-ink-subtle',
          ]"
        >
          {{ row.enabled ? t('common.enabled') : t('common.disabled') }}
        </span>
      </template>
      <template #actions="{ row }">
        <Button variant="secondary" size="sm" @click="test(row)">{{ t('webhooks.test') }}</Button>
        <Button variant="secondary" size="sm" @click="toggle(row)">
          {{ row.enabled ? t('common.disabled') : t('common.enabled') }}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon-only
          class="!text-ink-muted hover:!text-status-error"
          :aria-label="t('common.delete')"
          @click="remove(row)"
        >
          <Icon name="trash" class="w-5 h-5" />
        </Button>
      </template>
    </ResponsiveTable>
  </div>
</template>
