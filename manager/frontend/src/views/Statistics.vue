<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import Icon from '@/components/ui/Icon.vue'
import { statisticsApi, type PlayerStatistics, type DailyActivity } from '@/api/scheduler'

const { t } = useI18n()

const loading = ref(true)
const error = ref<string | null>(null)
const stats = ref<PlayerStatistics | null>(null)
const activity = ref<DailyActivity[]>([])

async function loadData() {
  try {
    loading.value = true
    error.value = null
    const [statsData, activityData] = await Promise.all([
      statisticsApi.getPlayerStatistics(),
      statisticsApi.getDailyActivity(7),
    ])
    stats.value = statsData
    activity.value = activityData
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

function formatPlaytime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
}

const maxActivityValue = computed(() => {
  if (activity.value.length === 0) return 1
  return Math.max(...activity.value.map(a => a.uniquePlayers), 1)
})

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('statistics.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('statistics.subtitle') }}</p>
      </div>
      <button
        @click="loadData"
        class="p-2 text-ink-muted hover:text-ink transition-colors"
        :aria-label="t('common.refresh')"
      >
        <Icon name="refresh" class="w-5 h-5" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-12">
      <svg class="w-6 h-6 animate-spin text-hytale-orange" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    </div>

    <template v-else-if="stats">
      <!-- Overview Stats -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <div class="text-center">
            <p class="text-3xl font-bold text-hytale-orange">{{ stats.totalPlayers }}</p>
            <p class="text-sm text-ink-muted mt-1">{{ t('statistics.totalPlayers') }}</p>
          </div>
        </Card>
        <Card>
          <div class="text-center">
            <p class="text-3xl font-bold text-hytale-yellow">{{ stats.peakOnlineToday }}</p>
            <p class="text-sm text-ink-muted mt-1">{{ t('statistics.peakToday') }}</p>
          </div>
        </Card>
        <Card>
          <div class="text-center">
            <p class="text-3xl font-bold text-green-400">{{ stats.activePlayersLast7Days }}</p>
            <p class="text-sm text-ink-muted mt-1">{{ t('statistics.activeLast7Days') }}</p>
          </div>
        </Card>
        <Card>
          <div class="text-center">
            <p class="text-3xl font-bold text-blue-400">{{ stats.newPlayersLast7Days }}</p>
            <p class="text-sm text-ink-muted mt-1">{{ t('statistics.newLast7Days') }}</p>
          </div>
        </Card>
      </div>

      <!-- Playtime Stats -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card :title="t('statistics.playtimeStats')">
          <div class="space-y-4">
            <div class="flex justify-between items-center p-3 bg-surface rounded-lg">
              <span class="text-ink-muted">{{ t('statistics.totalPlaytime') }}</span>
              <span class="font-medium text-ink">{{ formatPlaytime(stats.totalPlaytime) }}</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-surface rounded-lg">
              <span class="text-ink-muted">{{ t('statistics.averagePlaytime') }}</span>
              <span class="font-medium text-ink">{{ formatPlaytime(stats.averagePlaytime) }}</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-surface rounded-lg">
              <span class="text-ink-muted">{{ t('statistics.avgSessions') }}</span>
              <span class="font-medium text-ink">{{ stats.averageSessionsPerPlayer }}</span>
            </div>
          </div>
        </Card>

        <!-- Activity Chart -->
        <Card :title="t('statistics.weeklyActivity')">
          <div class="space-y-2">
            <div v-for="day in activity" :key="day.date" class="flex items-center gap-3">
              <span class="w-12 text-xs text-ink-subtle">{{ formatDate(day.date) }}</span>
              <div class="flex-1 h-6 bg-surface rounded overflow-hidden">
                <div
                  class="h-full bg-gradient-to-r from-hytale-orange to-hytale-yellow transition-all duration-300"
                  :style="{ width: `${(day.uniquePlayers / maxActivityValue) * 100}%` }"
                ></div>
              </div>
              <span class="w-8 text-sm text-ink-muted text-right">{{ day.uniquePlayers }}</span>
            </div>
          </div>
        </Card>
      </div>

      <!-- Top Players -->
      <Card :title="t('statistics.topPlayers')">
        <div v-if="stats.topPlayers.length === 0" class="text-center py-8 text-ink-subtle">
          <Icon name="players" class="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p>{{ t('statistics.noPlayers') }}</p>
        </div>
        <div v-else class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="text-left text-ink-muted text-sm">
                <th class="pb-3 font-medium">#</th>
                <th class="pb-3 font-medium">{{ t('statistics.playerName') }}</th>
                <th class="pb-3 font-medium text-right">{{ t('statistics.playTime') }}</th>
                <th class="pb-3 font-medium text-right">{{ t('statistics.sessions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(player, index) in stats.topPlayers"
                :key="player.name"
                class="border-t border-border"
              >
                <td class="py-3">
                  <span
                    :class="[
                      'inline-flex items-center justify-center w-6 h-6 rounded-full text-sm font-medium',
                      index === 0 ? 'bg-yellow-500/20 text-yellow-400' :
                      index === 1 ? 'bg-gray-400/20 text-ink-muted' :
                      index === 2 ? 'bg-amber-600/20 text-amber-500' :
                      'bg-surface-overlay text-ink-subtle'
                    ]"
                  >
                    {{ index + 1 }}
                  </span>
                </td>
                <td class="py-3">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-surface-overlay rounded-lg flex items-center justify-center">
                      <Icon name="players" class="w-4 h-4 text-ink-muted" />
                    </div>
                    <span class="font-medium text-ink">{{ player.name }}</span>
                  </div>
                </td>
                <td class="py-3 text-right text-ink-muted">{{ formatPlaytime(player.playTime) }}</td>
                <td class="py-3 text-right text-ink-muted">{{ player.sessions }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </template>
  </div>
</template>
