<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { playersApi, type PlayerInfo, type PlayerHistoryEntry } from '@/api/players'
import { serverApi, type PluginPlayer } from '@/api/server'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Modal from '@/components/ui/Modal.vue'

const { t } = useI18n()

// Tab state
const activeTab = ref<'online' | 'offline'>('online')

// Extended player info when plugin is available
interface ExtendedPlayerInfo extends PlayerInfo {
  uuid?: string
  position?: { x: number; y: number; z: number }
  world?: string
  health?: number
  gameMode?: string
  ping?: number
}

const players = ref<ExtendedPlayerInfo[]>([])
const offlinePlayers = ref<PlayerHistoryEntry[]>([])
const loading = ref(true)
const offlineLoading = ref(false)
const error = ref('')
const successMessage = ref('')
const pluginAvailable = ref(false)

// Selected player for actions
const selectedPlayer = ref<string | null>(null)
const selectedPlayerUuid = ref<string | null>(null)
const actionLoading = ref(false)

// Ban reason
const banReason = ref('')

// Modals
const showKickModal = ref(false)
const showBanModal = ref(false)
const showKillModal = ref(false)
const showClearInventoryModal = ref(false)
const showTeleportModal = ref(false)
const showGamemodeModal = ref(false)
const showGiveModal = ref(false)

// Teleport form
const teleportMode = ref<'player' | 'coords'>('player')
const teleportTarget = ref('')
const teleportX = ref(0)
const teleportY = ref(64)
const teleportZ = ref(0)

// Give item form
const giveItem = ref('')
const giveAmount = ref(1)

// Action dropdown for each player
const openDropdown = ref<string | null>(null)

let pollInterval: ReturnType<typeof setInterval> | null = null

async function fetchPlayers() {
  try {
    // Try plugin API first (more accurate and detailed)
    try {
      const pluginResponse = await serverApi.getPluginPlayers()
      if (pluginResponse.success && pluginResponse.data) {
        pluginAvailable.value = true
        players.value = pluginResponse.data.players.map((p: PluginPlayer) => ({
          name: p.name,
          session_duration: p.joinedAt ? formatJoinedAt(p.joinedAt) : '-',
          uuid: p.uuid,
          position: p.position,
          world: p.world,
          health: p.health,
          gameMode: p.gameMode,
          ping: p.ping,
        }))
        error.value = ''
        return
      }
    } catch {
      // Plugin not available, fall back to standard API
    }

    // Fall back to standard API
    pluginAvailable.value = false
    const response = await playersApi.getOnline()
    players.value = response.players
    error.value = ''
  } catch (err) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

function formatJoinedAt(joinedAt: string): string {
  const joined = new Date(joinedAt)
  const now = new Date()
  const diff = now.getTime() - joined.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }
  return `${minutes}m`
}

async function fetchOfflinePlayers() {
  offlineLoading.value = true
  try {
    const response = await playersApi.getOffline()
    offlinePlayers.value = response.players
    error.value = ''
  } catch (err) {
    error.value = t('errors.connectionFailed')
  } finally {
    offlineLoading.value = false
  }
}

function formatPlayTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString()
}

function showSuccess(msg: string) {
  successMessage.value = msg
  setTimeout(() => { successMessage.value = '' }, 3000)
}

function toggleDropdown(name: string) {
  openDropdown.value = openDropdown.value === name ? null : name
}

function closeDropdown() {
  openDropdown.value = null
}

// Action handlers
function openKickModal(name: string) {
  selectedPlayer.value = name
  showKickModal.value = true
  closeDropdown()
}

function openBanModal(name: string, uuid?: string) {
  selectedPlayer.value = name
  selectedPlayerUuid.value = uuid || null
  banReason.value = ''
  showBanModal.value = true
  closeDropdown()
}

function openKillModal(name: string) {
  selectedPlayer.value = name
  showKillModal.value = true
  closeDropdown()
}

function openClearInventoryModal(name: string) {
  selectedPlayer.value = name
  showClearInventoryModal.value = true
  closeDropdown()
}

function openTeleportModal(name: string) {
  selectedPlayer.value = name
  teleportMode.value = 'player'
  teleportTarget.value = ''
  teleportX.value = 0
  teleportY.value = 64
  teleportZ.value = 0
  showTeleportModal.value = true
  closeDropdown()
}

function openGamemodeModal(name: string) {
  selectedPlayer.value = name
  showGamemodeModal.value = true
  closeDropdown()
}

function openGiveModal(name: string) {
  selectedPlayer.value = name
  giveItem.value = ''
  giveAmount.value = 1
  showGiveModal.value = true
  closeDropdown()
}

async function handleWhitelist(name: string) {
  closeDropdown()
  try {
    await playersApi.addToWhitelist(name)
    showSuccess(t('players.addToWhitelist') + ': ' + name)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

async function handleOp(name: string) {
  closeDropdown()
  try {
    await playersApi.op(name)
    showSuccess(t('players.op') + ': ' + name)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

async function handleDeop(name: string) {
  closeDropdown()
  try {
    await playersApi.deop(name)
    showSuccess(t('players.deop') + ': ' + name)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

async function handleHeal(name: string) {
  closeDropdown()
  try {
    await playersApi.heal(name)
    showSuccess(t('players.heal') + ': ' + name)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

async function handleRespawn(name: string) {
  closeDropdown()
  try {
    await playersApi.respawn(name)
    showSuccess(t('players.respawn') + ': ' + name)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

async function handleClearEffects(name: string) {
  closeDropdown()
  try {
    await playersApi.clearEffects(name)
    showSuccess(t('players.clearEffects') + ': ' + name)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

// Confirm actions
async function confirmKick() {
  if (!selectedPlayer.value) return
  actionLoading.value = true
  try {
    await playersApi.kick(selectedPlayer.value)
    showKickModal.value = false
    showSuccess(t('players.kick') + ': ' + selectedPlayer.value)
    await fetchPlayers()
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

async function confirmBan() {
  if (!selectedPlayer.value) return
  actionLoading.value = true
  try {
    await playersApi.ban(selectedPlayer.value, banReason.value || undefined)
    showBanModal.value = false
    showSuccess(t('players.ban') + ': ' + selectedPlayer.value)
    banReason.value = ''
    await fetchPlayers()
    // Also refresh offline players if that tab is active
    if (activeTab.value === 'offline') {
      await fetchOfflinePlayers()
    }
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

async function confirmKill() {
  if (!selectedPlayer.value) return
  actionLoading.value = true
  try {
    await playersApi.kill(selectedPlayer.value)
    showKillModal.value = false
    showSuccess(t('players.kill') + ': ' + selectedPlayer.value)
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

async function confirmClearInventory() {
  if (!selectedPlayer.value) return
  actionLoading.value = true
  try {
    await playersApi.clearInventory(selectedPlayer.value)
    showClearInventoryModal.value = false
    showSuccess(t('players.clearInventory') + ': ' + selectedPlayer.value)
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

async function confirmTeleport() {
  if (!selectedPlayer.value) return
  actionLoading.value = true
  try {
    if (teleportMode.value === 'player' && teleportTarget.value) {
      await playersApi.teleport(selectedPlayer.value, { target: teleportTarget.value })
    } else {
      await playersApi.teleport(selectedPlayer.value, { x: teleportX.value, y: teleportY.value, z: teleportZ.value })
    }
    showTeleportModal.value = false
    showSuccess(t('players.teleport') + ': ' + selectedPlayer.value)
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

async function setGamemode(gamemode: string) {
  if (!selectedPlayer.value) return
  actionLoading.value = true
  try {
    await playersApi.gamemode(selectedPlayer.value, gamemode)
    showGamemodeModal.value = false
    showSuccess(t('players.gamemode') + ' ' + gamemode + ': ' + selectedPlayer.value)
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

async function confirmGive() {
  if (!selectedPlayer.value || !giveItem.value) return
  actionLoading.value = true
  try {
    await playersApi.give(selectedPlayer.value, giveItem.value, giveAmount.value)
    showGiveModal.value = false
    showSuccess(t('players.give') + ': ' + giveAmount.value + 'x ' + giveItem.value)
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

onMounted(() => {
  fetchPlayers()
  fetchOfflinePlayers()
  pollInterval = setInterval(fetchPlayers, 10000)
})

onUnmounted(() => {
  if (pollInterval) {
    clearInterval(pollInterval)
  }
})
</script>

<template>
  <div class="space-y-6" @click="closeDropdown">
    <!-- Page Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('players.title') }}</h1>
        <div class="flex items-center gap-2 mt-1">
          <p class="text-gray-400">
            {{ t('players.playerCount', { count: players.length }) }}
          </p>
          <span
            v-if="pluginAvailable"
            class="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400 border border-green-500/30"
          >
            Plugin API
          </span>
        </div>
      </div>
      <Button variant="secondary" @click.stop="fetchPlayers" :class="{ 'animate-spin': loading }">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </Button>
    </div>

    <!-- Success Message -->
    <div v-if="successMessage" class="p-4 bg-status-success/10 border border-status-success/20 rounded-lg">
      <p class="text-status-success">{{ successMessage }}</p>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2">
      <button
        @click="activeTab = 'online'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors',
          activeTab === 'online'
            ? 'bg-hytale-orange text-dark'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        {{ t('players.online') }} ({{ players.length }})
      </button>
      <button
        @click="activeTab = 'offline'; fetchOfflinePlayers()"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors',
          activeTab === 'offline'
            ? 'bg-hytale-orange text-dark'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        {{ t('players.offline') }} ({{ offlinePlayers.length }})
      </button>
    </div>

    <!-- Online Players -->
    <Card v-if="activeTab === 'online'" :padding="false">
      <div v-if="loading" class="text-center text-gray-500 p-8">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="players.length === 0" class="text-center text-gray-500 p-8">
        <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
        {{ t('players.noPlayers') }}
      </div>

      <div v-else class="divide-y divide-dark-50/30">
        <div
          v-for="player in players"
          :key="player.name"
          class="flex items-center justify-between p-4 hover:bg-dark-50/20 transition-colors"
        >
          <!-- Player Info -->
          <div class="flex items-center gap-4 flex-1 min-w-0">
            <div class="w-10 h-10 bg-hytale-orange/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <span class="text-hytale-orange font-bold">{{ player.name[0].toUpperCase() }}</span>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <p class="font-medium text-white">{{ player.name }}</p>
                <!-- Gamemode badge when plugin available -->
                <span
                  v-if="pluginAvailable && player.gameMode"
                  class="px-2 py-0.5 text-xs rounded-full bg-dark-50 text-gray-400"
                >
                  {{ player.gameMode }}
                </span>
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
                <span>{{ t('players.sessionTime') }}: {{ player.session_duration }}</span>
                <!-- Plugin-provided details -->
                <span v-if="pluginAvailable && player.ping !== undefined">
                  <span class="text-gray-600">Ping:</span>
                  <span :class="player.ping < 100 ? 'text-green-400' : player.ping < 200 ? 'text-yellow-400' : 'text-red-400'">
                    {{ player.ping }}ms
                  </span>
                </span>
                <span v-if="pluginAvailable && player.health !== undefined">
                  <span class="text-gray-600">HP:</span>
                  <span :class="player.health > 15 ? 'text-green-400' : player.health > 8 ? 'text-yellow-400' : 'text-red-400'">
                    {{ player.health.toFixed(0) }}
                  </span>
                </span>
                <span v-if="pluginAvailable && player.position" class="text-gray-600">
                  {{ Math.floor(player.position.x) }}, {{ Math.floor(player.position.y) }}, {{ Math.floor(player.position.z) }}
                </span>
                <span v-if="pluginAvailable && player.world" class="flex items-center gap-1">
                  <svg class="w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span class="text-cyan-400">{{ player.world }}</span>
                </span>
              </div>
            </div>
          </div>

          <!-- Quick Actions -->
          <div class="flex items-center gap-2">
            <!-- Heal -->
            <button
              @click.stop="handleHeal(player.name)"
              class="p-2 text-gray-400 hover:text-green-400 transition-colors"
              :title="t('players.heal')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
            </button>

            <!-- Teleport -->
            <button
              @click.stop="openTeleportModal(player.name)"
              class="p-2 text-gray-400 hover:text-blue-400 transition-colors"
              :title="t('players.teleport')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            <!-- Kick -->
            <button
              @click.stop="openKickModal(player.name)"
              class="p-2 text-gray-400 hover:text-yellow-400 transition-colors"
              :title="t('players.kick')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </button>

            <!-- Ban -->
            <button
              @click.stop="openBanModal(player.name)"
              class="p-2 text-gray-400 hover:text-red-400 transition-colors"
              :title="t('players.ban')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </button>

            <!-- More Actions Dropdown -->
            <div class="relative">
              <button
                @click.stop="toggleDropdown(player.name)"
                class="p-2 text-gray-400 hover:text-white transition-colors"
                :title="t('players.moreActions')"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
              </button>

              <!-- Dropdown Menu -->
              <div
                v-if="openDropdown === player.name"
                class="absolute right-0 top-full mt-1 w-48 bg-dark-200 border border-dark-50 rounded-lg shadow-xl z-50 py-1"
                @click.stop
              >
                <button @click="handleOp(player.name)" class="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  {{ t('players.op') }}
                </button>
                <button @click="handleDeop(player.name)" class="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.618 5.984A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  {{ t('players.deop') }}
                </button>
                <div class="border-t border-dark-50 my-1"></div>
                <button @click="openGamemodeModal(player.name)" class="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {{ t('players.gamemode') }}
                </button>
                <button @click="openGiveModal(player.name)" class="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
                  </svg>
                  {{ t('players.give') }}
                </button>
                <div class="border-t border-dark-50 my-1"></div>
                <button @click="handleRespawn(player.name)" class="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {{ t('players.respawn') }}
                </button>
                <button @click="handleClearEffects(player.name)" class="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                  </svg>
                  {{ t('players.clearEffects') }}
                </button>
                <div class="border-t border-dark-50 my-1"></div>
                <button @click="handleWhitelist(player.name)" class="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {{ t('players.addToWhitelist') }}
                </button>
                <div class="border-t border-dark-50 my-1"></div>
                <button @click="openKillModal(player.name)" class="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  {{ t('players.kill') }}
                </button>
                <button @click="openClearInventoryModal(player.name)" class="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-dark-100 flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  {{ t('players.clearInventory') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>

    <!-- Offline Players -->
    <Card v-if="activeTab === 'offline'" :padding="false">
      <div v-if="offlineLoading" class="text-center text-gray-500 p-8">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="offlinePlayers.length === 0" class="text-center text-gray-500 p-8">
        <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
        {{ t('players.noOfflinePlayers') }}
      </div>

      <div v-else class="divide-y divide-dark-50/30">
        <div
          v-for="player in offlinePlayers"
          :key="player.name"
          class="flex items-center justify-between p-4 hover:bg-dark-50/20 transition-colors"
        >
          <!-- Player Info -->
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 bg-gray-500/20 rounded-lg flex items-center justify-center">
              <span class="text-gray-400 font-bold">{{ player.name[0].toUpperCase() }}</span>
            </div>
            <div>
              <p class="font-medium text-white">{{ player.name }}</p>
              <p v-if="player.uuid" class="text-xs text-gray-500 font-mono">{{ player.uuid }}</p>
              <div class="flex gap-4 text-sm text-gray-500 mt-1">
                <span>{{ t('players.lastSeen') }}: {{ formatDate(player.lastSeen) }}</span>
                <span>{{ t('players.totalPlayTime') }}: {{ formatPlayTime(player.playTime) }}</span>
                <span>{{ t('players.sessions') }}: {{ player.sessionCount }}</span>
              </div>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-2">
            <!-- Whitelist -->
            <button
              @click.stop="handleWhitelist(player.name)"
              class="p-2 text-gray-400 hover:text-green-400 transition-colors"
              :title="t('players.addToWhitelist')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>

            <!-- Ban -->
            <button
              @click.stop="openBanModal(player.name, player.uuid)"
              class="p-2 text-gray-400 hover:text-red-400 transition-colors"
              :title="t('players.ban')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </Card>

    <!-- Kick Modal -->
    <Modal :open="showKickModal" :title="t('players.kick')" @close="showKickModal = false">
      <p class="text-gray-300">
        {{ t('players.confirmKick') }}
        <span class="font-semibold text-white">{{ selectedPlayer }}</span>
      </p>
      <template #footer>
        <Button variant="secondary" @click="showKickModal = false">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="actionLoading" @click="confirmKick">{{ t('players.kick') }}</Button>
      </template>
    </Modal>

    <!-- Ban Modal -->
    <Modal :open="showBanModal" :title="t('players.ban')" @close="showBanModal = false">
      <div class="space-y-4">
        <p class="text-gray-300">
          {{ t('players.confirmBan') }}
          <span class="font-semibold text-white">{{ selectedPlayer }}</span>
        </p>
        <p v-if="selectedPlayerUuid" class="text-xs text-gray-500 font-mono">
          UUID: {{ selectedPlayerUuid }}
        </p>
        <div>
          <label class="block text-sm text-gray-400 mb-2">{{ t('players.banReason') }}</label>
          <input
            v-model="banReason"
            type="text"
            placeholder="No reason"
            class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
          />
        </div>
      </div>
      <template #footer>
        <Button variant="secondary" @click="showBanModal = false">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="actionLoading" @click="confirmBan">{{ t('players.ban') }}</Button>
      </template>
    </Modal>

    <!-- Kill Modal -->
    <Modal :open="showKillModal" :title="t('players.kill')" @close="showKillModal = false">
      <p class="text-gray-300">
        {{ t('players.confirmKill') }}
        <span class="font-semibold text-white">{{ selectedPlayer }}</span>
      </p>
      <template #footer>
        <Button variant="secondary" @click="showKillModal = false">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="actionLoading" @click="confirmKill">{{ t('players.kill') }}</Button>
      </template>
    </Modal>

    <!-- Clear Inventory Modal -->
    <Modal :open="showClearInventoryModal" :title="t('players.clearInventory')" @close="showClearInventoryModal = false">
      <p class="text-gray-300">
        {{ t('players.confirmClearInventory') }}
        <span class="font-semibold text-white">{{ selectedPlayer }}</span>
      </p>
      <template #footer>
        <Button variant="secondary" @click="showClearInventoryModal = false">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="actionLoading" @click="confirmClearInventory">{{ t('players.clearInventory') }}</Button>
      </template>
    </Modal>

    <!-- Teleport Modal -->
    <Modal :open="showTeleportModal" :title="t('players.teleport') + ': ' + selectedPlayer" @close="showTeleportModal = false">
      <div class="space-y-4">
        <!-- Mode Toggle -->
        <div class="flex gap-2">
          <button
            @click="teleportMode = 'player'"
            :class="['flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors', teleportMode === 'player' ? 'bg-hytale-orange text-dark' : 'bg-dark-100 text-gray-400']"
          >
            {{ t('players.teleportTo') }}
          </button>
          <button
            @click="teleportMode = 'coords'"
            :class="['flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors', teleportMode === 'coords' ? 'bg-hytale-orange text-dark' : 'bg-dark-100 text-gray-400']"
          >
            {{ t('players.teleportCoords') }}
          </button>
        </div>

        <!-- Player Target -->
        <div v-if="teleportMode === 'player'">
          <label class="block text-sm font-medium text-gray-400 mb-2">{{ t('players.name') }}</label>
          <select
            v-model="teleportTarget"
            class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
          >
            <option value="">-- {{ t('players.name') }} --</option>
            <option v-for="p in players.filter(x => x.name !== selectedPlayer)" :key="p.name" :value="p.name">
              {{ p.name }}
            </option>
          </select>
        </div>

        <!-- Coordinates -->
        <div v-else class="grid grid-cols-3 gap-3">
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">X</label>
            <input
              v-model.number="teleportX"
              type="number"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">Y</label>
            <input
              v-model.number="teleportY"
              type="number"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-2">Z</label>
            <input
              v-model.number="teleportZ"
              type="number"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
            />
          </div>
        </div>
      </div>
      <template #footer>
        <Button variant="secondary" @click="showTeleportModal = false">{{ t('common.cancel') }}</Button>
        <Button :loading="actionLoading" @click="confirmTeleport">{{ t('players.teleport') }}</Button>
      </template>
    </Modal>

    <!-- Gamemode Modal -->
    <Modal :open="showGamemodeModal" :title="t('players.gamemode') + ': ' + selectedPlayer" @close="showGamemodeModal = false">
      <div class="grid grid-cols-2 gap-3">
        <button
          @click="setGamemode('survival')"
          class="p-4 bg-dark-100 hover:bg-dark-50 rounded-lg text-left transition-colors"
        >
          <div class="font-medium text-white">{{ t('players.gamemodes.survival') }}</div>
        </button>
        <button
          @click="setGamemode('creative')"
          class="p-4 bg-dark-100 hover:bg-dark-50 rounded-lg text-left transition-colors"
        >
          <div class="font-medium text-white">{{ t('players.gamemodes.creative') }}</div>
        </button>
        <button
          @click="setGamemode('adventure')"
          class="p-4 bg-dark-100 hover:bg-dark-50 rounded-lg text-left transition-colors"
        >
          <div class="font-medium text-white">{{ t('players.gamemodes.adventure') }}</div>
        </button>
        <button
          @click="setGamemode('spectator')"
          class="p-4 bg-dark-100 hover:bg-dark-50 rounded-lg text-left transition-colors"
        >
          <div class="font-medium text-white">{{ t('players.gamemodes.spectator') }}</div>
        </button>
      </div>
    </Modal>

    <!-- Give Item Modal -->
    <Modal :open="showGiveModal" :title="t('players.give') + ': ' + selectedPlayer" @close="showGiveModal = false">
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-400 mb-2">{{ t('players.itemId') }}</label>
          <input
            v-model="giveItem"
            type="text"
            placeholder="hytale:diamond"
            class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-400 mb-2">{{ t('players.amount') }}</label>
          <input
            v-model.number="giveAmount"
            type="number"
            min="1"
            max="64"
            class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
          />
        </div>
      </div>
      <template #footer>
        <Button variant="secondary" @click="showGiveModal = false">{{ t('common.cancel') }}</Button>
        <Button :loading="actionLoading" @click="confirmGive" :disabled="!giveItem">{{ t('players.give') }}</Button>
      </template>
    </Modal>
  </div>
</template>
