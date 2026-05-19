<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Button from '@/components/ui/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import ErrorState from '@/components/ui/ErrorState.vue'
import EmptyTableState from '@/components/ui/EmptyTableState.vue'
import ResponsiveTable, { type TableColumn } from '@/components/ui/ResponsiveTable.vue'
import { activityApi, type ActivityLogEntry } from '@/api/management'
import { formatLogMessage } from '@/utils/formatItemPath'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const authStore = useAuthStore()

const entries = ref<ActivityLogEntry[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref('')
const selectedCategory = ref<string>('all')
const limit = ref(50)
const offset = ref(0)
const showClearConfirm = ref(false)

const categories = ['all', 'player', 'server', 'backup', 'config', 'mod', 'user', 'system'] as const

const columns = computed<TableColumn[]>(() => [
  { key: 'action', label: t('activity.action') },
  { key: 'category', label: t('activity.category'), width: '8rem' },
  { key: 'target', label: t('activity.target') },
  { key: 'user', label: t('activity.user'), nowrap: true, hideOnMobile: false },
  { key: 'timestamp', label: t('activity.timestamp'), nowrap: true },
  { key: 'success', label: t('activity.status'), align: 'center', width: '7rem' },
])

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const category = selectedCategory.value === 'all' ? undefined : selectedCategory.value
    const result = await activityApi.get({ limit: limit.value, offset: offset.value, category })
    entries.value = result.entries
    total.value = result.total
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function confirmClearLog() {
  showClearConfirm.value = false
  try {
    await activityApi.clear()
    await loadData()
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    player: 'bg-blue-500/20 text-blue-400',
    server: 'bg-green-500/20 text-green-400',
    backup: 'bg-purple-500/20 text-purple-400',
    config: 'bg-yellow-500/20 text-yellow-400',
    mod: 'bg-orange-500/20 text-orange-400',
    user: 'bg-pink-500/20 text-pink-400',
    system: 'bg-gray-500/20 text-ink-muted',
  }
  return colors[category] || 'bg-gray-500/20 text-ink-muted'
}

const hasMore = computed(() => offset.value + entries.value.length < total.value)
const hasPrev = computed(() => offset.value > 0)

function nextPage() {
  if (hasMore.value) {
    offset.value += limit.value
    loadData()
  }
}

function prevPage() {
  if (hasPrev.value) {
    offset.value = Math.max(0, offset.value - limit.value)
    loadData()
  }
}

function changeCategory(cat: string) {
  selectedCategory.value = cat
  offset.value = 0
  loadData()
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('activity.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('activity.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <Button v-if="authStore.hasPermission('activity.clear')" variant="danger" @click="showClearConfirm = true" class="flex items-center gap-2">
          <Icon name="trash" class="w-4 h-4" />
          {{ t('activity.clearLog') }}
        </Button>
        <button
          @click="loadData"
          class="p-2 text-ink-muted hover:text-ink transition-colors min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
          :aria-label="t('common.refresh')"
        >
          <Icon name="refresh" class="w-5 h-5" :class="{ 'animate-spin': loading }" />
        </button>
      </div>
    </div>

    <!-- Category Filter -->
    <div class="flex flex-wrap gap-2" role="tablist">
      <button
        v-for="cat in categories"
        :key="cat"
        role="tab"
        :aria-selected="selectedCategory === cat"
        @click="changeCategory(cat)"
        :class="[
          'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors min-h-[40px]',
          selectedCategory === cat
            ? 'bg-hytale-orange text-ink-inverse'
            : 'bg-surface-overlay text-ink-muted hover:text-ink',
        ]"
      >
        {{ t(`activity.categories.${cat}`) }}
      </button>
    </div>

    <!-- Body -->
    <ErrorState
      v-if="error && entries.length === 0"
      :message="error"
      @retry="loadData"
    />

    <div v-else-if="loading && entries.length === 0" class="space-y-2">
      <Skeleton v-for="i in 5" :key="i" height="3rem" />
    </div>

    <EmptyTableState
      v-else-if="entries.length === 0"
      icon="activity"
      :title="t('activity.noEntries')"
      :subtitle="t('activity.noEntriesSubtitle')"
    />

    <template v-else>
      <ResponsiveTable
        :columns="columns"
        :rows="entries"
        row-key="id"
        :aria-label="t('activity.title')"
        :mobile-card-label="(e) => formatLogMessage(e.action)"
      >
        <template #cell:action="{ row }">
          <span class="font-medium text-ink">{{ formatLogMessage(row.action) }}</span>
          <p v-if="row.details" class="text-xs text-ink-subtle mt-0.5 break-words">
            {{ formatLogMessage(row.details) }}
          </p>
        </template>
        <template #cell:category="{ row }">
          <span :class="['inline-flex px-2 py-0.5 rounded text-xs font-medium', getCategoryColor(row.category)]">
            {{ t(`activity.categories.${row.category}`) }}
          </span>
        </template>
        <template #cell:target="{ row }">
          <span v-if="row.target" class="text-ink-muted break-all">{{ formatLogMessage(row.target) }}</span>
          <span v-else class="text-ink-subtle">—</span>
        </template>
        <template #cell:user="{ row }">
          <span class="text-ink">{{ row.user }}</span>
        </template>
        <template #cell:timestamp="{ row }">
          <span class="text-sm text-ink-muted whitespace-nowrap">{{ formatDate(row.timestamp) }}</span>
        </template>
        <template #cell:success="{ row }">
          <span
            :class="[
              'inline-flex px-2 py-0.5 rounded text-xs font-medium',
              row.success ? 'bg-status-success/20 text-status-success' : 'bg-status-error/20 text-status-error',
            ]"
          >
            {{ row.success ? t('activity.success') : t('activity.failed') }}
          </span>
        </template>
      </ResponsiveTable>

      <!-- Pagination -->
      <div class="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl bg-surface-raised border border-border/60">
        <Button variant="secondary" size="sm" @click="prevPage" :disabled="!hasPrev" :aria-label="t('common.previous')">
          <Icon name="chevronDown" class="w-4 h-4 mr-1 rotate-90" />
          {{ t('common.previous') }}
        </Button>
        <span class="text-ink-muted text-sm">
          {{ offset + 1 }} – {{ Math.min(offset + entries.length, total) }} / {{ total }}
        </span>
        <Button variant="secondary" size="sm" @click="nextPage" :disabled="!hasMore" :aria-label="t('common.next')">
          {{ t('common.next') }}
          <Icon name="chevronDown" class="w-4 h-4 ml-1 -rotate-90" />
        </Button>
      </div>
    </template>

    <ConfirmDialog
      :show="showClearConfirm"
      :title="t('activity.clearLog')"
      :message="t('activity.confirmClear')"
      :confirm-text="t('activity.clearLog')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="confirmClearLog"
      @cancel="showClearConfirm = false"
    />
  </div>
</template>
