<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import { activityApi, type ActivityLogEntry } from '@/api/management'

const { t } = useI18n()

const entries = ref<ActivityLogEntry[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref('')
const selectedCategory = ref<string>('all')
const limit = ref(50)
const offset = ref(0)

const categories = ['all', 'player', 'server', 'backup', 'config', 'mod', 'user', 'system'] as const

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

async function clearLog() {
  if (!confirm(t('activity.confirmClear'))) return

  try {
    await activityApi.clear()
    await loadData()
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleString()
}

function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    player: 'bg-blue-500/20 text-blue-400',
    server: 'bg-green-500/20 text-green-400',
    backup: 'bg-purple-500/20 text-purple-400',
    config: 'bg-yellow-500/20 text-yellow-400',
    mod: 'bg-orange-500/20 text-orange-400',
    user: 'bg-pink-500/20 text-pink-400',
    system: 'bg-gray-500/20 text-gray-400',
  }
  return colors[category] || 'bg-gray-500/20 text-gray-400'
}

function getCategoryIcon(category: string): string {
  const icons: Record<string, string> = {
    player: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    server: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
    backup: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
    config: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0',
    mod: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    system: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  }
  return icons[category] || icons.system
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
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('activity.title') }}</h1>
        <p class="text-gray-400 mt-1">{{ t('activity.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <button
          @click="clearLog"
          class="px-4 py-2 bg-status-error/20 text-status-error font-medium rounded-lg hover:bg-status-error/30 transition-colors flex items-center gap-2"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          {{ t('activity.clearLog') }}
        </button>
        <button
          @click="loadData"
          class="text-gray-400 hover:text-white transition-colors"
          :class="{ 'animate-spin': loading }"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Category Filter -->
    <div class="flex flex-wrap gap-2">
      <button
        v-for="cat in categories"
        :key="cat"
        @click="changeCategory(cat)"
        :class="[
          'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
          selectedCategory === cat
            ? 'bg-hytale-orange text-dark'
            : 'bg-dark-100 text-gray-400 hover:text-white hover:bg-dark-50'
        ]"
      >
        {{ t(`activity.categories.${cat}`) }}
      </button>
    </div>

    <!-- Stats Card -->
    <Card>
      <div class="flex items-center gap-4">
        <div class="p-3 bg-hytale-orange/20 rounded-lg">
          <svg class="w-6 h-6 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
        </div>
        <div>
          <h3 class="font-semibold text-white">{{ t('activity.entries', { count: total }) }}</h3>
          <p class="text-sm text-gray-400">
            {{ selectedCategory === 'all' ? t('activity.categories.all') : t(`activity.categories.${selectedCategory}`) }}
          </p>
        </div>
      </div>
    </Card>

    <!-- Activity List -->
    <Card :padding="false">
      <div v-if="loading" class="text-center text-gray-500 p-8">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="entries.length === 0" class="text-center text-gray-500 p-8">
        <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        {{ t('activity.noEntries') }}
      </div>

      <div v-else class="divide-y divide-dark-50/30">
        <div
          v-for="entry in entries"
          :key="entry.id"
          class="flex items-start gap-4 p-4 hover:bg-dark-50/20 transition-colors"
        >
          <!-- Category Icon -->
          <div :class="['p-2.5 rounded-lg', getCategoryColor(entry.category)]">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="getCategoryIcon(entry.category)" />
            </svg>
          </div>

          <!-- Entry Details -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-medium text-white">{{ entry.action }}</span>
              <span
                :class="[
                  'px-2 py-0.5 rounded text-xs font-medium',
                  entry.success ? 'bg-status-success/20 text-status-success' : 'bg-status-error/20 text-status-error'
                ]"
              >
                {{ entry.success ? t('activity.success') : t('activity.failed') }}
              </span>
            </div>
            <div class="text-sm text-gray-400 space-y-0.5">
              <div v-if="entry.target" class="flex items-center gap-1">
                <span class="text-gray-500">{{ t('activity.target') }}:</span>
                <span class="text-gray-300">{{ entry.target }}</span>
              </div>
              <div v-if="entry.details" class="text-gray-500 truncate">{{ entry.details }}</div>
            </div>
          </div>

          <!-- Meta -->
          <div class="text-right text-sm">
            <p class="text-white">{{ entry.user }}</p>
            <p class="text-gray-500">{{ formatDate(entry.timestamp) }}</p>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="entries.length > 0" class="flex items-center justify-between p-4 border-t border-dark-50/30">
        <button
          @click="prevPage"
          :disabled="!hasPrev"
          class="px-4 py-2 bg-dark-100 text-gray-300 rounded-lg hover:bg-dark-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span class="text-gray-400">
          {{ offset + 1 }} - {{ Math.min(offset + entries.length, total) }} / {{ total }}
        </span>
        <button
          @click="nextPage"
          :disabled="!hasMore"
          class="px-4 py-2 bg-dark-100 text-gray-300 rounded-lg hover:bg-dark-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </Card>
  </div>
</template>
