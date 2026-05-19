<script setup lang="ts">
/**
 * Replay segments list + lightweight in-browser player.
 *
 * The player consumes the backend's SSE endpoint, which decompresses the
 * gzipped NDJSON segment server-side and pushes one tick per `data:` event.
 * We render the events as a chronological feed plus a derived chat log.
 */
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import { useAuthStore } from '@/stores/auth'

interface ReplayManifest {
  id: string
  startedAt: string
  endedAt: string
  durationMs: number
  playerCount: number
  eventCount: number
  sizeBytes: number
}

interface ReplayConfig {
  recordingEnabled: boolean
  retentionDays: number
}

interface PanelEvent {
  name: string
  ts: number
  payload: Record<string, unknown>
}

const { t } = useI18n()
const authStore = useAuthStore()

const segments = ref<ReplayManifest[]>([])
const cfg = ref<ReplayConfig>({ recordingEnabled: false, retentionDays: 7 })
const cfgDraft = ref<ReplayConfig>({ recordingEnabled: false, retentionDays: 7 })
const loading = ref(false)
const saving = ref(false)
const error = ref('')

// Player state
const activeSegment = ref<ReplayManifest | null>(null)
const playerEvents = ref<PanelEvent[]>([])
const isPlaying = ref(false)
const playbackSpeed = ref(1)
const playbackTs = ref<number>(0) // current displayed timestamp (ms)
const segmentStart = ref<number>(0)
const segmentEnd = ref<number>(0)
let evtSource: EventSource | null = null
let playbackTimer: number | null = null

const canManage = computed(() => authStore.hasPermission('replay.manage'))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [segs, c] = await Promise.all([
      api.get<{ segments: ReplayManifest[] }>('/replay'),
      api.get<ReplayConfig>('/replay/config'),
    ])
    segments.value = segs.data.segments
    cfg.value = c.data
    cfgDraft.value = { ...c.data }
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }, message?: string }
    error.value = e.response?.data?.error || e.message || 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function saveConfig() {
  saving.value = true
  try {
    const { data } = await api.put<ReplayConfig>('/replay/config', cfgDraft.value)
    cfg.value = data
    cfgDraft.value = { ...data }
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }, message?: string }
    error.value = e.response?.data?.error || e.message || 'Save failed'
  } finally {
    saving.value = false
  }
}

async function exportSegment(id: string) {
  try {
    const { data } = await api.post<{ downloadUrl: string }>(`/replay/${id}/export`)
    window.open(data.downloadUrl, '_blank')
  } catch (err) {
    console.error('[replay] export failed', err)
  }
}

async function deleteSegment(id: string) {
  if (!window.confirm(t('replay.deleteConfirm'))) return
  await api.delete(`/replay/${id}`)
  await load()
}

function openPlayer(seg: ReplayManifest) {
  activeSegment.value = seg
  playerEvents.value = []
  segmentStart.value = new Date(seg.startedAt).getTime()
  segmentEnd.value = new Date(seg.endedAt).getTime()
  playbackTs.value = segmentStart.value
  isPlaying.value = true

  // SSE doesn't normally carry an Authorization header; for the demo build
  // we rely on session-cookie auth or token-in-query. The same-origin call
  // works with the panel's existing cookie store.
  const url = `/api/replay/${seg.id}/stream${authStore.accessToken ? `?token=${encodeURIComponent(authStore.accessToken)}` : ''}`
  evtSource = new EventSource(url)
  evtSource.onmessage = (ev) => {
    try {
      const evt = JSON.parse(ev.data) as PanelEvent
      playerEvents.value.push(evt)
    } catch { /* ignore malformed line */ }
  }
  evtSource.addEventListener('end', () => { evtSource?.close(); evtSource = null })
  evtSource.onerror = () => { evtSource?.close(); evtSource = null }

  playbackTimer = window.setInterval(() => {
    if (!isPlaying.value || !activeSegment.value) return
    playbackTs.value = Math.min(segmentEnd.value, playbackTs.value + 1000 * playbackSpeed.value)
    if (playbackTs.value >= segmentEnd.value) isPlaying.value = false
  }, 1000) as unknown as number
}

function closePlayer() {
  isPlaying.value = false
  activeSegment.value = null
  playerEvents.value = []
  if (evtSource) { evtSource.close(); evtSource = null }
  if (playbackTimer) { window.clearInterval(playbackTimer); playbackTimer = null }
}

const visibleEvents = computed(() => playerEvents.value.filter((e) => e.ts <= playbackTs.value))
const chatMessages = computed(() => visibleEvents.value.filter((e) => e.name === 'player_chat'))

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}m ${sec}s`
}

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(load)
onBeforeUnmount(closePlayer)
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex items-center justify-between mb-4 shrink-0">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('replay.title') }}</h1>
        <p class="text-gray-400 text-sm mt-1">{{ t('replay.subtitle') }}</p>
      </div>
    </div>

    <!-- Config card -->
    <div class="bg-dark-200 rounded-xl p-4 mb-4 flex flex-wrap items-center gap-4 shrink-0">
      <div class="flex items-center gap-2 text-sm">
        <span class="text-gray-400">{{ t('replay.recording') }}:</span>
        <span :class="cfg.recordingEnabled ? 'text-green-400' : 'text-gray-500'">
          {{ cfg.recordingEnabled ? t('replay.recordingOn') : t('replay.recordingOff') }}
        </span>
      </div>
      <label class="flex items-center gap-2 text-sm text-gray-300">
        <input v-model="cfgDraft.recordingEnabled" type="checkbox" class="accent-hytale-orange" :disabled="!canManage" />
        {{ cfgDraft.recordingEnabled ? t('replay.disableRecording') : t('replay.enableRecording') }}
      </label>
      <label class="flex items-center gap-2 text-sm text-gray-300">
        {{ t('replay.retention') }}:
        <input v-model.number="cfgDraft.retentionDays" type="number" min="1" max="365" class="w-20 bg-dark-300 text-gray-100 rounded px-2 py-1" :disabled="!canManage" />
      </label>
      <button
        v-if="canManage"
        @click="saveConfig"
        :disabled="saving"
        class="px-3 py-1.5 bg-hytale-orange text-dark font-medium rounded-lg disabled:opacity-50"
      >
        {{ saving ? t('common.saving') : t('replay.saveConfig') }}
      </button>
    </div>

    <!-- Segments table -->
    <div class="flex-1 bg-dark-200 rounded-xl p-4 min-h-0 overflow-auto">
      <h2 class="text-lg font-semibold text-white mb-3">{{ t('replay.segments') }}</h2>
      <div v-if="error" class="text-red-400 text-sm mb-2">{{ error }}</div>
      <div v-if="!loading && segments.length === 0" class="text-gray-500 py-8 text-center">
        {{ t('replay.noSegments') }}
      </div>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="text-left text-gray-400 border-b border-dark-50/30">
            <th class="py-2 pr-3">{{ t('replay.tableId') }}</th>
            <th class="py-2 pr-3">{{ t('replay.tableStart') }}</th>
            <th class="py-2 pr-3">{{ t('replay.tableEnd') }}</th>
            <th class="py-2 pr-3">{{ t('replay.tableDuration') }}</th>
            <th class="py-2 pr-3">{{ t('replay.tablePlayers') }}</th>
            <th class="py-2 pr-3">{{ t('replay.tableEvents') }}</th>
            <th class="py-2 pr-3">{{ t('replay.tableSize') }}</th>
            <th class="py-2">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in segments" :key="s.id" class="border-b border-dark-50/10">
            <td class="py-2 pr-3 font-mono text-xs text-gray-300">{{ s.id }}</td>
            <td class="py-2 pr-3 text-gray-300">{{ formatTs(s.startedAt) }}</td>
            <td class="py-2 pr-3 text-gray-300">{{ formatTs(s.endedAt) }}</td>
            <td class="py-2 pr-3 text-gray-300">{{ formatDuration(s.durationMs) }}</td>
            <td class="py-2 pr-3 text-gray-300">{{ s.playerCount }}</td>
            <td class="py-2 pr-3 text-gray-300">{{ s.eventCount }}</td>
            <td class="py-2 pr-3 text-gray-300">{{ formatBytes(s.sizeBytes) }}</td>
            <td class="py-2 flex gap-2">
              <button @click="openPlayer(s)" class="px-2 py-1 bg-dark-100 text-gray-200 rounded text-xs">{{ t('replay.play') }}</button>
              <button v-if="canManage" @click="exportSegment(s.id)" class="px-2 py-1 bg-dark-100 text-gray-200 rounded text-xs">{{ t('replay.export') }}</button>
              <button v-if="canManage" @click="deleteSegment(s.id)" class="px-2 py-1 bg-red-500/20 text-red-300 rounded text-xs">{{ t('common.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Player modal -->
    <div v-if="activeSegment" class="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" @click.self="closePlayer">
      <div class="bg-dark-200 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between p-4 border-b border-dark-50/30">
          <h3 class="text-lg font-semibold text-white">{{ t('replay.playerModal') }} — {{ activeSegment.id }}</h3>
          <button @click="closePlayer" class="text-gray-400 hover:text-white">{{ t('common.close') }}</button>
        </div>
        <div class="p-4 flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-2 gap-4 min-h-0">
          <div class="flex flex-col min-h-0">
            <h4 class="text-sm font-semibold text-gray-300 mb-2">{{ t('replay.events') }}</h4>
            <div class="flex-1 overflow-auto bg-dark-300 rounded p-2 font-mono text-xs">
              <div v-for="(e, i) in visibleEvents.slice(-200)" :key="i" class="text-gray-300 mb-0.5">
                <span class="text-gray-500">{{ new Date(e.ts).toLocaleTimeString() }}</span>
                <span class="text-hytale-orange ml-2">{{ e.name }}</span>
                <span class="text-gray-400 ml-2">{{ JSON.stringify(e.payload) }}</span>
              </div>
            </div>
          </div>
          <div class="flex flex-col min-h-0">
            <h4 class="text-sm font-semibold text-gray-300 mb-2">{{ t('replay.chat') }}</h4>
            <div class="flex-1 overflow-auto bg-dark-300 rounded p-2 text-sm">
              <div v-for="(c, i) in chatMessages.slice(-200)" :key="i" class="text-gray-200 mb-0.5">
                <span class="text-gray-500 text-xs">{{ new Date(c.ts).toLocaleTimeString() }}</span>
                <span class="font-semibold ml-2">{{ String((c.payload as { player?: string }).player ?? '?') }}:</span>
                <span class="ml-1">{{ String((c.payload as { message?: string }).message ?? '') }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="p-4 border-t border-dark-50/30">
          <div class="flex items-center gap-3">
            <button @click="isPlaying = !isPlaying" class="px-3 py-1.5 bg-hytale-orange text-dark font-medium rounded-lg">
              {{ isPlaying ? t('replay.pause') : t('replay.play') }}
            </button>
            <label class="text-sm text-gray-300">{{ t('replay.speed') }}:
              <select v-model.number="playbackSpeed" class="bg-dark-300 text-gray-100 rounded px-2 py-1 ml-1">
                <option :value="1">1x</option>
                <option :value="2">2x</option>
                <option :value="5">5x</option>
              </select>
            </label>
            <input
              type="range"
              :min="segmentStart"
              :max="segmentEnd"
              v-model.number="playbackTs"
              class="flex-1 accent-hytale-orange"
            />
            <span class="text-xs text-gray-400 font-mono">{{ new Date(playbackTs).toLocaleTimeString() }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
