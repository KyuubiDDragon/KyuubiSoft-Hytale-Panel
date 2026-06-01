<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import Card from '@/components/ui/Card.vue'

interface PlaytimeEntry {
  uuid: string
  playerName: string
  totalMs: number
  sessions: number
  lastSeen: string | null
  online: boolean
}

const { t } = useI18n()
const leaderboard = ref<PlaytimeEntry[]>([])
const loading = ref(true)
const error = ref('')
let timer: number | null = null

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return t('playtime.never')
  return new Date(iso).toLocaleString()
}

async function load() {
  try {
    const { data } = await api.get<{ leaderboard: PlaytimeEntry[] }>('/players/playtime', { params: { limit: 100 } })
    leaderboard.value = data.leaderboard
    error.value = ''
  } catch (e) {
    error.value = t('playtime.loadError')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 15000) as unknown as number
})
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold text-ink">{{ t('playtime.title') }}</h1>
      <p class="text-ink-muted mt-1">{{ t('playtime.subtitle') }}</p>
    </div>

    <Card :padding="false">
      <div v-if="error" class="p-4 text-status-error text-sm">{{ error }}</div>
      <div v-else-if="loading" class="p-8 text-center text-ink-subtle">{{ t('common.loading') }}</div>
      <div v-else-if="leaderboard.length === 0" class="p-8 text-center text-ink-subtle">{{ t('playtime.empty') }}</div>
      <table v-else class="table">
        <thead>
          <tr>
            <th class="w-16">#</th>
            <th>{{ t('playtime.player') }}</th>
            <th>{{ t('playtime.total') }}</th>
            <th class="hidden sm:table-cell">{{ t('playtime.sessions') }}</th>
            <th>{{ t('playtime.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, i) in leaderboard" :key="entry.uuid">
            <td class="font-mono text-ink-subtle">{{ i + 1 }}</td>
            <td class="font-medium text-ink">{{ entry.playerName }}</td>
            <td class="font-mono">{{ formatDuration(entry.totalMs) }}</td>
            <td class="hidden sm:table-cell text-ink-muted">{{ entry.sessions }}</td>
            <td>
              <span v-if="entry.online" class="badge badge-success">{{ t('playtime.online') }}</span>
              <span v-else class="text-ink-subtle text-xs">{{ formatLastSeen(entry.lastSeen) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  </div>
</template>
