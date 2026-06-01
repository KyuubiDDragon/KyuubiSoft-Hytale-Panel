<script setup lang="ts">
/**
 * Live Player Map with ping-coloured pins and a 10-minute scrub-back slider.
 *
 * We render via a plain SVG instead of pulling in Leaflet — keeps the bundle
 * lean and the demo mode runs without any tile server. The view auto-scales
 * the world coordinates of all known samples into the visible viewport so
 * the map remains useful regardless of which slice of the world the players
 * happen to be in.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import { useAuthStore } from '@/stores/auth'

interface LocationSample {
  playerName: string
  uuid: string
  x: number
  y: number
  z: number
  world: string
  latencyMs: number
  ts: number
}

const { t } = useI18n()
const authStore = useAuthStore()

const samples = ref<LocationSample[]>([])
const showHeatmap = ref(true)
const playbackOffsetMs = ref(0) // 0 = live, >0 = seconds in the past
let ws: WebSocket | null = null
let pollTimer: number | null = null
const BUFFER_MS = 10 * 60 * 1000

// History buffer, keyed by uuid -> samples sorted by ts. It's a plain Map (not
// reactive), so every mutation bumps `sampleTick` to drive the computeds below —
// otherwise visibleSamples only recomputed when playbackOffsetMs changed, i.e.
// players appeared only after the user nudged the playback slider.
const history = new Map<string, LocationSample[]>()
const sampleTick = ref(0)

function ingest(sample: LocationSample) {
  let arr = history.get(sample.uuid)
  if (!arr) {
    arr = []
    history.set(sample.uuid, arr)
  }
  arr.push(sample)
  const cutoff = Date.now() - BUFFER_MS
  while (arr.length > 0 && arr[0].ts < cutoff) arr.shift()
  sampleTick.value++
}

// Latest sample per uuid, optionally rewound to a target time.
const visibleSamples = computed<LocationSample[]>(() => {
  void sampleTick.value // re-run whenever a new sample is ingested
  const live = playbackOffsetMs.value === 0
  // Anchor the timeline on the newest sample we actually hold, NOT the browser
  // clock. The backend stamps samples with server time; any clock skew between
  // server and browser would otherwise push fresh samples "into the future"
  // (s.ts > Date.now()) and hide every online player.
  let newestTs = 0
  for (const arr of history.values()) {
    if (arr.length > 0) newestTs = Math.max(newestTs, arr[arr.length - 1].ts)
  }
  const anchor = newestTs || Date.now()
  const target = anchor - playbackOffsetMs.value
  const out: LocationSample[] = []
  for (const arr of history.values()) {
    // Find latest sample with ts <= target.
    let best: LocationSample | null = null
    for (const s of arr) {
      if (s.ts <= target) best = s
      else break
    }
    // In live mode always surface the latest known position, even if its
    // timestamp is marginally ahead of the anchor.
    if (!best && live && arr.length > 0) best = arr[arr.length - 1]
    if (best) out.push(best)
  }
  return out
})

// Compute viewBox from current samples + a fixed minimum extent so we don't
// zoom in on a single player.
const viewBox = computed(() => {
  const pts = visibleSamples.value
  if (pts.length === 0) return { minX: -100, minZ: -100, w: 200, h: 200 }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  const padX = Math.max(40, (maxX - minX) * 0.2)
  const padZ = Math.max(40, (maxZ - minZ) * 0.2)
  minX -= padX; maxX += padX; minZ -= padZ; maxZ += padZ
  const w = Math.max(120, maxX - minX)
  const h = Math.max(120, maxZ - minZ)
  return { minX, minZ, w, h }
})

function pinColor(latencyMs: number): string {
  if (latencyMs < 50) return '#22c55e'
  if (latencyMs < 120) return '#eab308'
  return '#ef4444'
}

function timeLabel(): string {
  const offset = playbackOffsetMs.value
  if (offset === 0) return t('liveMap.now')
  if (offset < 60_000) return t('liveMap.secondsAgo', { n: Math.round(offset / 1000) })
  return t('liveMap.minutesAgo', { n: Math.round(offset / 60_000) })
}

async function refreshSnapshot() {
  try {
    const { data } = await api.get<{ samples: LocationSample[] }>('/players/locations')
    for (const s of data.samples) ingest(s)
  } catch (err) {
    console.error('[live-map] snapshot fetch failed', err)
  }
  samples.value = visibleSamples.value
}

function connectWebSocket() {
  // Reuse the panel's same-origin to keep auth cookies / proxies happy. The
  // backend exposes the WS at /api/players/locations/ws.
  try {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const token = authStore.accessToken
    const wsUrl = `${proto}://${window.location.host}/api/players/locations/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`
    ws = new WebSocket(wsUrl)
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'snapshot' && Array.isArray(msg.samples)) {
          for (const s of msg.samples) ingest(s)
        } else if (msg.type === 'sample' && msg.sample) {
          ingest(msg.sample)
        }
      } catch { /* ignore malformed frames */ }
    }
    ws.onerror = () => { /* fall back to polling silently */ }
    ws.onclose = () => { ws = null }
  } catch (err) {
    console.warn('[live-map] WS unavailable, falling back to polling:', err)
  }
}

onMounted(() => {
  refreshSnapshot()
  connectWebSocket()
  pollTimer = window.setInterval(refreshSnapshot, 2000) as unknown as number
})

onBeforeUnmount(() => {
  if (ws) { try { ws.close() } catch { /* noop */ } ws = null }
  if (pollTimer) window.clearInterval(pollTimer)
})

// Map a world coord into the SVG 1000x1000 unit space.
function projectX(x: number) { return ((x - viewBox.value.minX) / viewBox.value.w) * 1000 }
function projectZ(z: number) { return ((z - viewBox.value.minZ) / viewBox.value.h) * 1000 }
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex items-center justify-between mb-4 shrink-0">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('liveMap.title') }}</h1>
        <p class="text-ink-muted text-sm mt-1">{{ t('liveMap.subtitle') }}</p>
      </div>
      <label class="flex items-center gap-2 text-ink-muted text-sm">
        <input v-model="showHeatmap" type="checkbox" class="accent-hytale-orange" />
        {{ t('liveMap.heatmap') }}
      </label>
    </div>

    <div class="flex-1 bg-surface-raised rounded-xl p-4 min-h-0 flex flex-col">
      <div class="flex-1 relative min-h-0 bg-surface-sunken rounded-lg overflow-hidden">
        <svg :viewBox="`0 0 1000 1000`" preserveAspectRatio="xMidYMid meet" class="w-full h-full">
          <!-- subtle grid -->
          <defs>
            <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
              <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#1f2937" stroke-width="0.5" />
            </pattern>
          </defs>
          <rect width="1000" height="1000" fill="url(#grid)" />

          <!-- heatmap (soft radial gradients per pin) -->
          <g v-if="showHeatmap" opacity="0.35">
            <circle
              v-for="s in visibleSamples"
              :key="`h-${s.uuid}`"
              :cx="projectX(s.x)"
              :cy="projectZ(s.z)"
              r="60"
              :fill="pinColor(s.latencyMs)"
              filter="blur(8px)"
            />
          </g>

          <!-- player pins -->
          <g>
            <g v-for="s in visibleSamples" :key="s.uuid">
              <circle
                :cx="projectX(s.x)"
                :cy="projectZ(s.z)"
                r="10"
                :fill="pinColor(s.latencyMs)"
                stroke="#0f172a"
                stroke-width="2"
              />
              <text
                :x="projectX(s.x) + 14"
                :y="projectZ(s.z) + 4"
                fill="#e5e7eb"
                font-size="14"
                font-family="ui-sans-serif, system-ui"
              >
                {{ s.playerName }} ({{ s.latencyMs }}ms)
              </text>
            </g>
          </g>
        </svg>

        <div v-if="visibleSamples.length === 0" class="absolute inset-0 flex items-center justify-center text-ink-subtle">
          {{ t('liveMap.noPlayers') }}
        </div>

        <div class="absolute top-3 right-3 flex items-center gap-3 text-xs bg-surface-raised/90 rounded-lg px-3 py-2">
          <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-green-500"></span>{{ t('liveMap.latencyGood') }}</span>
          <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-yellow-500"></span>{{ t('liveMap.latencyOk') }}</span>
          <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-red-500"></span>{{ t('liveMap.latencyBad') }}</span>
        </div>
      </div>

      <!-- Playback slider: 0 = now (right), BUFFER_MS = 10 min ago (left) -->
      <div class="mt-4">
        <div class="flex items-center justify-between text-xs text-ink-muted mb-1">
          <span>{{ t('liveMap.playback') }}</span>
          <span>{{ timeLabel() }}</span>
        </div>
        <input
          type="range"
          :min="0"
          :max="BUFFER_MS"
          step="1000"
          v-model.number="playbackOffsetMs"
          class="w-full accent-hytale-orange"
        />
      </div>
    </div>
  </div>
</template>
