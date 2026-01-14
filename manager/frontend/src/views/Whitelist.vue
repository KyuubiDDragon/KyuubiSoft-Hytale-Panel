<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { whitelistApi, bansApi, type BanEntry } from '@/api/management'
import Card from '@/components/ui/Card.vue'

const { t } = useI18n()

// Whitelist state
const whitelistEnabled = ref(false)
const whitelistPlayers = ref<string[]>([])
const newWhitelistPlayer = ref('')

// Bans state
const bans = ref<BanEntry[]>([])
const newBanPlayer = ref('')
const newBanReason = ref('')

// Loading and error states
const loading = ref(true)
const error = ref('')

// Active tab
const activeTab = ref<'whitelist' | 'bans'>('whitelist')

// Filtered lists based on search
const whitelistSearch = ref('')
const bansSearch = ref('')

const filteredWhitelist = computed(() => {
  if (!whitelistSearch.value) return whitelistPlayers.value
  const search = whitelistSearch.value.toLowerCase()
  return whitelistPlayers.value.filter(p => p.toLowerCase().includes(search))
})

const filteredBans = computed(() => {
  if (!bansSearch.value) return bans.value
  const search = bansSearch.value.toLowerCase()
  return bans.value.filter(b =>
    b.player.toLowerCase().includes(search) ||
    (b.reason && b.reason.toLowerCase().includes(search))
  )
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [whitelistData, bansData] = await Promise.all([
      whitelistApi.get(),
      bansApi.get(),
    ])
    whitelistEnabled.value = whitelistData.enabled
    whitelistPlayers.value = whitelistData.list
    bans.value = bansData.bans
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function toggleWhitelist() {
  try {
    const result = await whitelistApi.setEnabled(!whitelistEnabled.value)
    whitelistEnabled.value = result.enabled
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function addToWhitelist() {
  if (!newWhitelistPlayer.value.trim()) return
  try {
    const result = await whitelistApi.addPlayer(newWhitelistPlayer.value.trim())
    whitelistPlayers.value = result.list
    newWhitelistPlayer.value = ''
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function removeFromWhitelist(player: string) {
  try {
    const result = await whitelistApi.removePlayer(player)
    whitelistPlayers.value = result.list
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function addBan() {
  if (!newBanPlayer.value.trim()) return
  try {
    const result = await bansApi.add(newBanPlayer.value.trim(), newBanReason.value.trim() || undefined)
    bans.value = result.bans
    newBanPlayer.value = ''
    newBanReason.value = ''
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function removeBan(player: string) {
  try {
    const result = await bansApi.remove(player)
    bans.value = result.bans
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">{{ t('whitelist.title') }}</h1>
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

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2">
      <button
        @click="activeTab = 'whitelist'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors',
          activeTab === 'whitelist'
            ? 'bg-hytale-orange text-dark'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        {{ t('whitelist.whitelist') }}
      </button>
      <button
        @click="activeTab = 'bans'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors',
          activeTab === 'bans'
            ? 'bg-status-error text-white'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        {{ t('whitelist.bans') }}
      </button>
    </div>

    <!-- Whitelist Tab -->
    <div v-if="activeTab === 'whitelist'" class="space-y-6">
      <!-- Whitelist Toggle -->
      <Card>
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-semibold text-white">{{ t('whitelist.enabled') }}</h3>
            <p class="text-sm text-gray-400">{{ t('whitelist.enabledDescription') }}</p>
          </div>
          <button
            @click="toggleWhitelist"
            :class="[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              whitelistEnabled ? 'bg-hytale-orange' : 'bg-dark-50'
            ]"
          >
            <span
              :class="[
                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                whitelistEnabled ? 'translate-x-6' : 'translate-x-1'
              ]"
            />
          </button>
        </div>
      </Card>

      <!-- Add Player -->
      <Card>
        <h3 class="font-semibold text-white mb-4">{{ t('whitelist.addPlayer') }}</h3>
        <form @submit.prevent="addToWhitelist" class="flex gap-3">
          <input
            v-model="newWhitelistPlayer"
            type="text"
            :placeholder="t('whitelist.playerName')"
            class="flex-1 px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
          />
          <button
            type="submit"
            :disabled="!newWhitelistPlayer.trim()"
            class="px-6 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ t('common.save') }}
          </button>
        </form>
      </Card>

      <!-- Whitelist List -->
      <Card>
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold text-white">{{ t('whitelist.players') }} ({{ whitelistPlayers.length }})</h3>
          <input
            v-model="whitelistSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange text-sm"
          />
        </div>

        <div v-if="loading" class="text-center py-8 text-gray-400">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="filteredWhitelist.length === 0" class="text-center py-8 text-gray-400">
          {{ t('whitelist.noPlayers') }}
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="player in filteredWhitelist"
            :key="player"
            class="flex items-center justify-between p-3 bg-dark-100 rounded-lg"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-hytale-orange/20 rounded-full flex items-center justify-center">
                <span class="text-hytale-orange font-medium">{{ player[0]?.toUpperCase() }}</span>
              </div>
              <span class="text-white">{{ player }}</span>
            </div>
            <button
              @click="removeFromWhitelist(player)"
              class="p-2 text-gray-400 hover:text-status-error transition-colors"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      </Card>
    </div>

    <!-- Bans Tab -->
    <div v-if="activeTab === 'bans'" class="space-y-6">
      <!-- Add Ban -->
      <Card>
        <h3 class="font-semibold text-white mb-4">{{ t('whitelist.banPlayer') }}</h3>
        <form @submit.prevent="addBan" class="space-y-3">
          <div class="flex gap-3">
            <input
              v-model="newBanPlayer"
              type="text"
              :placeholder="t('whitelist.playerName')"
              class="flex-1 px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
            />
          </div>
          <div class="flex gap-3">
            <input
              v-model="newBanReason"
              type="text"
              :placeholder="t('whitelist.banReason')"
              class="flex-1 px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
            />
            <button
              type="submit"
              :disabled="!newBanPlayer.trim()"
              class="px-6 py-2 bg-status-error text-white font-medium rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ t('whitelist.ban') }}
            </button>
          </div>
        </form>
      </Card>

      <!-- Bans List -->
      <Card>
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold text-white">{{ t('whitelist.bannedPlayers') }} ({{ bans.length }})</h3>
          <input
            v-model="bansSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange text-sm"
          />
        </div>

        <div v-if="loading" class="text-center py-8 text-gray-400">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="filteredBans.length === 0" class="text-center py-8 text-gray-400">
          {{ t('whitelist.noBans') }}
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="ban in filteredBans"
            :key="ban.player"
            class="flex items-center justify-between p-3 bg-dark-100 rounded-lg"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-status-error/20 rounded-full flex items-center justify-center">
                <svg class="w-4 h-4 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </div>
              <div>
                <p class="text-white font-medium">{{ ban.player }}</p>
                <p v-if="ban.reason" class="text-sm text-gray-400">{{ ban.reason }}</p>
                <p class="text-xs text-gray-500">{{ formatDate(ban.bannedAt) }}</p>
              </div>
            </div>
            <button
              @click="removeBan(ban.player)"
              class="px-3 py-1.5 bg-dark-50 text-gray-300 text-sm rounded-lg hover:bg-hytale-orange hover:text-dark transition-colors"
            >
              {{ t('whitelist.unban') }}
            </button>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
