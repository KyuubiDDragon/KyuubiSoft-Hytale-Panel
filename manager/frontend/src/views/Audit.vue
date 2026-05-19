<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api from '@/api/client'

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

const events = ref<AuditEvent[]>([])
const actions = ref<string[]>([])
const loading = ref(false)
const nextCursor = ref<number | null>(null)
const filter = ref<{ actor?: string; action?: string; from?: string; to?: string }>({})

async function load(reset = true) {
  loading.value = true
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

onMounted(() => {
  void load()
  void loadActions()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">Audit Log</h1>
      <button @click="exportCsv" class="px-3 py-1.5 rounded-lg bg-dark-100 hover:bg-dark-50 text-sm text-white">
        Export CSV
      </button>
    </div>

    <div class="card bg-dark-200 border border-dark-50/40 rounded-xl p-4">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
        <input v-model="filter.actor" placeholder="Actor (username)" class="input bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
        <select v-model="filter.action" class="bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white">
          <option value="">All actions</option>
          <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
        </select>
        <input v-model="filter.from" type="datetime-local" class="bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
        <input v-model="filter.to" type="datetime-local" class="bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <button @click="filter = {}; void load()" class="px-3 py-1.5 rounded-lg bg-dark-100 hover:bg-dark-50 text-sm text-gray-300">Reset</button>
        <button @click="void load()" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-sm text-white">Apply</button>
      </div>
    </div>

    <div class="bg-dark-200 border border-dark-50/40 rounded-xl overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-dark-100 text-gray-400 text-left">
          <tr>
            <th class="px-3 py-2">Time</th>
            <th class="px-3 py-2">Actor</th>
            <th class="px-3 py-2">Action</th>
            <th class="px-3 py-2">Target</th>
            <th class="px-3 py-2">IP</th>
            <th class="px-3 py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in events" :key="e.id" class="border-t border-dark-50/30">
            <td class="px-3 py-2 text-gray-300 whitespace-nowrap">{{ new Date(e.ts).toLocaleString() }}</td>
            <td class="px-3 py-2 text-white">{{ e.actorUsername }} <span class="text-[10px] text-gray-500">{{ e.actorType }}</span></td>
            <td class="px-3 py-2 text-hytale-orange font-mono">{{ e.action }}</td>
            <td class="px-3 py-2 text-gray-400">{{ e.target ?? '—' }}</td>
            <td class="px-3 py-2 text-gray-500 font-mono">{{ e.ip ?? '—' }}</td>
            <td class="px-3 py-2">
              <span v-if="e.success" class="text-status-success">✓</span>
              <span v-else class="text-status-error">✗</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="events.length === 0 && !loading" class="p-8 text-center text-gray-400">
        No events match the current filter.
      </div>
      <div v-if="nextCursor" class="p-4 text-center">
        <button @click="void load(false)" :disabled="loading" class="px-4 py-2 rounded-lg bg-dark-100 hover:bg-dark-50 text-sm text-white">
          {{ loading ? 'Loading…' : 'Load more' }}
        </button>
      </div>
    </div>
  </div>
</template>
