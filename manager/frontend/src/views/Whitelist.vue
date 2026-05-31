<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { whitelistApi, bansApi, type BanEntry } from '@/api/management'
import { useAuthStore } from '@/stores/auth'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import EmptyTableState from '@/components/ui/EmptyTableState.vue'
import ResponsiveTable, { type TableColumn } from '@/components/ui/ResponsiveTable.vue'

interface WhitelistRow {
  player: string
}

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

const filteredWhitelistRows = computed<WhitelistRow[]>(() => {
  const search = whitelistSearch.value.toLowerCase()
  const list = search
    ? whitelistPlayers.value.filter(p => p.toLowerCase().includes(search))
    : whitelistPlayers.value
  return list.map(player => ({ player }))
})

const filteredBans = computed(() => {
  if (!bansSearch.value) return bans.value
  const search = bansSearch.value.toLowerCase()
  return bans.value.filter(b =>
    b.player.toLowerCase().includes(search) ||
    (b.reason && b.reason.toLowerCase().includes(search))
  )
})

const whitelistColumns = computed<TableColumn[]>(() => [
  { key: 'player', label: t('whitelist.playerName') },
])

const bansColumns = computed<TableColumn[]>(() => [
  { key: 'player', label: t('whitelist.playerName') },
  { key: 'reason', label: t('whitelist.banReason') },
  { key: 'bannedAt', label: t('whitelist.bannedAt'), nowrap: true },
])

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
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('whitelist.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('whitelist.subtitle') }}</p>
      </div>
      <button
        @click="loadData"
        class="p-2 text-ink-muted hover:text-ink transition-colors min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
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
    <div class="flex gap-2" role="tablist">
      <button
        role="tab"
        :aria-selected="activeTab === 'whitelist'"
        @click="activeTab = 'whitelist'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors min-h-[44px]',
          activeTab === 'whitelist'
            ? 'bg-hytale-orange text-ink-inverse'
            : 'bg-surface-overlay text-ink-muted hover:text-ink',
        ]"
      >
        {{ t('whitelist.whitelist') }}
      </button>
      <button
        role="tab"
        :aria-selected="activeTab === 'bans'"
        @click="activeTab = 'bans'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors min-h-[44px]',
          activeTab === 'bans'
            ? 'bg-status-error text-white'
            : 'bg-surface-overlay text-ink-muted hover:text-ink',
        ]"
      >
        {{ t('whitelist.bans') }}
      </button>
    </div>

    <!-- Whitelist Tab -->
    <div v-if="activeTab === 'whitelist'" class="space-y-6">
      <!-- Whitelist Toggle -->
      <Card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="font-semibold text-ink">{{ t('whitelist.enabled') }}</h3>
            <p class="text-sm text-ink-muted">{{ t('whitelist.enabledDescription') }}</p>
          </div>
          <button
            v-if="authStore.hasPermission('players.whitelist')"
            @click="toggleWhitelist"
            role="switch"
            :aria-checked="whitelistEnabled"
            :aria-label="t('whitelist.enabled')"
            :class="[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              whitelistEnabled ? 'bg-hytale-orange' : 'bg-surface-overlay',
            ]"
          >
            <span
              :class="[
                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                whitelistEnabled ? 'translate-x-6' : 'translate-x-1',
              ]"
            />
          </button>
          <span v-else :class="['text-sm', whitelistEnabled ? 'text-hytale-orange' : 'text-ink-subtle']">
            {{ whitelistEnabled ? t('common.enabled') : t('common.disabled') }}
          </span>
        </div>
      </Card>

      <!-- Add Player -->
      <Card v-if="authStore.hasPermission('players.whitelist')">
        <h3 class="font-semibold text-ink mb-4">{{ t('whitelist.addPlayer') }}</h3>
        <form @submit.prevent="addToWhitelist" class="flex flex-col sm:flex-row gap-3">
          <input
            v-model="newWhitelistPlayer"
            type="text"
            :placeholder="t('whitelist.playerName')"
            class="flex-1 px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
          />
          <Button type="submit" :disabled="!newWhitelistPlayer.trim()">
            {{ t('common.save') }}
          </Button>
        </form>
      </Card>

      <!-- Whitelist List -->
      <div>
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 class="font-semibold text-ink">
            {{ t('whitelist.players') }} <span class="text-ink-muted font-normal">({{ whitelistPlayers.length }})</span>
          </h3>
          <input
            v-model="whitelistSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange text-sm w-full sm:w-auto"
          />
        </div>

        <div v-if="loading && whitelistPlayers.length === 0" class="space-y-2">
          <Skeleton v-for="i in 3" :key="i" height="3rem" />
        </div>

        <EmptyTableState
          v-else-if="filteredWhitelistRows.length === 0"
          icon="players"
          :title="t('whitelist.noPlayers')"
          :subtitle="whitelistSearch ? t('common.noResults') : t('whitelist.noPlayersSubtitle')"
        />

        <ResponsiveTable
          v-else
          :columns="whitelistColumns"
          :rows="filteredWhitelistRows"
          :row-key="(r) => r.player"
          :aria-label="t('whitelist.players')"
          :mobile-card-label="(r) => r.player"
        >
          <template #cell:player="{ row }">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-hytale-orange/20 rounded-full flex items-center justify-center flex-shrink-0">
                <span class="text-hytale-orange font-medium">{{ row.player[0]?.toUpperCase() }}</span>
              </div>
              <span class="text-ink">{{ row.player }}</span>
            </div>
          </template>
          <template #actions="{ row }">
            <Button
              v-if="authStore.hasPermission('players.whitelist')"
              variant="ghost"
              size="sm"
              icon-only
              class="!text-ink-muted hover:!text-status-error"
              :aria-label="t('common.remove')"
              @click="confirmRemoveFromWhitelist(row.player)"
            >
              <Icon name="trash" class="w-5 h-5" />
            </Button>
          </template>
        </ResponsiveTable>
      </div>
    </div>

    <!-- Bans Tab -->
    <div v-if="activeTab === 'bans'" class="space-y-6">
      <!-- Add Ban -->
      <Card v-if="authStore.hasPermission('players.ban')">
        <h3 class="font-semibold text-ink mb-4">{{ t('whitelist.banPlayer') }}</h3>
        <form @submit.prevent="addBan" class="space-y-3">
          <input
            v-model="newBanPlayer"
            type="text"
            :placeholder="t('whitelist.playerName')"
            class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
          />
          <div class="flex flex-col sm:flex-row gap-3">
            <input
              v-model="newBanReason"
              type="text"
              :placeholder="t('whitelist.banReason')"
              class="flex-1 px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
            />
            <Button type="submit" variant="danger" :disabled="!newBanPlayer.trim()">
              {{ t('whitelist.ban') }}
            </Button>
          </div>
        </form>
      </Card>

      <!-- Bans List -->
      <div>
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 class="font-semibold text-ink">
            {{ t('whitelist.bannedPlayers') }} <span class="text-ink-muted font-normal">({{ bans.length }})</span>
          </h3>
          <input
            v-model="bansSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange text-sm w-full sm:w-auto"
          />
        </div>

        <div v-if="loading && bans.length === 0" class="space-y-2">
          <Skeleton v-for="i in 3" :key="i" height="3rem" />
        </div>

        <EmptyTableState
          v-else-if="filteredBans.length === 0"
          icon="ban"
          :title="t('whitelist.noBans')"
          :subtitle="bansSearch ? t('common.noResults') : t('whitelist.noBansSubtitle')"
        />

        <ResponsiveTable
          v-else
          :columns="bansColumns"
          :rows="filteredBans"
          :row-key="(b) => b.player"
          :aria-label="t('whitelist.bannedPlayers')"
          :mobile-card-label="(b) => b.player"
        >
          <template #cell:player="{ row }">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-status-error/20 rounded-full flex items-center justify-center flex-shrink-0">
                <Icon name="ban" class="w-4 h-4 text-status-error" />
              </div>
              <span class="text-ink font-medium">{{ row.player }}</span>
            </div>
          </template>
          <template #cell:reason="{ row }">
            <span v-if="row.reason" class="text-ink-muted">{{ row.reason }}</span>
            <span v-else class="text-ink-subtle">—</span>
          </template>
          <template #cell:bannedAt="{ row }">
            <span class="text-sm text-ink-muted whitespace-nowrap">{{ formatDate(row.bannedAt) }}</span>
          </template>
          <template #actions="{ row }">
            <Button
              v-if="authStore.hasPermission('players.unban')"
              variant="secondary"
              size="sm"
              @click="confirmUnban(row.player)"
            >
              {{ t('whitelist.unban') }}
            </Button>
          </template>
        </ResponsiveTable>
      </div>
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
