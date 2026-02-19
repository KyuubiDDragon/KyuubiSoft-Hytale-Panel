<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { whitelistApi, bansApi, type BanEntry } from '@/api/management'
import { useAuthStore } from '@/stores/auth'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

const { t } = useI18n()
const authStore = useAuthStore()

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

// Confirm dialogs
const showRemoveConfirm = ref(false)
const showUnbanConfirm = ref(false)
const pendingRemovePlayer = ref<string | null>(null)
const pendingUnbanPlayer = ref<string | null>(null)

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

function confirmRemoveFromWhitelist(player: string) {
  pendingRemovePlayer.value = player
  showRemoveConfirm.value = true
}

async function removeFromWhitelist() {
  if (!pendingRemovePlayer.value) return
  try {
    const result = await whitelistApi.removePlayer(pendingRemovePlayer.value)
    whitelistPlayers.value = result.list
    showRemoveConfirm.value = false
    pendingRemovePlayer.value = null
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

function confirmUnban(player: string) {
  pendingUnbanPlayer.value = player
  showUnbanConfirm.value = true
}

async function removeBan() {
  if (!pendingUnbanPlayer.value) return
  try {
    const result = await bansApi.remove(pendingUnbanPlayer.value)
    bans.value = result.bans
    showUnbanConfirm.value = false
    pendingUnbanPlayer.value = null
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
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('whitelist.title') }}</h1>
        <p class="text-gray-400 mt-1">{{ t('whitelist.subtitle') }}</p>
      </div>
      <button
        @click="loadData"
        class="p-2 text-gray-400 hover:text-white transition-colors"
        :aria-label="t('common.refresh')"
      >
        <Icon name="refresh" class="w-5 h-5" :class="{ 'animate-spin': loading }" />
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
            v-if="authStore.hasPermission('players.whitelist')"
            @click="toggleWhitelist"
            role="switch"
            :aria-checked="whitelistEnabled"
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
          <span v-else :class="['text-sm', whitelistEnabled ? 'text-hytale-orange' : 'text-gray-500']">
            {{ whitelistEnabled ? t('common.enabled') : t('common.disabled') }}
          </span>
        </div>
      </Card>

      <!-- Add Player -->
      <Card v-if="authStore.hasPermission('players.whitelist')">
        <h3 class="font-semibold text-white mb-4">{{ t('whitelist.addPlayer') }}</h3>
        <form @submit.prevent="addToWhitelist" class="flex gap-3">
          <input
            v-model="newWhitelistPlayer"
            type="text"
            :placeholder="t('whitelist.playerName')"
            class="flex-1 px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
          />
          <Button type="submit" :disabled="!newWhitelistPlayer.trim()">
            {{ t('common.save') }}
          </Button>
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

        <div v-if="loading" class="flex items-center justify-center py-8">
          <svg class="w-6 h-6 animate-spin text-hytale-orange" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
        <div v-else-if="filteredWhitelist.length === 0" class="text-center py-8 text-gray-500">
          <Icon name="players" class="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p>{{ t('whitelist.noPlayers') }}</p>
        </div>
        <TransitionGroup v-else name="list" tag="div" class="space-y-2">
          <div
            v-for="player in filteredWhitelist"
            :key="player"
            class="flex items-center justify-between p-3 bg-dark-100 rounded-lg hover:bg-dark-50 transition-colors"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-hytale-orange/20 rounded-full flex items-center justify-center">
                <span class="text-hytale-orange font-medium">{{ player[0]?.toUpperCase() }}</span>
              </div>
              <span class="text-white">{{ player }}</span>
            </div>
            <button
              v-if="authStore.hasPermission('players.whitelist')"
              @click="confirmRemoveFromWhitelist(player)"
              class="p-2 text-gray-400 hover:text-status-error transition-colors"
              :aria-label="t('common.remove')"
            >
              <Icon name="trash" class="w-5 h-5" />
            </button>
          </div>
        </TransitionGroup>
      </Card>
    </div>

    <!-- Bans Tab -->
    <div v-if="activeTab === 'bans'" class="space-y-6">
      <!-- Add Ban -->
      <Card v-if="authStore.hasPermission('players.ban')">
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
            <Button type="submit" variant="danger" :disabled="!newBanPlayer.trim()">
              {{ t('whitelist.ban') }}
            </Button>
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

        <div v-if="loading" class="flex items-center justify-center py-8">
          <svg class="w-6 h-6 animate-spin text-hytale-orange" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
        <div v-else-if="filteredBans.length === 0" class="text-center py-8 text-gray-500">
          <svg class="w-10 h-10 mx-auto mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
          <p>{{ t('whitelist.noBans') }}</p>
        </div>
        <TransitionGroup v-else name="list" tag="div" class="space-y-2">
          <div
            v-for="ban in filteredBans"
            :key="ban.player"
            class="flex items-center justify-between p-3 bg-dark-100 rounded-lg hover:bg-dark-50 transition-colors"
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
              v-if="authStore.hasPermission('players.unban')"
              @click="confirmUnban(ban.player)"
              class="px-3 py-1.5 bg-dark-50 text-gray-300 text-sm rounded-lg hover:bg-hytale-orange hover:text-dark transition-colors"
            >
              {{ t('whitelist.unban') }}
            </button>
          </div>
        </TransitionGroup>
      </Card>
    </div>

    <!-- Confirm Remove from Whitelist -->
    <ConfirmDialog
      :show="showRemoveConfirm"
      :title="t('common.remove')"
      :message="pendingRemovePlayer ? t('whitelist.confirmRemove', { player: pendingRemovePlayer }) : ''"
      :confirm-text="t('common.remove')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="removeFromWhitelist"
      @cancel="showRemoveConfirm = false"
    />

    <!-- Confirm Unban -->
    <ConfirmDialog
      :show="showUnbanConfirm"
      :title="t('whitelist.unban')"
      :message="pendingUnbanPlayer ? t('whitelist.confirmUnban', { player: pendingUnbanPlayer }) : ''"
      :confirm-text="t('whitelist.unban')"
      :cancel-text="t('common.cancel')"
      variant="primary"
      @confirm="removeBan"
      @cancel="showUnbanConfirm = false"
    />
  </div>
</template>
