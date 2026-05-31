<script setup lang="ts">
import { ref, onMounted, computed, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import { playersApi, type ChatMessage } from '@/api/players'

const { t } = useI18n()

const messages = ref<ChatMessage[]>([])
const total = ref(0)
const availableDays = ref(0)
const loading = ref(true)
const error = ref('')
const searchQuery = ref('')
const limit = ref(100)
const offset = ref(0)
const selectedDays = ref(7) // Default: 7 days

// Time range options (computed for i18n reactivity)
const timeRangeOptions = computed(() => [
  { value: 7, label: t('chat.days7') },
  { value: 14, label: t('chat.days14') },
  { value: 30, label: t('chat.days30') },
  { value: 0, label: t('chat.all') },
])

let pollInterval: ReturnType<typeof setInterval> | null = null

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const result = await playersApi.getGlobalChatLog({
      limit: limit.value,
      offset: offset.value,
      days: selectedDays.value
    })
    messages.value = result.messages
    total.value = result.total
    availableDays.value = result.availableDays || 0
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

// Reload when time range changes
watch(selectedDays, () => {
  offset.value = 0
  loadData()
})

// Filter messages by search query
const filteredMessages = computed(() => {
  if (!searchQuery.value.trim()) {
    return messages.value
  }
  const query = searchQuery.value.toLowerCase()
  return messages.value.filter(
    m => m.player.toLowerCase().includes(query) || m.message.toLowerCase().includes(query)
  )
})

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleString()
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString()
}

// Get unique color for player name based on hash
function getPlayerColor(name: string): string {
  const colors = [
    'text-blue-400',
    'text-green-400',
    'text-yellow-400',
    'text-purple-400',
    'text-pink-400',
    'text-cyan-400',
    'text-orange-400',
    'text-red-400',
    'text-indigo-400',
    'text-teal-400',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length]
}

const hasMore = computed(() => offset.value + messages.value.length < total.value)
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

function refresh() {
  offset.value = 0
  loadData()
}

onMounted(() => {
  loadData()
  // Auto-refresh every 10 seconds
  pollInterval = setInterval(() => {
    if (offset.value === 0) {
      loadData()
    }
  }, 10000)
})

onUnmounted(() => {
  if (pollInterval) {
    clearInterval(pollInterval)
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('chat.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('chat.description') }}</p>
      </div>
      <Button variant="secondary" @click="refresh" :class="{ 'animate-spin': loading }">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </Button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Search & Filters -->
    <div class="flex gap-4 items-center flex-wrap">
      <div class="flex-1 min-w-[200px]">
        <div class="relative">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('chat.searchPlaceholder')"
            class="w-full pl-10 pr-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
          />
        </div>
      </div>

      <!-- Time Range Filter -->
      <div class="flex items-center gap-2">
        <span class="text-sm text-ink-muted">{{ t('chat.timeRange') }}</span>
        <div class="flex bg-surface-overlay rounded-lg p-1">
          <button
            v-for="option in timeRangeOptions"
            :key="option.value"
            @click="selectedDays = option.value"
            :class="[
              'px-3 py-1.5 text-sm rounded-md transition-colors',
              selectedDays === option.value
                ? 'bg-hytale-orange text-white'
                : 'text-ink-muted hover:text-ink hover:bg-surface-overlay'
            ]"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div class="text-sm text-ink-muted">
        {{ t('chat.messageCount', { count: total }) }}
        <span v-if="availableDays > 0" class="text-ink-subtle">
          ({{ t('chat.daysAvailable', { count: availableDays }) }})
        </span>
      </div>
    </div>

    <!-- Chat Messages -->
    <Card :padding="false">
      <!-- Loading -->
      <div v-if="loading && messages.length === 0" class="text-center text-ink-subtle p-8">
        <svg class="w-8 h-8 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        {{ t('common.loading') }}
      </div>

      <!-- Empty State -->
      <div v-else-if="messages.length === 0" class="text-center text-ink-subtle p-8">
        <svg class="w-12 h-12 mx-auto mb-3 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <p>{{ t('chat.noMessages') }}</p>
      </div>

      <!-- Messages List -->
      <div v-else class="divide-y divide-border">
        <div
          v-for="msg in filteredMessages"
          :key="msg.id"
          class="px-4 py-3 hover:bg-surface-overlay/50 transition-colors"
        >
          <div class="flex items-start gap-3">
            <!-- Avatar placeholder -->
            <div class="w-8 h-8 rounded-full bg-surface-overlay flex items-center justify-center flex-shrink-0">
              <span :class="['font-bold text-sm', getPlayerColor(msg.player)]">
                {{ msg.player[0].toUpperCase() }}
              </span>
            </div>

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-0.5">
                <span :class="['font-semibold', getPlayerColor(msg.player)]">{{ msg.player }}</span>
                <span class="text-xs text-ink-subtle">{{ formatTime(msg.timestamp) }}</span>
              </div>
              <p class="text-ink-muted break-words">{{ msg.message }}</p>
            </div>

            <!-- Full timestamp on hover -->
            <div class="text-xs text-ink-subtle flex-shrink-0 hidden sm:block">
              {{ formatDate(msg.timestamp) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="total > limit" class="flex items-center justify-between px-4 py-3 border-t border-border">
        <Button
          variant="secondary"
          size="sm"
          :disabled="!hasPrev"
          @click="prevPage"
        >
          <svg class="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          {{ t('common.previous') }}
        </Button>
        <span class="text-sm text-ink-muted">
          {{ offset + 1 }} - {{ Math.min(offset + limit, total) }} / {{ total }}
        </span>
        <Button
          variant="secondary"
          size="sm"
          :disabled="!hasMore"
          @click="nextPage"
        >
          {{ t('common.next') }}
          <svg class="w-4 h-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </Button>
      </div>
    </Card>
  </div>
</template>
