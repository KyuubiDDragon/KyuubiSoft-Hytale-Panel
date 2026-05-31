<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface PublicStatus {
  serverName: string
  motd: string
  online: boolean
  playerCount: number
  maxPlayers: number | null
  version: string | null
  tps: number | null
}

const status = ref<PublicStatus | null>(null)
const loading = ref(true)
const disabled = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    const r = await fetch('/api/public/status')
    if (r.status === 404) { disabled.value = true; return }
    if (r.ok) { status.value = await r.json(); disabled.value = false }
  } catch {
    // network error — keep last known value
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 15000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="min-h-screen bg-surface text-ink flex items-center justify-center p-4">
    <div class="w-full max-w-md rounded-2xl border border-border bg-surface-raised shadow-2xl overflow-hidden">
      <div class="px-6 py-8 text-center">
        <div v-if="loading" class="text-ink-muted py-12">Loading…</div>

        <div v-else-if="disabled" class="py-12">
          <div class="text-ink-muted">The public status page is not enabled for this server.</div>
        </div>

        <template v-else-if="status">
          <h1 class="text-2xl font-bold mb-1">{{ status.serverName }}</h1>
          <p v-if="status.motd" class="text-ink-muted mb-6">{{ status.motd }}</p>

          <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium mb-6"
               :class="status.online ? 'bg-status-success/15 text-status-success' : 'bg-status-error/15 text-status-error'">
            <span class="w-2 h-2 rounded-full" :class="status.online ? 'bg-status-success' : 'bg-status-error'" />
            {{ status.online ? 'Online' : 'Offline' }}
          </div>

          <div v-if="status.online" class="grid grid-cols-3 gap-3 text-center">
            <div class="rounded-lg bg-surface-overlay p-3">
              <div class="text-2xl font-bold">{{ status.playerCount }}<span v-if="status.maxPlayers" class="text-ink-muted text-base">/{{ status.maxPlayers }}</span></div>
              <div class="text-xs text-ink-muted mt-1">Players</div>
            </div>
            <div class="rounded-lg bg-surface-overlay p-3">
              <div class="text-2xl font-bold">{{ status.tps ?? '—' }}</div>
              <div class="text-xs text-ink-muted mt-1">TPS</div>
            </div>
            <div class="rounded-lg bg-surface-overlay p-3">
              <div class="text-sm font-bold truncate" :title="status.version ?? ''">{{ status.version ?? '—' }}</div>
              <div class="text-xs text-ink-muted mt-1">Version</div>
            </div>
          </div>
        </template>
      </div>
      <div class="px-6 py-3 border-t border-border text-center text-xs text-ink-muted">
        Powered by KyuubiSoft Panel
      </div>
    </div>
  </div>
</template>
