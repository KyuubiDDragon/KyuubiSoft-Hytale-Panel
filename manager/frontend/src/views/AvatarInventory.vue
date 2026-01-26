<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { playersApi, type UnifiedPlayerEntry, type ChatMessage, type DeathPosition } from '@/api/players'
import { serverApi, type FilePlayerDetails, type FilePlayerInventory, type FileInventoryItem } from '@/api/server'
import { assetsApi } from '@/api/assets'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// Player search state
const searchQuery = ref('')
const players = ref<UnifiedPlayerEntry[]>([])
const filteredPlayers = computed(() => {
  if (!searchQuery.value) return players.value
  const query = searchQuery.value.toLowerCase()
  return players.value.filter(p => p.name.toLowerCase().includes(query))
})
const showPlayerDropdown = ref(false)
const loadingPlayers = ref(false)

// Selected player state
const selectedPlayer = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const details = ref<FilePlayerDetails | null>(null)
const inventory = ref<FilePlayerInventory | null>(null)

// Avatar state
const avatarLoading = ref(true)
const avatarError = ref(false)
const avatarRotation = ref(0)

// Tooltip state
const hoveredItem = ref<FileInventoryItem | null>(null)
const tooltipPosition = ref({ x: 0, y: 0 })

// Window dimensions for tooltip positioning
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1200)
const windowHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 800)

// Quick slot expansion state
const expandedQuickSlot = ref<number | null>(null)

// Track which icons failed to load
const failedIcons = ref<Set<string>>(new Set())

// Right panel tab state
const activeTab = ref<'inventory' | 'info' | 'chat' | 'deaths'>('inventory')

// Chat state
const chatMessages = ref<ChatMessage[]>([])
const chatLoading = ref(false)
const chatTotal = ref(0)

// Death positions state
const deathPositions = ref<DeathPosition[]>([])
const deathsLoading = ref(false)
const teleportingDeath = ref(false)

function updateWindowDimensions() {
  windowWidth.value = window.innerWidth
  windowHeight.value = window.innerHeight
}

onMounted(async () => {
  window.addEventListener('resize', updateWindowDimensions)
  await loadPlayers()

  // Check if player name is in URL
  const playerParam = route.query.player as string
  if (playerParam) {
    searchQuery.value = playerParam
    await selectPlayer(playerParam)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', updateWindowDimensions)
})

async function loadPlayers() {
  loadingPlayers.value = true
  try {
    const result = await playersApi.getAll()
    players.value = result.players
  } catch {
    // Silently fail
  } finally {
    loadingPlayers.value = false
  }
}

async function selectPlayer(playerName: string) {
  selectedPlayer.value = playerName
  searchQuery.value = playerName
  showPlayerDropdown.value = false
  avatarLoading.value = true
  avatarError.value = false
  failedIcons.value = new Set()

  // Reset tab data
  activeTab.value = 'inventory'
  chatMessages.value = []
  chatTotal.value = 0
  deathPositions.value = []

  // Update URL
  router.replace({ query: { player: playerName } })

  loading.value = true
  error.value = ''

  try {
    const [detailsRes, inventoryRes] = await Promise.all([
      serverApi.getFilePlayerDetails(playerName).catch(() => null),
      serverApi.getFilePlayerInventory(playerName).catch(() => null)
    ])

    if (detailsRes?.success && detailsRes.data) {
      details.value = detailsRes.data
    }
    if (inventoryRes?.success && inventoryRes.data) {
      inventory.value = inventoryRes.data
    }

    if (!details.value && !inventory.value) {
      error.value = t('avatarInventory.noData')
    }
  } catch {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

// Load chat messages when tab is selected
async function loadChat() {
  if (!selectedPlayer.value || chatMessages.value.length > 0) return

  chatLoading.value = true
  try {
    const result = await playersApi.getPlayerChatLog(selectedPlayer.value, { limit: 100 })
    chatMessages.value = result.messages
    chatTotal.value = result.total
  } catch {
    // Silently fail
  } finally {
    chatLoading.value = false
  }
}

// Load death positions when tab is selected
async function loadDeaths() {
  if (!selectedPlayer.value || deathPositions.value.length > 0) return

  deathsLoading.value = true
  try {
    const result = await playersApi.getDeathPositions(selectedPlayer.value)
    deathPositions.value = result.positions
  } catch {
    // Silently fail
  } finally {
    deathsLoading.value = false
  }
}

// Teleport to death position
async function teleportToDeath(index: number) {
  if (!selectedPlayer.value) return

  teleportingDeath.value = true
  try {
    await playersApi.teleportToDeath(selectedPlayer.value, index)
  } catch {
    // Silently fail
  } finally {
    teleportingDeath.value = false
  }
}

// Watch for tab changes
watch(activeTab, (tab) => {
  if (tab === 'chat') {
    loadChat()
  } else if (tab === 'deaths') {
    loadDeaths()
  }
})

// Format chat timestamp
function formatChatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

// Get unique color for player name in chat
function getPlayerColor(name: string): string {
  const colors = [
    'text-blue-400', 'text-green-400', 'text-yellow-400', 'text-purple-400',
    'text-pink-400', 'text-cyan-400', 'text-orange-400', 'text-red-400',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length]
}

// Avatar URL using hyvatar.io API
function getAvatarUrl(playerName: string): string {
  return `https://hyvatar.io/render/full/${encodeURIComponent(playerName)}?size=512&rotate=${avatarRotation.value}`
}

function onAvatarLoad() {
  avatarLoading.value = false
}

function onAvatarError() {
  avatarLoading.value = false
  avatarError.value = true
}

// Stats calculations
const healthPercent = computed(() => {
  if (!details.value?.stats) return 0
  return Math.min(100, (details.value.stats.health / details.value.stats.maxHealth) * 100)
})

const staminaPercent = computed(() => {
  if (!details.value?.stats) return 0
  return Math.min(100, (details.value.stats.stamina / details.value.stats.maxStamina) * 100)
})

const manaPercent = computed(() => {
  if (!details.value?.stats) return 0
  // Mana might not have a max value, show as full if 0/0
  if (details.value.stats.mana === 0) return 0
  return 100 // Assume full for now
})

// Defense calculation (placeholder - would need armor values)
const defensePercent = computed(() => {
  // This would be calculated from equipped armor
  // For now, return a placeholder based on armor count
  if (!inventory.value) return 0
  const armorCount = inventory.value.armor.length
  return Math.min(100, armorCount * 25)
})

// Item helpers
function getItemIconUrl(itemId: string): string {
  return assetsApi.getItemIconUrl(itemId)
}

function onIconError(itemId: string) {
  failedIcons.value.add(itemId)
}

function iconFailed(itemId: string): boolean {
  return failedIcons.value.has(itemId)
}

function getDurabilityPercent(item: FileInventoryItem): number {
  if (!item.maxDurability || item.maxDurability === 0) return 100
  return Math.min(100, (item.durability / item.maxDurability) * 100)
}

function getDurabilityColor(item: FileInventoryItem): string {
  const p = getDurabilityPercent(item)
  if (p > 60) return 'bg-green-500'
  if (p > 30) return 'bg-yellow-500'
  return 'bg-red-500'
}

function getFallbackLetter(itemId: string): string {
  const id = itemId.toLowerCase()
  if (id.includes('sword')) return 'S'
  if (id.includes('axe') || id.includes('hatchet')) return 'A'
  if (id.includes('pickaxe')) return 'P'
  if (id.includes('bow')) return 'B'
  if (id.includes('armor') || id.includes('chest')) return 'C'
  if (id.includes('head') || id.includes('helmet')) return 'H'
  if (id.includes('legs')) return 'L'
  if (id.includes('hands') || id.includes('gloves')) return 'G'
  if (id.includes('shield')) return 'D'
  if (id.includes('food') || id.includes('meat')) return 'F'
  if (id.includes('potion')) return '!'
  return '?'
}

function getItemColorClass(itemId: string): string {
  const id = itemId.toLowerCase()
  if (id.includes('adamantite')) return 'text-purple-400 bg-purple-500/20'
  if (id.includes('thorium')) return 'text-green-400 bg-green-500/20'
  if (id.includes('cobalt')) return 'text-blue-400 bg-blue-500/20'
  if (id.includes('iron')) return 'text-gray-300 bg-gray-500/20'
  if (id.includes('gold')) return 'text-yellow-400 bg-yellow-500/20'
  return 'text-gray-300 bg-gray-600/30'
}

function getItemRarityBorder(itemId: string): string {
  const id = itemId.toLowerCase()
  if (id.includes('adamantite')) return 'border-purple-500/50'
  if (id.includes('thorium')) return 'border-green-500/50'
  if (id.includes('cobalt')) return 'border-blue-500/50'
  if (id.includes('gold')) return 'border-yellow-500/50'
  return 'border-slate-600/50'
}

// Tooltip
function showTooltip(item: FileInventoryItem, event: MouseEvent) {
  hoveredItem.value = item
  tooltipPosition.value = { x: event.clientX, y: event.clientY }
}

function hideTooltip() {
  hoveredItem.value = null
}

// Inventory grids
function generateGrid(items: FileInventoryItem[], capacity: number): (FileInventoryItem | null)[] {
  const grid: (FileInventoryItem | null)[] = Array(capacity).fill(null)
  for (const item of items) {
    if (item.slot >= 0 && item.slot < capacity) {
      grid[item.slot] = item
    }
  }
  return grid
}

const hotbarGrid = computed(() => {
  if (!inventory.value) return []
  return generateGrid(inventory.value.hotbar, 9)
})

const armorGrid = computed(() => {
  if (!inventory.value) return []
  return generateGrid(inventory.value.armor, 4)
})

const utilityGrid = computed(() => {
  if (!inventory.value) return []
  return generateGrid(inventory.value.utility, 4)
})

const storageGrid = computed(() => {
  if (!inventory.value) return []
  return generateGrid(inventory.value.storage, 28) // 7x4
})

const backpackGrid = computed(() => {
  if (!inventory.value) return []
  const capacity = inventory.value.backpack.length > 0 ? Math.max(7, inventory.value.backpack.length) : 7
  return generateGrid(inventory.value.backpack, capacity)
})

// Armor slot labels
const armorSlotLabels = ['H', 'C', 'G', 'L'] // Head, Chest, Gloves, Legs
const armorSlotNames = [
  t('avatarInventory.slots.helmet'),
  t('avatarInventory.slots.chest'),
  t('avatarInventory.slots.gloves'),
  t('avatarInventory.slots.legs')
]

// Quick slot toggle
function toggleQuickSlot(index: number) {
  if (expandedQuickSlot.value === index) {
    expandedQuickSlot.value = null
  } else {
    expandedQuickSlot.value = index
  }
}
</script>

<template>
  <div class="h-full flex flex-col bg-dark-300">
    <!-- Header with search -->
    <div class="bg-dark-200 border-b border-dark-50 px-6 py-4">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold text-white">{{ t('avatarInventory.title') }}</h1>
          <p class="text-gray-400 text-sm mt-1">{{ t('avatarInventory.subtitle') }}</p>
        </div>

        <!-- Player Search -->
        <div class="relative w-80">
          <div class="relative">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('avatarInventory.searchPlayer')"
              class="w-full pl-10 pr-4 py-2.5 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange/50 focus:ring-1 focus:ring-hytale-orange/50"
              @focus="showPlayerDropdown = true"
              @blur="setTimeout(() => showPlayerDropdown = false, 200)"
            />
          </div>

          <!-- Player Dropdown -->
          <div
            v-if="showPlayerDropdown && filteredPlayers.length > 0"
            class="absolute top-full left-0 right-0 mt-1 bg-dark-100 border border-dark-50 rounded-lg shadow-xl max-h-64 overflow-y-auto z-50"
          >
            <button
              v-for="player in filteredPlayers"
              :key="player.uuid"
              class="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-dark-200 transition-colors text-left"
              @click="selectPlayer(player.name)"
            >
              <div :class="['w-2 h-2 rounded-full', player.online ? 'bg-green-500' : 'bg-gray-500']" />
              <span class="text-white">{{ player.name }}</span>
              <span v-if="player.online" class="text-xs text-green-400 ml-auto">Online</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Content -->
    <div class="flex-1 overflow-auto p-6">
      <!-- No player selected -->
      <div v-if="!selectedPlayer" class="flex flex-col items-center justify-center h-full text-center">
        <svg class="w-24 h-24 text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        <h2 class="text-xl font-semibold text-gray-400 mb-2">{{ t('avatarInventory.selectPrompt') }}</h2>
        <p class="text-gray-500">{{ t('avatarInventory.selectHint') }}</p>
      </div>

      <!-- Loading -->
      <div v-else-if="loading" class="flex items-center justify-center h-full">
        <div class="flex items-center gap-3 text-gray-400">
          <svg class="w-8 h-8 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span class="text-lg">{{ t('common.loading') }}</span>
        </div>
      </div>

      <!-- Error -->
      <div v-else-if="error" class="flex flex-col items-center justify-center h-full text-center">
        <svg class="w-16 h-16 text-red-500/50 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p class="text-gray-400 text-lg">{{ error }}</p>
      </div>

      <!-- Player Inventory View -->
      <div v-else class="flex gap-6 max-w-7xl mx-auto">
        <!-- Left Panel: Avatar + Equipment + Stats -->
        <div class="w-[340px] flex-shrink-0 space-y-4">
          <!-- Player Name Header -->
          <div class="bg-gradient-to-r from-slate-800/80 to-slate-900/80 rounded-t-xl border border-slate-600/50 px-4 py-3">
            <h2 class="text-lg font-bold text-white uppercase tracking-wide">{{ selectedPlayer }}</h2>
          </div>

          <!-- Avatar + Equipment Container -->
          <div class="bg-gradient-to-b from-slate-800/60 to-slate-900/60 rounded-xl border border-slate-600/30 p-4 relative">
            <div class="flex gap-4">
              <!-- Equipment Slots (Left side) -->
              <div class="flex flex-col gap-2">
                <!-- Cosmetic Slot -->
                <div class="inventory-slot w-12 h-12 border-2 border-cyan-500/30 bg-slate-800/50 rounded-lg flex items-center justify-center" :title="t('avatarInventory.slots.cosmetic')">
                  <svg class="w-6 h-6 text-cyan-400/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>

                <!-- Tools Slot -->
                <div class="inventory-slot w-12 h-12 border-2 border-amber-500/30 bg-slate-800/50 rounded-lg flex items-center justify-center" :title="t('avatarInventory.slots.tools')">
                  <svg class="w-6 h-6 text-amber-400/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  </svg>
                </div>

                <!-- Armor Slots -->
                <div
                  v-for="(item, index) in armorGrid"
                  :key="`armor-${index}`"
                  class="inventory-slot w-12 h-12 border-2 rounded-lg flex items-center justify-center relative cursor-pointer transition-all"
                  :class="[
                    item ? getItemRarityBorder(item.itemId) + ' bg-slate-700/50' : 'border-blue-500/30 bg-slate-800/50'
                  ]"
                  :title="armorSlotNames[index]"
                  @mouseenter="item && showTooltip(item, $event)"
                  @mouseleave="hideTooltip"
                >
                  <template v-if="item">
                    <img
                      v-if="!iconFailed(item.itemId)"
                      :src="getItemIconUrl(item.itemId)"
                      :alt="item.displayName"
                      class="w-10 h-10 object-contain"
                      @error="onIconError(item.itemId)"
                    />
                    <div v-else :class="['w-10 h-10 rounded flex items-center justify-center text-lg font-bold', getItemColorClass(item.itemId)]">
                      {{ armorSlotLabels[index] }}
                    </div>
                    <!-- Durability bar -->
                    <div v-if="item.maxDurability > 0" class="absolute bottom-0 left-0 right-0 h-1 bg-slate-900 rounded-b overflow-hidden">
                      <div :class="['h-full', getDurabilityColor(item)]" :style="{ width: `${getDurabilityPercent(item)}%` }"></div>
                    </div>
                  </template>
                  <span v-else class="text-blue-400/40 font-bold text-sm">{{ armorSlotLabels[index] }}</span>
                </div>
              </div>

              <!-- Avatar Display -->
              <div class="flex-1 relative">
                <div class="aspect-[3/4] bg-gradient-to-b from-slate-700/30 to-slate-900/50 rounded-lg border border-slate-600/30 overflow-hidden relative">
                  <!-- Loading Spinner -->
                  <div v-if="avatarLoading" class="absolute inset-0 flex items-center justify-center">
                    <svg class="w-12 h-12 animate-spin text-hytale-orange/50" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                    </svg>
                  </div>

                  <!-- Avatar Image -->
                  <img
                    v-if="selectedPlayer && !avatarError"
                    :src="getAvatarUrl(selectedPlayer)"
                    :alt="selectedPlayer"
                    class="w-full h-full object-contain"
                    :class="{ 'opacity-0': avatarLoading }"
                    @load="onAvatarLoad"
                    @error="onAvatarError"
                  />

                  <!-- Avatar Error Fallback -->
                  <div v-if="avatarError" class="absolute inset-0 flex flex-col items-center justify-center text-gray-500">
                    <svg class="w-20 h-20 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                    <span class="text-2xl font-bold text-hytale-orange">{{ selectedPlayer?.[0]?.toUpperCase() }}</span>
                  </div>
                </div>

                <!-- Expand Arrow (decorative) -->
                <div class="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 text-hytale-orange/60">
                  <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M10 17l5-5-5-5v10z"/>
                  </svg>
                </div>
              </div>
            </div>

            <!-- Quick Slots Row -->
            <div class="flex justify-center gap-2 mt-4">
              <!-- Accessory Quick Slot -->
              <div class="relative group">
                <div
                  class="inventory-slot w-11 h-11 border-2 border-purple-500/30 bg-slate-800/50 rounded-lg flex items-center justify-center cursor-pointer hover:border-purple-500/60 transition-all"
                  @mouseenter="expandedQuickSlot = 0"
                >
                  <svg class="w-5 h-5 text-purple-400/60" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                </div>
                <!-- Expanded Slots -->
                <div
                  v-if="expandedQuickSlot === 0"
                  class="absolute left-full top-0 ml-2 flex gap-1 p-2 bg-slate-800/95 border border-slate-600/50 rounded-lg shadow-xl z-10"
                  @mouseleave="expandedQuickSlot = null"
                >
                  <div v-for="i in 4" :key="i" class="w-9 h-9 border border-purple-500/30 bg-slate-700/50 rounded flex items-center justify-center">
                    <span class="text-xs text-purple-400/40">{{ i }}</span>
                  </div>
                </div>
              </div>

              <!-- Pet/Companion Quick Slot -->
              <div class="relative group">
                <div
                  class="inventory-slot w-11 h-11 border-2 border-amber-500/30 bg-slate-800/50 rounded-lg flex items-center justify-center cursor-pointer hover:border-amber-500/60 transition-all"
                  @mouseenter="expandedQuickSlot = 1"
                >
                  <svg class="w-5 h-5 text-amber-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                  </svg>
                  <span class="absolute -right-1 -bottom-1 text-amber-400/80 text-xs">
                    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M10 17l5-5-5-5v10z"/></svg>
                  </span>
                </div>
                <!-- Expanded Pet Slots -->
                <div
                  v-if="expandedQuickSlot === 1"
                  class="absolute left-full top-0 ml-2 flex gap-1 p-2 bg-slate-800/95 border border-slate-600/50 rounded-lg shadow-xl z-10"
                  @mouseleave="expandedQuickSlot = null"
                >
                  <div v-for="i in 4" :key="i" class="w-9 h-9 border border-amber-500/30 bg-slate-700/50 rounded flex items-center justify-center">
                    <span class="text-xs text-amber-400/40">{{ i }}</span>
                  </div>
                </div>
              </div>

              <!-- Emote Quick Slot -->
              <div class="relative group">
                <div
                  class="inventory-slot w-11 h-11 border-2 border-green-500/30 bg-slate-800/50 rounded-lg flex items-center justify-center cursor-pointer hover:border-green-500/60 transition-all"
                  @mouseenter="expandedQuickSlot = 2"
                >
                  <span class="text-green-400/60 font-bold text-lg">Y</span>
                </div>
                <!-- Expanded Emote Slots -->
                <div
                  v-if="expandedQuickSlot === 2"
                  class="absolute left-full top-0 ml-2 flex gap-1 p-2 bg-slate-800/95 border border-slate-600/50 rounded-lg shadow-xl z-10"
                  @mouseleave="expandedQuickSlot = null"
                >
                  <div v-for="i in 4" :key="i" class="w-9 h-9 border border-green-500/30 bg-slate-700/50 rounded flex items-center justify-center">
                    <span class="text-xs text-green-400/40">{{ i }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Stats Panel -->
          <div class="bg-gradient-to-b from-slate-800/60 to-slate-900/60 rounded-xl border border-slate-600/30 p-4">
            <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">{{ t('avatarInventory.stats') }}</h3>

            <div class="space-y-3">
              <!-- Health -->
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-red-400 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                </svg>
                <div class="flex-1">
                  <div class="flex justify-between text-xs mb-1">
                    <span class="text-gray-400">{{ t('avatarInventory.health') }}</span>
                    <span class="text-white font-mono">{{ details?.stats?.health?.toFixed(0) || 0 }}/{{ details?.stats?.maxHealth?.toFixed(0) || 0 }}</span>
                  </div>
                  <div class="h-2 bg-slate-900 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all" :style="{ width: `${healthPercent}%` }"></div>
                  </div>
                </div>
              </div>

              <!-- Stamina -->
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <div class="flex-1">
                  <div class="flex justify-between text-xs mb-1">
                    <span class="text-gray-400">{{ t('avatarInventory.stamina') }}</span>
                    <span class="text-white font-mono">{{ details?.stats?.stamina?.toFixed(0) || 0 }}/{{ details?.stats?.maxStamina?.toFixed(0) || 0 }}</span>
                  </div>
                  <div class="h-2 bg-slate-900 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-yellow-600 to-yellow-400 transition-all" :style="{ width: `${staminaPercent}%` }"></div>
                  </div>
                </div>
              </div>

              <!-- Mana -->
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-blue-400 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8z"/>
                </svg>
                <div class="flex-1">
                  <div class="flex justify-between text-xs mb-1">
                    <span class="text-gray-400">{{ t('avatarInventory.mana') }}</span>
                    <span class="text-white font-mono">{{ details?.stats?.mana?.toFixed(0) || 0 }}/{{ details?.stats?.mana?.toFixed(0) || 0 }}</span>
                  </div>
                  <div class="h-2 bg-slate-900 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all" :style="{ width: `${manaPercent}%` }"></div>
                  </div>
                </div>
              </div>

              <!-- Defense -->
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <div class="flex-1">
                  <div class="flex justify-between text-xs mb-1">
                    <span class="text-gray-400">{{ t('avatarInventory.defense') }}</span>
                    <span class="text-white font-mono">{{ defensePercent }}%</span>
                  </div>
                  <div class="h-2 bg-slate-900 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-gray-600 to-gray-400 transition-all" :style="{ width: `${defensePercent}%` }"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Panel: Tabs -->
        <div class="flex-1 space-y-4">
          <!-- Tab Navigation -->
          <div class="flex gap-1 bg-slate-800/40 p-1 rounded-lg">
            <button
              @click="activeTab = 'inventory'"
              :class="[
                'flex-1 px-4 py-2 rounded-md font-medium text-sm transition-all',
                activeTab === 'inventory'
                  ? 'bg-slate-700 text-white shadow'
                  : 'text-gray-400 hover:text-white hover:bg-slate-700/50'
              ]"
            >
              <span class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                {{ t('avatarInventory.inventory') }}
              </span>
            </button>
            <button
              @click="activeTab = 'info'"
              :class="[
                'flex-1 px-4 py-2 rounded-md font-medium text-sm transition-all',
                activeTab === 'info'
                  ? 'bg-slate-700 text-white shadow'
                  : 'text-gray-400 hover:text-white hover:bg-slate-700/50'
              ]"
            >
              <span class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ t('avatarInventory.info') }}
              </span>
            </button>
            <button
              @click="activeTab = 'chat'"
              :class="[
                'flex-1 px-4 py-2 rounded-md font-medium text-sm transition-all',
                activeTab === 'chat'
                  ? 'bg-slate-700 text-white shadow'
                  : 'text-gray-400 hover:text-white hover:bg-slate-700/50'
              ]"
            >
              <span class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                {{ t('avatarInventory.chat') }}
              </span>
            </button>
            <button
              @click="activeTab = 'deaths'"
              :class="[
                'flex-1 px-4 py-2 rounded-md font-medium text-sm transition-all',
                activeTab === 'deaths'
                  ? 'bg-slate-700 text-white shadow'
                  : 'text-gray-400 hover:text-white hover:bg-slate-700/50'
              ]"
            >
              <span class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                {{ t('avatarInventory.deaths') }}
              </span>
            </button>
          </div>

          <!-- Tab Content: Inventory -->
          <div v-if="activeTab === 'inventory'" class="space-y-4">
            <!-- Backpack Section -->
            <div class="bg-gradient-to-b from-slate-800/60 to-slate-900/60 rounded-xl border border-slate-600/30 p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
                <svg class="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
                {{ t('avatarInventory.backpack') }}
              </h3>
              <!-- Toolbar icons (decorative) -->
              <div class="flex gap-1">
                <button class="p-1.5 text-gray-500 hover:text-gray-300 transition-colors">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
                <button class="p-1.5 text-gray-500 hover:text-gray-300 transition-colors">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                </button>
                <button class="p-1.5 text-gray-500 hover:text-gray-300 transition-colors">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- Backpack Grid -->
            <div class="grid grid-cols-7 gap-1">
              <div
                v-for="(item, index) in backpackGrid"
                :key="`backpack-${index}`"
                class="inventory-slot aspect-square border-2 rounded-lg flex items-center justify-center relative cursor-pointer transition-all"
                :class="[
                  item ? getItemRarityBorder(item.itemId) + ' bg-slate-700/50 hover:bg-slate-600/50' : 'border-slate-600/30 bg-slate-800/30'
                ]"
                @mouseenter="item && showTooltip(item, $event)"
                @mouseleave="hideTooltip"
              >
                <template v-if="item">
                  <img
                    v-if="!iconFailed(item.itemId)"
                    :src="getItemIconUrl(item.itemId)"
                    :alt="item.displayName"
                    class="w-10 h-10 object-contain"
                    @error="onIconError(item.itemId)"
                  />
                  <div v-else :class="['w-10 h-10 rounded flex items-center justify-center text-sm font-bold', getItemColorClass(item.itemId)]">
                    {{ getFallbackLetter(item.itemId) }}
                  </div>
                  <span v-if="item.amount > 1" class="absolute bottom-0 right-0.5 text-[10px] font-bold text-white drop-shadow-lg">
                    {{ item.amount }}
                  </span>
                </template>
              </div>
            </div>
          </div>

          <!-- Main Inventory Section -->
          <div class="bg-gradient-to-b from-slate-800/60 to-slate-900/60 rounded-xl border border-slate-600/30 p-4">
            <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              {{ t('avatarInventory.inventory') }}
            </h3>

            <!-- Storage Grid (7x4 = 28 slots) -->
            <div class="grid grid-cols-7 gap-1">
              <div
                v-for="(item, index) in storageGrid"
                :key="`storage-${index}`"
                class="inventory-slot aspect-square border-2 rounded-lg flex items-center justify-center relative cursor-pointer transition-all"
                :class="[
                  item ? getItemRarityBorder(item.itemId) + ' bg-slate-700/50 hover:bg-slate-600/50' : 'border-slate-600/30 bg-slate-800/30'
                ]"
                @mouseenter="item && showTooltip(item, $event)"
                @mouseleave="hideTooltip"
              >
                <template v-if="item">
                  <img
                    v-if="!iconFailed(item.itemId)"
                    :src="getItemIconUrl(item.itemId)"
                    :alt="item.displayName"
                    class="w-10 h-10 object-contain"
                    @error="onIconError(item.itemId)"
                  />
                  <div v-else :class="['w-10 h-10 rounded flex items-center justify-center text-sm font-bold', getItemColorClass(item.itemId)]">
                    {{ getFallbackLetter(item.itemId) }}
                  </div>
                  <span v-if="item.amount > 1" class="absolute bottom-0 right-0.5 text-[10px] font-bold text-white drop-shadow-lg">
                    {{ item.amount }}
                  </span>
                  <!-- Durability bar -->
                  <div v-if="item.maxDurability > 0" class="absolute bottom-0 left-0 right-0 h-1 bg-slate-900 rounded-b overflow-hidden">
                    <div :class="['h-full', getDurabilityColor(item)]" :style="{ width: `${getDurabilityPercent(item)}%` }"></div>
                  </div>
                </template>
              </div>
            </div>
          </div>

          <!-- Hotbar Section -->
          <div class="bg-gradient-to-b from-slate-800/60 to-slate-900/60 rounded-xl border border-slate-600/30 p-4">
            <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
              <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" />
              </svg>
              {{ t('avatarInventory.hotbar') }}
            </h3>

            <!-- Hotbar Grid -->
            <div class="grid grid-cols-9 gap-1">
              <div
                v-for="(item, index) in hotbarGrid"
                :key="`hotbar-${index}`"
                class="inventory-slot aspect-square border-2 rounded-lg flex items-center justify-center relative cursor-pointer transition-all"
                :class="[
                  item ? getItemRarityBorder(item.itemId) + ' bg-slate-700/50 hover:bg-slate-600/50' : 'border-slate-600/30 bg-slate-800/30',
                  inventory?.activeHotbarSlot === index ? 'ring-2 ring-hytale-orange ring-offset-1 ring-offset-slate-900' : ''
                ]"
                @mouseenter="item && showTooltip(item, $event)"
                @mouseleave="hideTooltip"
              >
                <template v-if="item">
                  <img
                    v-if="!iconFailed(item.itemId)"
                    :src="getItemIconUrl(item.itemId)"
                    :alt="item.displayName"
                    class="w-10 h-10 object-contain"
                    @error="onIconError(item.itemId)"
                  />
                  <div v-else :class="['w-10 h-10 rounded flex items-center justify-center text-sm font-bold', getItemColorClass(item.itemId)]">
                    {{ getFallbackLetter(item.itemId) }}
                  </div>
                  <span v-if="item.amount > 1" class="absolute bottom-0 right-0.5 text-[10px] font-bold text-white drop-shadow-lg">
                    {{ item.amount }}
                  </span>
                  <!-- Durability bar -->
                  <div v-if="item.maxDurability > 0" class="absolute bottom-0 left-0 right-0 h-1 bg-slate-900 rounded-b overflow-hidden">
                    <div :class="['h-full', getDurabilityColor(item)]" :style="{ width: `${getDurabilityPercent(item)}%` }"></div>
                  </div>
                </template>
                <!-- Slot number -->
                <span class="absolute top-0.5 left-1 text-[9px] font-bold text-slate-500">{{ index + 1 }}</span>
              </div>
            </div>
          </div>
          </div>

          <!-- Tab Content: Info -->
          <div v-else-if="activeTab === 'info'" class="space-y-4">
            <div class="bg-gradient-to-b from-slate-800/60 to-slate-900/60 rounded-xl border border-slate-600/30 p-4">
              <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">{{ t('avatarInventory.playerInfo') }}</h3>

              <div v-if="details" class="grid grid-cols-2 gap-4">
                <!-- World -->
                <div class="bg-slate-800/50 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {{ t('avatarInventory.world') }}
                  </div>
                  <p class="text-white font-medium">{{ details.world || '-' }}</p>
                </div>

                <!-- Gamemode -->
                <div class="bg-slate-800/50 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {{ t('avatarInventory.gamemode') }}
                  </div>
                  <p class="text-white font-medium capitalize">{{ details.gameMode || '-' }}</p>
                </div>

                <!-- Position -->
                <div class="bg-slate-800/50 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {{ t('avatarInventory.position') }}
                  </div>
                  <p class="text-white font-medium font-mono text-sm">
                    <span v-if="details.position">
                      {{ details.position.x.toFixed(1) }}, {{ details.position.y.toFixed(1) }}, {{ details.position.z.toFixed(1) }}
                    </span>
                    <span v-else class="text-gray-500">-</span>
                  </p>
                </div>

                <!-- Discovered Zones -->
                <div class="bg-slate-800/50 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                    </svg>
                    {{ t('avatarInventory.discoveredZones') }}
                  </div>
                  <p class="text-white font-medium">{{ details.discoveredZones?.length || 0 }}</p>
                </div>

                <!-- Memories -->
                <div class="bg-slate-800/50 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                    {{ t('avatarInventory.memories') }}
                  </div>
                  <p class="text-white font-medium">{{ details.memoriesCount || 0 }} NPCs</p>
                </div>

                <!-- Unique Items -->
                <div class="bg-slate-800/50 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
                    </svg>
                    {{ t('avatarInventory.uniqueItems') }}
                  </div>
                  <p class="text-white font-medium">{{ details.uniqueItemsUsed?.length || 0 }}</p>
                </div>
              </div>

              <div v-else class="flex flex-col items-center justify-center py-12 text-center">
                <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p class="text-gray-400">{{ t('avatarInventory.noInfoData') }}</p>
              </div>
            </div>
          </div>

          <!-- Tab Content: Chat -->
          <div v-else-if="activeTab === 'chat'" class="space-y-4">
            <div class="bg-gradient-to-b from-slate-800/60 to-slate-900/60 rounded-xl border border-slate-600/30 p-4">
              <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">{{ t('avatarInventory.chatHistory') }}</h3>

              <!-- Loading -->
              <div v-if="chatLoading" class="flex items-center justify-center py-12">
                <svg class="w-6 h-6 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
              </div>

              <!-- No messages -->
              <div v-else-if="chatMessages.length === 0" class="flex flex-col items-center justify-center py-12 text-center">
                <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p class="text-gray-400">{{ t('avatarInventory.noChat') }}</p>
              </div>

              <!-- Chat messages -->
              <div v-else class="space-y-2 max-h-[500px] overflow-y-auto">
                <div class="text-xs text-gray-500 mb-3">
                  {{ chatTotal }} {{ t('avatarInventory.messages') }}
                </div>
                <div
                  v-for="msg in chatMessages"
                  :key="msg.id"
                  class="p-3 bg-slate-800/50 rounded-lg"
                >
                  <div class="flex items-center gap-2 mb-1">
                    <span :class="['font-semibold text-sm', getPlayerColor(msg.player)]">
                      {{ msg.player }}
                    </span>
                    <span class="text-xs text-gray-500">{{ formatChatTime(msg.timestamp) }}</span>
                  </div>
                  <p class="text-gray-300 text-sm break-words">{{ msg.message }}</p>
                </div>
              </div>
            </div>
          </div>

          <!-- Tab Content: Deaths -->
          <div v-else-if="activeTab === 'deaths'" class="space-y-4">
            <div class="bg-gradient-to-b from-slate-800/60 to-slate-900/60 rounded-xl border border-slate-600/30 p-4">
              <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">{{ t('avatarInventory.deathLocations') }}</h3>

              <!-- Loading -->
              <div v-if="deathsLoading" class="flex items-center justify-center py-12">
                <svg class="w-6 h-6 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
              </div>

              <!-- No deaths -->
              <div v-else-if="deathPositions.length === 0" class="flex flex-col items-center justify-center py-12 text-center">
                <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                </svg>
                <p class="text-gray-400">{{ t('avatarInventory.noDeaths') }}</p>
              </div>

              <!-- Death positions list -->
              <div v-else class="space-y-3 max-h-[500px] overflow-y-auto">
                <div class="text-xs text-gray-500 mb-3">
                  {{ deathPositions.length }} {{ t('avatarInventory.deathCount') }}
                </div>

                <div
                  v-for="(death, index) in [...deathPositions].reverse()"
                  :key="death.id"
                  class="p-4 bg-slate-800/50 rounded-lg border border-slate-700/50 hover:border-red-500/30 transition-colors"
                >
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                      <div class="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center">
                        <svg class="w-5 h-5 text-red-400" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 2C6.48 2 2 6.48 2 12c0 3.69 2.47 6.86 6 8.1V22h8v-1.9c3.53-1.24 6-4.41 6-8.1 0-5.52-4.48-10-10-10z"/>
                        </svg>
                      </div>
                      <div>
                        <div class="flex items-center gap-2">
                          <span class="text-white font-semibold">
                            {{ t('avatarInventory.day') }} {{ death.day }}
                          </span>
                          <span v-if="index === 0" class="text-xs px-2 py-0.5 bg-red-500/30 text-red-300 rounded-full">
                            {{ t('avatarInventory.latest') }}
                          </span>
                        </div>
                        <div class="text-sm text-gray-400 font-mono mt-1">
                          {{ death.world }}: {{ death.position.x.toFixed(1) }}, {{ death.position.y.toFixed(1) }}, {{ death.position.z.toFixed(1) }}
                        </div>
                      </div>
                    </div>

                    <Button
                      variant="secondary"
                      size="sm"
                      :disabled="teleportingDeath"
                      @click="teleportToDeath(deathPositions.length - 1 - index)"
                      class="flex items-center gap-2"
                    >
                      <svg v-if="teleportingDeath" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                      </svg>
                      <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      </svg>
                      {{ t('avatarInventory.teleport') }}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Item Tooltip -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="hoveredItem"
          class="fixed z-[100] bg-slate-900/95 border-2 rounded-lg shadow-2xl p-3 pointer-events-none min-w-[200px] max-w-xs"
          :class="getItemRarityBorder(hoveredItem.itemId)"
          :style="{
            left: `${Math.min(tooltipPosition.x + 15, windowWidth - 280)}px`,
            top: `${Math.min(tooltipPosition.y + 15, windowHeight - 200)}px`
          }"
        >
          <div :class="['font-bold text-base mb-1', getItemColorClass(hoveredItem.itemId).split(' ')[0]]">
            {{ hoveredItem.displayName }}
          </div>
          <div class="text-[10px] text-gray-500 font-mono mb-2 truncate">{{ hoveredItem.itemId }}</div>

          <div class="space-y-1.5 text-sm border-t border-slate-700 pt-2">
            <div class="flex justify-between">
              <span class="text-gray-400">{{ t('players.tooltip.amount') }}:</span>
              <span class="text-white font-medium">{{ hoveredItem.amount }}x</span>
            </div>

            <div v-if="hoveredItem.maxDurability > 0">
              <div class="flex justify-between mb-1">
                <span class="text-gray-400">{{ t('players.tooltip.durability') }}:</span>
                <span :class="getDurabilityPercent(hoveredItem) > 30 ? 'text-white' : 'text-red-400'" class="font-medium">
                  {{ Math.round(hoveredItem.durability) }} / {{ Math.round(hoveredItem.maxDurability) }}
                </span>
              </div>
              <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div :class="['h-full', getDurabilityColor(hoveredItem)]" :style="{ width: `${getDurabilityPercent(hoveredItem)}%` }"></div>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.inventory-slot {
  min-width: 2.75rem;
  min-height: 2.75rem;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
