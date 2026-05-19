<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api from '@/api/client'

interface Webhook {
  id: string
  name: string
  url: string
  type: 'discord' | 'slack' | 'generic'
  events: string[]
  enabled: boolean
  createdAt: string
}

const hooks = ref<Webhook[]>([])
const availableEvents = ref<string[]>([])
const showAdd = ref(false)
const form = ref<{ name: string; url: string; type: Webhook['type']; events: string[]; secret?: string }>({
  name: '', url: '', type: 'discord', events: [],
})

async function load() {
  const { data } = await api.get<{ webhooks: Webhook[]; availableEvents: string[] }>('/webhooks')
  hooks.value = data.webhooks
  availableEvents.value = data.availableEvents
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
  if (!confirm(`Delete webhook "${h.name}"?`)) return
  await api.delete(`/webhooks/${h.id}`)
  await load()
}

const testResult = ref<Record<string, { success: boolean; code: number | null; body: string | null } | null>>({})
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
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">Webhooks</h1>
      <button @click="showAdd = !showAdd" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-white text-sm">
        + Add Webhook
      </button>
    </div>

    <div v-if="showAdd" class="bg-dark-200 border border-dark-50/40 rounded-xl p-4 space-y-3">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <input v-model="form.name" placeholder="Name (e.g. Discord #ops)" class="bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
        <select v-model="form.type" class="bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white">
          <option value="discord">Discord</option>
          <option value="slack">Slack</option>
          <option value="generic">Generic HTTP (signed)</option>
        </select>
      </div>
      <input v-model="form.url" placeholder="https://discord.com/api/webhooks/…" class="w-full bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
      <input v-if="form.type === 'generic'" v-model="form.secret" placeholder="HMAC secret (X-KyuubiSoft-Signature)" class="w-full bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
      <div>
        <div class="text-sm text-gray-400 mb-2">Events</div>
        <div class="flex flex-wrap gap-2">
          <label v-for="ev in availableEvents" :key="ev" class="text-xs bg-dark-100 px-2 py-1 rounded-full cursor-pointer" :class="form.events.includes(ev) ? 'bg-hytale-orange text-white' : 'text-gray-300'">
            <input type="checkbox" class="hidden" :value="ev" v-model="form.events" />
            {{ ev }}
          </label>
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <button @click="showAdd = false" class="px-3 py-1.5 rounded-lg bg-dark-100 hover:bg-dark-50 text-sm text-gray-300">Cancel</button>
        <button @click="save" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-sm text-white">Create</button>
      </div>
    </div>

    <div class="space-y-2">
      <div v-for="h in hooks" :key="h.id" class="bg-dark-200 border border-dark-50/40 rounded-xl p-4 flex items-start gap-4">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-medium text-white">{{ h.name }}</span>
            <span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-dark-100 text-gray-400">{{ h.type }}</span>
            <span v-if="!h.enabled" class="text-[10px] uppercase tracking-wider text-status-warning">disabled</span>
          </div>
          <div class="text-xs text-gray-400 font-mono truncate">{{ h.url }}</div>
          <div class="text-xs text-gray-500 mt-1">{{ h.events.length }} event{{ h.events.length === 1 ? '' : 's' }}</div>
          <div v-if="testResult[h.id]" class="text-xs mt-2" :class="testResult[h.id]?.success ? 'text-status-success' : 'text-status-error'">
            Test: HTTP {{ testResult[h.id]?.code ?? '—' }} — {{ testResult[h.id]?.body?.slice(0, 80) }}
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <button @click="test(h)" class="px-2 py-1 text-xs rounded bg-dark-100 hover:bg-dark-50 text-gray-300">Test</button>
          <button @click="toggle(h)" class="px-2 py-1 text-xs rounded bg-dark-100 hover:bg-dark-50 text-gray-300">{{ h.enabled ? 'Disable' : 'Enable' }}</button>
          <button @click="remove(h)" class="px-2 py-1 text-xs rounded bg-dark-100 hover:bg-status-error/30 text-status-error">Delete</button>
        </div>
      </div>
      <div v-if="hooks.length === 0" class="bg-dark-200 border border-dark-50/40 rounded-xl p-8 text-center text-gray-400">
        No webhooks configured. Add one to receive server events on Discord, Slack or a generic endpoint.
      </div>
    </div>
  </div>
</template>
