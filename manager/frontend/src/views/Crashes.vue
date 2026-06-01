<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import Card from '@/components/ui/Card.vue'

interface CrashReport {
  id: number
  serverId: string | null
  detectedAt: string
  autoRestarted: boolean
  createdAt: string
}
interface CrashDetail extends CrashReport { logTail: string | null }

const { t } = useI18n()
const crashes = ref<CrashReport[]>([])
const loading = ref(true)
const error = ref('')
const expanded = ref<number | null>(null)
const detail = ref<CrashDetail | null>(null)
const detailLoading = ref(false)

async function load() {
  try {
    const { data } = await api.get<{ crashes: CrashReport[] }>('/server/crashes', { params: { limit: 100 } })
    crashes.value = data.crashes
    error.value = ''
  } catch {
    error.value = t('crashes.loadError')
  } finally {
    loading.value = false
  }
}

async function toggle(id: number) {
  if (expanded.value === id) { expanded.value = null; detail.value = null; return }
  expanded.value = id
  detail.value = null
  detailLoading.value = true
  try {
    const { data } = await api.get<CrashDetail>(`/server/crashes/${id}`)
    detail.value = data
  } catch {
    detail.value = null
  } finally {
    detailLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold text-ink">{{ t('crashes.title') }}</h1>
      <p class="text-ink-muted mt-1">{{ t('crashes.subtitle') }}</p>
    </div>

    <Card :padding="false">
      <div v-if="error" class="p-4 text-status-error text-sm">{{ error }}</div>
      <div v-else-if="loading" class="p-8 text-center text-ink-subtle">{{ t('common.loading') }}</div>
      <div v-else-if="crashes.length === 0" class="p-8 text-center text-ink-subtle">{{ t('crashes.empty') }}</div>
      <ul v-else class="divide-y divide-border/40">
        <li v-for="c in crashes" :key="c.id">
          <button
            @click="toggle(c.id)"
            class="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-surface-muted/40 transition-colors"
          >
            <div class="flex items-center gap-3">
              <svg class="w-5 h-5 text-status-error flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.5 0L3.18 16.25A2 2 0 005 19z" />
              </svg>
              <span class="text-sm text-ink">{{ new Date(c.detectedAt).toLocaleString() }}</span>
              <span v-if="c.autoRestarted" class="badge badge-success">{{ t('crashes.autoRestarted') }}</span>
            </div>
            <svg class="w-4 h-4 text-ink-subtle transition-transform" :class="{ 'rotate-180': expanded === c.id }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <div v-if="expanded === c.id" class="px-5 pb-4">
            <div v-if="detailLoading" class="text-ink-subtle text-sm py-2">{{ t('common.loading') }}</div>
            <pre v-else-if="detail?.logTail" class="terminal max-h-96 text-[11px] whitespace-pre-wrap">{{ detail.logTail }}</pre>
            <div v-else class="text-ink-subtle text-sm py-2">{{ t('crashes.noLog') }}</div>
          </div>
        </li>
      </ul>
    </Card>
  </div>
</template>
