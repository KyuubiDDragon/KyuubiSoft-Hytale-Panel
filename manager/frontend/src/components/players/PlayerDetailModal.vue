<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { serverApi, type FilePlayerDetails, type FilePlayerInventory, type FileInventoryItem } from '@/api/server'
import { assetsApi } from '@/api/assets'
import Button from '@/components/ui/Button.vue'

const props = defineProps<{
  open: boolean
  playerName: string
  playerUuid?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

// Tab state
const activeTab = ref<'info' | 'inventory' | 'stats'>('info')

// Data states
const loading = ref(false)
const error = ref('')
const details = ref<FilePlayerDetails | null>(null)
const inventory = ref<FilePlayerInventory | null>(null)

// Tooltip state
const hoveredItem = ref<FileInventoryItem | null>(null)
const tooltipPosition = ref({ x: 0, y: 0 })

// Track which icons failed to load
const failedIcons = ref<Set<string>>(new Set())

// Assets status
const assetsExtracted = ref(true)

// Fetch data when modal opens
watch(() => props.open, async (isOpen) => {
  if (isOpen && props.playerName) {
    await fetchAllData()
  } else {
    // Reset state when closed
    activeTab.value = 'info'
    details.value = null
    inventory.value = null
    error.value = ''
    hoveredItem.value = null
    failedIcons.value = new Set()
    assetsExtracted.value = true
  }
})

// Show hint about assets when icons fail to load and assets are not extracted
const showAssetsHint = computed(() => {
  return !assetsExtracted.value && failedIcons.value.size > 0
})

async function fetchAllData() {
  loading.value = true
  error.value = ''

  try {
    // Fetch file-based data and asset status in parallel
    const [detailsRes, inventoryRes, assetStatus] = await Promise.all([
      serverApi.getFilePlayerDetails(props.playerName).catch(() => null),
      serverApi.getFilePlayerInventory(props.playerName).catch(() => null),
      assetsApi.getStatus().catch(() => null)
    ])

    // Check if assets are extracted
    assetsExtracted.value = assetStatus?.extracted ?? false

    if (detailsRes?.success && detailsRes.data) {
      details.value = detailsRes.data
    }
    if (inventoryRes?.success && inventoryRes.data) {
      inventory.value = inventoryRes.data
    }

    if (!details.value && !inventory.value) {
      error.value = t('players.details.noSavedData')
    }
  } catch (err) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

// Get player initial for avatar
const playerInitial = computed(() => {
  return props.playerName?.[0]?.toUpperCase() || '?'
})

// Health percentage and color
const healthPercent = computed(() => {
  if (!details.value?.stats) return 0
  return Math.min(100, (details.value.stats.health / details.value.stats.maxHealth) * 100)
})

const healthColor = computed(() => {
  const p = healthPercent.value
  if (p > 75) return 'bg-green-500'
  if (p > 40) return 'bg-yellow-500'
  return 'bg-red-500'
})

// Stamina percentage
const staminaPercent = computed(() => {
  if (!details.value?.stats) return 0
  return Math.min(100, (details.value.stats.stamina / details.value.stats.maxStamina) * 100)
})

// Format durability percentage
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

// Get item icon URL
function getItemIconUrl(itemId: string): string {
  return assetsApi.getItemIconUrl(itemId)
}

// Handle icon load error - mark as failed
function onIconError(itemId: string) {
  failedIcons.value.add(itemId)
}

// Check if icon failed
function iconFailed(itemId: string): boolean {
  return failedIcons.value.has(itemId)
}

// Get fallback icon letter based on item type
function getFallbackLetter(itemId: string): string {
  const id = itemId.toLowerCase()
  if (id.includes('sword')) return 'S'
  if (id.includes('axe') || id.includes('hatchet')) return 'A'
  if (id.includes('pickaxe')) return 'P'
  if (id.includes('bow')) return 'B'
  if (id.includes('arrow')) return '>'
  if (id.includes('armor') || id.includes('chest')) return 'C'
  if (id.includes('head') || id.includes('helmet')) return 'H'
  if (id.includes('legs')) return 'L'
  if (id.includes('hands') || id.includes('gloves')) return 'G'
  if (id.includes('shield')) return 'D'
  if (id.includes('food') || id.includes('meat') || id.includes('kebab')) return 'F'
  if (id.includes('potion')) return '!'
  if (id.includes('torch')) return 'T'
  if (id.includes('tool') || id.includes('repair')) return 'R'
  if (id.includes('teleporter')) return '*'
  if (id.includes('ingredient') || id.includes('hide') || id.includes('chitin')) return 'I'
  if (id.includes('plant') || id.includes('flower') || id.includes('cactus')) return 'P'
  if (id.includes('rock') || id.includes('soil') || id.includes('cobble')) return '#'
  if (id.includes('mace')) return 'M'
  if (id.includes('battleaxe')) return 'X'
  return '?'
}

// Get item color class based on material/type
function getItemColorClass(itemId: string): string {
  const id = itemId.toLowerCase()
  if (id.includes('adamantite')) return 'text-purple-400 bg-purple-500/20'
  if (id.includes('thorium')) return 'text-green-400 bg-green-500/20'
  if (id.includes('cobalt')) return 'text-blue-400 bg-blue-500/20'
  if (id.includes('iron')) return 'text-gray-300 bg-gray-500/20'
  if (id.includes('gold')) return 'text-yellow-400 bg-yellow-500/20'
  if (id.includes('potion')) return 'text-pink-400 bg-pink-500/20'
  if (id.includes('food') || id.includes('meat')) return 'text-orange-400 bg-orange-500/20'
  return 'text-gray-300 bg-gray-600/30'
}

// Get item rarity color for tooltip border
function getItemRarityClass(itemId: string): string {
  const id = itemId.toLowerCase()
  if (id.includes('adamantite')) return 'border-purple-500'
  if (id.includes('thorium')) return 'border-green-500'
  if (id.includes('cobalt')) return 'border-blue-500'
  if (id.includes('iron')) return 'border-gray-400'
  if (id.includes('gold')) return 'border-yellow-500'
  return 'border-dark-50'
}

// Get item category/type description
function getItemCategory(itemId: string): string {
  const id = itemId.toLowerCase()
  if (id.includes('sword')) return t('players.itemTypes.sword')
  if (id.includes('axe') && !id.includes('battle')) return t('players.itemTypes.axe')
  if (id.includes('battleaxe')) return t('players.itemTypes.battleaxe')
  if (id.includes('mace')) return t('players.itemTypes.mace')
  if (id.includes('pickaxe')) return t('players.itemTypes.pickaxe')
  if (id.includes('bow')) return t('players.itemTypes.bow')
  if (id.includes('arrow')) return t('players.itemTypes.arrow')
  if (id.includes('shield')) return t('players.itemTypes.shield')
  if (id.includes('helmet') || id.includes('_head')) return t('players.itemTypes.helmet')
  if (id.includes('chestplate') || id.includes('_chest')) return t('players.itemTypes.chestplate')
  if (id.includes('leggings') || id.includes('_legs')) return t('players.itemTypes.leggings')
  if (id.includes('gloves') || id.includes('_hands')) return t('players.itemTypes.gloves')
  if (id.includes('potion')) return t('players.itemTypes.potion')
  if (id.includes('food') || id.includes('meat') || id.includes('kebab')) return t('players.itemTypes.food')
  if (id.includes('torch')) return t('players.itemTypes.torch')
  if (id.includes('teleporter')) return t('players.itemTypes.teleporter')
  if (id.includes('ingredient') || id.includes('hide') || id.includes('chitin')) return t('players.itemTypes.material')
  if (id.includes('repair')) return t('players.itemTypes.tool')
  if (id.includes('rock') || id.includes('soil') || id.includes('cobble')) return t('players.itemTypes.block')
  if (id.includes('plant') || id.includes('flower') || id.includes('cactus')) return t('players.itemTypes.plant')
  return t('players.itemTypes.item')
}

// Get material name for item
function getItemMaterial(itemId: string): string | null {
  const id = itemId.toLowerCase()
  if (id.includes('adamantite')) return 'Adamantite'
  if (id.includes('thorium')) return 'Thorium'
  if (id.includes('cobalt')) return 'Cobalt'
  if (id.includes('iron')) return 'Iron'
  if (id.includes('gold')) return 'Gold'
  if (id.includes('wood') || id.includes('wooden')) return 'Wood'
  if (id.includes('stone')) return 'Stone'
  return null
}

// Show tooltip
function showTooltip(item: FileInventoryItem, event: MouseEvent) {
  hoveredItem.value = item
  tooltipPosition.value = {
    x: event.clientX,
    y: event.clientY
  }
}

// Hide tooltip
function hideTooltip() {
  hoveredItem.value = null
}

// Generate grid for a container with specified capacity
function generateGrid(items: FileInventoryItem[], capacity: number): (FileInventoryItem | null)[] {
  const grid: (FileInventoryItem | null)[] = Array(capacity).fill(null)
  for (const item of items) {
    if (item.slot >= 0 && item.slot < capacity) {
      grid[item.slot] = item
    }
  }
  return grid
}

// Computed inventory grids - use actual capacity from inventory data
const hotbarGrid = computed(() => inventory.value ? generateGrid(inventory.value.hotbar, 9) : [])
const armorGrid = computed(() => inventory.value ? generateGrid(inventory.value.armor, 4) : [])
const utilityGrid = computed(() => inventory.value ? generateGrid(inventory.value.utility, 4) : [])
const storageGrid = computed(() => inventory.value ? generateGrid(inventory.value.storage, 36) : [])

// Backpack capacity from inventory - dynamically based on upgrades
const backpackCapacity = computed(() => {
  // Default backpack capacities: 0 -> 6 (upgrade 1) -> 12 (upgrade 2) -> 18 (upgrade 3)
  // Check uniqueItemsUsed to determine upgrades
  if (!inventory.value) return 0

  // Return actual number of items or minimum based on upgrades found
  const upgradesUsed = details.value?.uniqueItemsUsed || []
  let capacity = 0
  if (upgradesUsed.includes('Upgrade_Backpack_1')) capacity = 6
  if (upgradesUsed.includes('Upgrade_Backpack_2')) capacity = 12
  if (upgradesUsed.includes('Upgrade_Backpack_3')) capacity = 18

  // Use the larger of calculated capacity or actual items
  return Math.max(capacity, inventory.value.backpack.length)
})

const backpackGrid = computed(() => {
  if (!inventory.value || backpackCapacity.value === 0) return []
  return generateGrid(inventory.value.backpack, backpackCapacity.value)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-black/70 backdrop-blur-sm"
          @click="emit('close')"
        />

        <!-- Modal -->
        <div class="relative bg-dark-200 rounded-xl border border-dark-50 shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden">
          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-dark-50">
            <div class="flex items-center gap-4">
              <!-- Player Avatar -->
              <div class="w-12 h-12 bg-hytale-orange/20 rounded-lg flex items-center justify-center flex-shrink-0">
                <span class="text-hytale-orange font-bold text-xl">{{ playerInitial }}</span>
              </div>
              <div>
                <h3 class="text-lg font-semibold text-white">{{ playerName }}</h3>
                <p v-if="details?.uuid" class="text-xs text-gray-500 font-mono truncate max-w-[200px]">
                  {{ details.uuid }}
                </p>
              </div>
            </div>
            <button
              @click="emit('close')"
              class="text-gray-400 hover:text-white transition-colors"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Tabs -->
          <div class="flex gap-1 px-6 pt-4">
            <button
              @click="activeTab = 'info'"
              :class="[
                'px-4 py-2 rounded-t-lg font-medium text-sm transition-colors',
                activeTab === 'info'
                  ? 'bg-dark-100 text-white'
                  : 'text-gray-400 hover:text-white'
              ]"
            >
              {{ t('players.details.info') }}
            </button>
            <button
              @click="activeTab = 'inventory'"
              :class="[
                'px-4 py-2 rounded-t-lg font-medium text-sm transition-colors',
                activeTab === 'inventory'
                  ? 'bg-dark-100 text-white'
                  : 'text-gray-400 hover:text-white'
              ]"
            >
              {{ t('players.details.inventory') }}
            </button>
            <button
              @click="activeTab = 'stats'"
              :class="[
                'px-4 py-2 rounded-t-lg font-medium text-sm transition-colors',
                activeTab === 'stats'
                  ? 'bg-dark-100 text-white'
                  : 'text-gray-400 hover:text-white'
              ]"
            >
              {{ t('players.details.stats') }}
            </button>
          </div>

          <!-- Content -->
          <div class="bg-dark-100 p-6 min-h-[300px] max-h-[60vh] overflow-y-auto">
            <!-- Loading -->
            <div v-if="loading" class="flex items-center justify-center h-48">
              <div class="flex items-center gap-3 text-gray-400">
                <svg class="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {{ t('common.loading') }}
              </div>
            </div>

            <!-- Error -->
            <div v-else-if="error" class="flex flex-col items-center justify-center h-48 text-center">
              <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p class="text-gray-400">{{ error }}</p>
            </div>

            <!-- Info Tab -->
            <div v-else-if="activeTab === 'info'">
              <div v-if="details" class="grid grid-cols-2 gap-4">
                <!-- World -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {{ t('players.details.world') }}
                  </div>
                  <p class="text-white font-medium">{{ details.world || 'Unknown' }}</p>
                </div>

                <!-- Gamemode -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {{ t('players.details.gamemode') }}
                  </div>
                  <p class="text-white font-medium capitalize">{{ details.gameMode || 'Unknown' }}</p>
                </div>

                <!-- Position -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {{ t('players.details.position') }}
                  </div>
                  <p class="text-white font-medium font-mono text-sm">
                    <span v-if="details.position">
                      {{ details.position.x }}, {{ details.position.y }}, {{ details.position.z }}
                    </span>
                    <span v-else class="text-gray-500">-</span>
                  </p>
                </div>

                <!-- Discovered Zones -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                    </svg>
                    {{ t('players.details.discoveredZones') }}
                  </div>
                  <p class="text-white font-medium">{{ details.discoveredZones?.length || 0 }}</p>
                </div>

                <!-- Memories -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                    {{ t('players.details.memories') }}
                  </div>
                  <p class="text-white font-medium">{{ details.memoriesCount || 0 }} NPCs</p>
                </div>

                <!-- Unique Items Used -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
                    </svg>
                    {{ t('players.details.uniqueItems') }}
                  </div>
                  <p class="text-white font-medium">{{ details.uniqueItemsUsed?.length || 0 }}</p>
                </div>
              </div>

              <div v-else class="flex flex-col items-center justify-center h-48 text-center">
                <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p class="text-gray-400">{{ t('players.details.noData') }}</p>
              </div>
            </div>

            <!-- Inventory Tab -->
            <div v-else-if="activeTab === 'inventory'">
              <div v-if="inventory" class="space-y-6">
                <!-- Assets hint when icons fail to load -->
                <div v-if="showAssetsHint" class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                  <div class="flex items-center gap-2 text-amber-400 text-sm">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>{{ t('players.details.assetsHint') }}</span>
                    <router-link to="/assets" class="ml-auto text-amber-300 hover:text-amber-200 underline">
                      {{ t('players.details.goToAssets') }}
                    </router-link>
                  </div>
                </div>

                <!-- Hotbar -->
                <div>
                  <h4 class="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                    <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" />
                    </svg>
                    Hotbar
                    <span class="text-xs text-gray-500">({{ inventory.hotbar.length }}/9)</span>
                  </h4>
                  <div class="grid grid-cols-9 gap-1">
                    <div
                      v-for="(item, index) in hotbarGrid"
                      :key="`hotbar-${index}`"
                      :class="[
                        'aspect-square rounded border flex flex-col items-center justify-center relative group cursor-pointer',
                        item ? 'bg-dark-200 border-hytale-orange/30 hover:border-hytale-orange' : 'bg-dark-300/50 border-dark-100',
                        index === inventory.activeHotbarSlot ? 'ring-2 ring-hytale-orange' : ''
                      ]"
                      @mouseenter="item && showTooltip(item, $event)"
                      @mouseleave="hideTooltip"
                    >
                      <template v-if="item">
                        <!-- Try to load actual icon -->
                        <img
                          v-if="!iconFailed(item.itemId)"
                          :src="getItemIconUrl(item.itemId)"
                          :alt="item.displayName"
                          class="w-8 h-8 object-contain"
                          @error="onIconError(item.itemId)"
                        />
                        <!-- Fallback icon -->
                        <div v-else :class="['w-8 h-8 rounded flex items-center justify-center text-sm font-bold', getItemColorClass(item.itemId)]">
                          {{ getFallbackLetter(item.itemId) }}
                        </div>
                        <span class="absolute bottom-0.5 right-1 text-[10px] font-bold text-white drop-shadow-lg bg-black/50 px-0.5 rounded">
                          {{ item.amount }}
                        </span>
                        <!-- Durability bar -->
                        <div v-if="item.maxDurability > 0" class="absolute bottom-0 left-0 right-0 h-1 bg-dark-300 rounded-b overflow-hidden">
                          <div :class="['h-full transition-all', getDurabilityColor(item)]" :style="{ width: `${getDurabilityPercent(item)}%` }"></div>
                        </div>
                      </template>
                    </div>
                  </div>
                </div>

                <!-- Armor + Utility Row -->
                <div class="grid grid-cols-2 gap-4">
                  <!-- Armor -->
                  <div>
                    <h4 class="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                      <svg class="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                      {{ t('players.details.armor') }}
                    </h4>
                    <div class="grid grid-cols-4 gap-1">
                      <div
                        v-for="(item, index) in armorGrid"
                        :key="`armor-${index}`"
                        :class="[
                          'aspect-square rounded border flex flex-col items-center justify-center relative cursor-pointer',
                          item ? 'bg-dark-200 border-blue-500/30 hover:border-blue-500' : 'bg-dark-300/50 border-dark-100'
                        ]"
                        @mouseenter="item && showTooltip(item, $event)"
                        @mouseleave="hideTooltip"
                      >
                        <template v-if="item">
                          <img
                            v-if="!iconFailed(item.itemId)"
                            :src="getItemIconUrl(item.itemId)"
                            :alt="item.displayName"
                            class="w-7 h-7 object-contain"
                            @error="onIconError(item.itemId)"
                          />
                          <div v-else :class="['w-7 h-7 rounded flex items-center justify-center text-xs font-bold', getItemColorClass(item.itemId)]">
                            {{ ['H', 'C', 'G', 'L'][index] }}
                          </div>
                          <!-- Durability bar -->
                          <div v-if="item.maxDurability > 0" class="absolute bottom-0 left-0 right-0 h-1 bg-dark-300 rounded-b overflow-hidden">
                            <div :class="['h-full', getDurabilityColor(item)]" :style="{ width: `${getDurabilityPercent(item)}%` }"></div>
                          </div>
                        </template>
                        <span v-else class="text-[10px] text-gray-600">{{ ['H', 'C', 'G', 'L'][index] }}</span>
                      </div>
                    </div>
                  </div>

                  <!-- Utility -->
                  <div>
                    <h4 class="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                      <svg class="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      {{ t('players.details.utility') }}
                    </h4>
                    <div class="grid grid-cols-4 gap-1">
                      <div
                        v-for="(item, index) in utilityGrid"
                        :key="`utility-${index}`"
                        :class="[
                          'aspect-square rounded border flex items-center justify-center relative cursor-pointer',
                          item ? 'bg-dark-200 border-purple-500/30 hover:border-purple-500' : 'bg-dark-300/50 border-dark-100'
                        ]"
                        @mouseenter="item && showTooltip(item, $event)"
                        @mouseleave="hideTooltip"
                      >
                        <template v-if="item">
                          <img
                            v-if="!iconFailed(item.itemId)"
                            :src="getItemIconUrl(item.itemId)"
                            :alt="item.displayName"
                            class="w-7 h-7 object-contain"
                            @error="onIconError(item.itemId)"
                          />
                          <div v-else :class="['w-7 h-7 rounded flex items-center justify-center text-xs font-bold', getItemColorClass(item.itemId)]">
                            U
                          </div>
                          <span v-if="item.amount > 1" class="absolute bottom-0.5 right-0.5 text-[9px] font-bold text-white drop-shadow-lg">
                            {{ item.amount }}
                          </span>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Storage -->
                <div>
                  <h4 class="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                    <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                    Storage
                    <span class="text-xs text-gray-500">({{ inventory.storage.length }}/36)</span>
                  </h4>
                  <div class="grid grid-cols-9 gap-1">
                    <div
                      v-for="(item, index) in storageGrid"
                      :key="`storage-${index}`"
                      :class="[
                        'aspect-square rounded border flex items-center justify-center relative cursor-pointer',
                        item ? 'bg-dark-200 border-dark-50 hover:border-gray-500' : 'bg-dark-300/50 border-dark-100'
                      ]"
                      @mouseenter="item && showTooltip(item, $event)"
                      @mouseleave="hideTooltip"
                    >
                      <template v-if="item">
                        <img
                          v-if="!iconFailed(item.itemId)"
                          :src="getItemIconUrl(item.itemId)"
                          :alt="item.displayName"
                          class="w-7 h-7 object-contain"
                          @error="onIconError(item.itemId)"
                        />
                        <div v-else :class="['w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold', getItemColorClass(item.itemId)]">
                          {{ getFallbackLetter(item.itemId) }}
                        </div>
                        <span class="absolute bottom-0.5 right-0.5 text-[9px] font-bold text-white drop-shadow-lg bg-black/50 px-0.5 rounded">
                          {{ item.amount }}
                        </span>
                      </template>
                    </div>
                  </div>
                </div>

                <!-- Backpack (only show if player has upgrades) -->
                <div v-if="backpackCapacity > 0">
                  <h4 class="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                    <svg class="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                    </svg>
                    Backpack
                    <span class="text-xs text-gray-500">({{ inventory.backpack.length }}/{{ backpackCapacity }})</span>
                  </h4>
                  <div class="grid grid-cols-6 gap-1">
                    <div
                      v-for="(item, index) in backpackGrid"
                      :key="`backpack-${index}`"
                      :class="[
                        'aspect-square rounded border flex items-center justify-center relative cursor-pointer',
                        item ? 'bg-dark-200 border-amber-500/30 hover:border-amber-500' : 'bg-dark-300/50 border-dark-100'
                      ]"
                      @mouseenter="item && showTooltip(item, $event)"
                      @mouseleave="hideTooltip"
                    >
                      <template v-if="item">
                        <img
                          v-if="!iconFailed(item.itemId)"
                          :src="getItemIconUrl(item.itemId)"
                          :alt="item.displayName"
                          class="w-7 h-7 object-contain"
                          @error="onIconError(item.itemId)"
                        />
                        <div v-else :class="['w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold', getItemColorClass(item.itemId)]">
                          {{ getFallbackLetter(item.itemId) }}
                        </div>
                        <span class="absolute bottom-0.5 right-0.5 text-[9px] font-bold text-white drop-shadow-lg bg-black/50 px-0.5 rounded">
                          {{ item.amount }}
                        </span>
                      </template>
                    </div>
                  </div>
                </div>
              </div>

              <div v-else class="flex flex-col items-center justify-center h-48 text-center">
                <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                <p class="text-gray-400">{{ t('players.details.inventoryUnavailable') }}</p>
              </div>
            </div>

            <!-- Stats Tab -->
            <div v-else-if="activeTab === 'stats'">
              <div v-if="details?.stats" class="space-y-6">
                <!-- Health Bar -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2 text-gray-300">
                      <svg class="w-5 h-5 text-red-400" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                      </svg>
                      {{ t('players.details.health') }}
                    </div>
                    <span class="text-white font-mono">
                      {{ details.stats.health.toFixed(1) }} / {{ details.stats.maxHealth.toFixed(1) }}
                    </span>
                  </div>
                  <div class="h-4 bg-dark-300 rounded-full overflow-hidden">
                    <div :class="['h-full transition-all duration-300', healthColor]" :style="{ width: `${healthPercent}%` }"></div>
                  </div>
                </div>

                <!-- Stamina Bar -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2 text-gray-300">
                      <svg class="w-5 h-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      {{ t('players.details.stamina') }}
                    </div>
                    <span class="text-white font-mono">
                      {{ details.stats.stamina.toFixed(1) }} / {{ details.stats.maxStamina.toFixed(1) }}
                    </span>
                  </div>
                  <div class="h-4 bg-dark-300 rounded-full overflow-hidden">
                    <div class="h-full bg-yellow-500 transition-all duration-300" :style="{ width: `${staminaPercent}%` }"></div>
                  </div>
                </div>

                <!-- Other Stats Grid -->
                <div class="grid grid-cols-3 gap-4">
                  <!-- Oxygen -->
                  <div class="bg-dark-200 rounded-lg p-4 text-center">
                    <svg class="w-6 h-6 text-cyan-400 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                    </svg>
                    <div class="text-gray-400 text-xs mb-1">{{ t('players.details.oxygen') }}</div>
                    <div class="text-white font-bold">{{ details.stats.oxygen.toFixed(0) }}%</div>
                  </div>

                  <!-- Mana -->
                  <div class="bg-dark-200 rounded-lg p-4 text-center">
                    <svg class="w-6 h-6 text-blue-400 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    <div class="text-gray-400 text-xs mb-1">{{ t('players.details.mana') }}</div>
                    <div class="text-white font-bold">{{ details.stats.mana.toFixed(0) }}</div>
                  </div>

                  <!-- Immunity -->
                  <div class="bg-dark-200 rounded-lg p-4 text-center">
                    <svg class="w-6 h-6 text-green-400 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <div class="text-gray-400 text-xs mb-1">{{ t('players.details.immunity') }}</div>
                    <div class="text-white font-bold">{{ details.stats.immunity.toFixed(0) }}</div>
                  </div>
                </div>
              </div>

              <div v-else class="flex flex-col items-center justify-center h-48 text-center">
                <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <p class="text-gray-400">{{ t('players.details.noStats') }}</p>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 border-t border-dark-50 flex justify-end">
            <Button variant="secondary" @click="emit('close')">{{ t('common.close') }}</Button>
          </div>
        </div>

        <!-- Item Tooltip -->
        <Transition name="fade">
          <div
            v-if="hoveredItem"
            :class="['fixed z-[60] bg-dark-100 border-2 rounded-lg shadow-xl p-3 pointer-events-none min-w-[200px] max-w-xs', getItemRarityClass(hoveredItem.itemId)]"
            :style="{
              left: `${Math.min(tooltipPosition.x + 10, window.innerWidth - 280)}px`,
              top: `${Math.min(tooltipPosition.y + 10, window.innerHeight - 200)}px`
            }"
          >
            <!-- Item Name with rarity color -->
            <div :class="['font-bold text-base mb-0.5', getItemColorClass(hoveredItem.itemId).split(' ')[0]]">
              {{ hoveredItem.displayName }}
            </div>
            <!-- Item Type / Category -->
            <div class="text-xs text-gray-400 mb-2">
              {{ getItemCategory(hoveredItem.itemId) }}
              <span v-if="getItemMaterial(hoveredItem.itemId)" class="text-gray-500">
                · {{ getItemMaterial(hoveredItem.itemId) }}
              </span>
            </div>

            <!-- Item ID (smaller, for reference) -->
            <div class="text-[10px] text-gray-500 font-mono mb-2 truncate">{{ hoveredItem.itemId }}</div>

            <!-- Stats -->
            <div class="space-y-1.5 text-sm border-t border-dark-50 pt-2">
              <!-- Amount -->
              <div class="flex justify-between">
                <span class="text-gray-400">{{ t('players.tooltip.amount') }}:</span>
                <span class="text-white font-medium">{{ hoveredItem.amount }}x</span>
              </div>

              <!-- Durability -->
              <div v-if="hoveredItem.maxDurability > 0">
                <div class="flex justify-between mb-1">
                  <span class="text-gray-400">{{ t('players.tooltip.durability') }}:</span>
                  <span :class="getDurabilityPercent(hoveredItem) > 30 ? 'text-white' : 'text-red-400'" class="font-medium">
                    {{ Math.round(hoveredItem.durability) }} / {{ Math.round(hoveredItem.maxDurability) }}
                  </span>
                </div>
                <div class="h-2 bg-dark-300 rounded-full overflow-hidden">
                  <div :class="['h-full transition-all', getDurabilityColor(hoveredItem)]" :style="{ width: `${getDurabilityPercent(hoveredItem)}%` }"></div>
                </div>
              </div>

              <!-- Slot info -->
              <div class="flex justify-between text-xs text-gray-500">
                <span>Slot:</span>
                <span>{{ hoveredItem.slot }}</span>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .relative,
.modal-leave-active .relative {
  transition: transform 0.2s ease;
}

.modal-enter-from .relative,
.modal-leave-to .relative {
  transform: scale(0.95);
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
