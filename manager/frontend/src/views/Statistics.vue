<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
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
        <h1 class="text-2xl font-bold text-white">{{ t('statistics.title') }}</h1>
        <p class="text-gray-400 mt-1">{{ t('statistics.subtitle') }}</p>
      </div>
      <button
        @click="loadData"
        class="p-2 text-gray-400 hover:text-white transition-colors"
        :class="{ 'animate-spin': loading }"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400">
      {{ t('common.loading') }}
    </div>

    <template v-else-if="stats">
      <!-- Overview Stats -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <div class="text-center">
            <p class="text-3xl font-bold text-hytale-orange">{{ stats.totalPlayers }}</p>
            <p class="text-sm text-gray-400 mt-1">{{ t('statistics.totalPlayers') }}</p>
          </div>
        </Card>
        <Card>
          <div class="text-center">
            <p class="text-3xl font-bold text-hytale-yellow">{{ stats.peakOnlineToday }}</p>
            <p class="text-sm text-gray-400 mt-1">{{ t('statistics.peakToday') }}</p>
          </div>
        </Card>
        <Card>
          <div class="text-center">
            <p class="text-3xl font-bold text-green-400">{{ stats.activePlayersLast7Days }}</p>
            <p class="text-sm text-gray-400 mt-1">{{ t('statistics.activeLast7Days') }}</p>
          </div>
        </Card>
        <Card>
          <div class="text-center">
            <p class="text-3xl font-bold text-blue-400">{{ stats.newPlayersLast7Days }}</p>
            <p class="text-sm text-gray-400 mt-1">{{ t('statistics.newLast7Days') }}</p>
          </div>
        </Card>
      </div>

      <!-- Playtime Stats -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card :title="t('statistics.playtimeStats')">
          <div class="space-y-4">
            <div class="flex justify-between items-center p-3 bg-dark-400 rounded-lg">
              <span class="text-gray-400">{{ t('statistics.totalPlaytime') }}</span>
              <span class="font-medium text-white">{{ formatPlaytime(stats.totalPlaytime) }}</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-dark-400 rounded-lg">
              <span class="text-gray-400">{{ t('statistics.averagePlaytime') }}</span>
              <span class="font-medium text-white">{{ formatPlaytime(stats.averagePlaytime) }}</span>
            </div>
            <div class="flex justify-between items-center p-3 bg-dark-400 rounded-lg">
              <span class="text-gray-400">{{ t('statistics.avgSessions') }}</span>
              <span class="font-medium text-white">{{ stats.averageSessionsPerPlayer }}</span>
            </div>
          </div>
        </Card>

        <!-- Activity Chart -->
        <Card :title="t('statistics.weeklyActivity')">
          <div class="space-y-2">
            <div v-for="day in activity" :key="day.date" class="flex items-center gap-3">
              <span class="w-12 text-xs text-gray-500">{{ formatDate(day.date) }}</span>
              <div class="flex-1 h-6 bg-dark-400 rounded overflow-hidden">
                <div
                  class="h-full bg-gradient-to-r from-hytale-orange to-hytale-yellow transition-all duration-300"
                  :style="{ width: `${(day.uniquePlayers / maxActivityValue) * 100}%` }"
                ></div>
              </div>
              <span class="w-8 text-sm text-gray-400 text-right">{{ day.uniquePlayers }}</span>
            </div>
          </div>
        </Card>
      </div>

      <!-- Top Players -->
      <Card :title="t('statistics.topPlayers')">
        <div v-if="stats.topPlayers.length === 0" class="text-center py-8 text-gray-500">
          {{ t('statistics.noPlayers') }}
        </div>
        <div v-else class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="text-left text-gray-400 text-sm">
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
                class="border-t border-dark-50"
              >
                <td class="py-3">
                  <span
                    :class="[
                      'inline-flex items-center justify-center w-6 h-6 rounded-full text-sm font-medium',
                      index === 0 ? 'bg-yellow-500/20 text-yellow-400' :
                      index === 1 ? 'bg-gray-400/20 text-gray-300' :
                      index === 2 ? 'bg-amber-600/20 text-amber-500' :
                      'bg-dark-50 text-gray-500'
                    ]"
                  >
                    {{ index + 1 }}
                  </span>
                </td>
                <td class="py-3">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-dark-50 rounded-lg flex items-center justify-center">
                      <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    </div>
                    <span class="font-medium text-white">{{ player.name }}</span>
                  </div>
                </td>
                <td class="py-3 text-right text-gray-300">{{ formatPlaytime(player.playTime) }}</td>
                <td class="py-3 text-right text-gray-400">{{ player.sessions }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </template>
  </div>
</template>
