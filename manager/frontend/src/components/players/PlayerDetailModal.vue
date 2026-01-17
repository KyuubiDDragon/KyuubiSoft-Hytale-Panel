<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { serverApi, type PluginPlayerDetails, type PluginPlayerInventory, type PluginPlayerAppearance } from '@/api/server'
import Modal from '@/components/ui/Modal.vue'
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
const activeTab = ref<'info' | 'inventory' | 'appearance'>('info')

// Data states
const loading = ref(false)
const error = ref('')
const details = ref<PluginPlayerDetails | null>(null)
const inventory = ref<PluginPlayerInventory | null>(null)
const appearance = ref<PluginPlayerAppearance | null>(null)

// Fetch data when modal opens
watch(() => props.open, async (isOpen) => {
  if (isOpen && props.playerName) {
    await fetchAllData()
  } else {
    // Reset state when closed
    activeTab.value = 'info'
    details.value = null
    inventory.value = null
    appearance.value = null
    error.value = ''
  }
})

async function fetchAllData() {
  loading.value = true
  error.value = ''

  try {
    // Fetch all data in parallel
    const [detailsRes, inventoryRes, appearanceRes] = await Promise.all([
      serverApi.getPluginPlayerDetails(props.playerName).catch(() => null),
      serverApi.getPluginPlayerInventory(props.playerName).catch(() => null),
      serverApi.getPluginPlayerAppearance(props.playerName).catch(() => null)
    ])

    if (detailsRes?.success && detailsRes.data) {
      details.value = detailsRes.data
    }
    if (inventoryRes?.success && inventoryRes.data) {
      inventory.value = inventoryRes.data
    }
    if (appearanceRes?.success && appearanceRes.data) {
      appearance.value = appearanceRes.data
    }

    if (!details.value && !inventory.value && !appearance.value) {
      error.value = t('players.pluginRequired')
    }
  } catch (err) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

// Format health as hearts
function formatHealth(health: number, maxHealth: number): string {
  const hearts = Math.ceil(health / 2)
  const maxHearts = Math.ceil(maxHealth / 2)
  return `${hearts}/${maxHearts}`
}

// Health color based on percentage
const healthColor = computed(() => {
  if (!details.value?.health || !details.value?.maxHealth) return 'text-gray-400'
  const percentage = (details.value.health / details.value.maxHealth) * 100
  if (percentage > 75) return 'text-green-400'
  if (percentage > 40) return 'text-yellow-400'
  return 'text-red-400'
})

// Get player initial for avatar
const playerInitial = computed(() => {
  return props.playerName?.[0]?.toUpperCase() || '?'
})

// Generate inventory grid (36 slots like Minecraft)
const inventoryGrid = computed(() => {
  const grid = Array(36).fill(null)
  if (inventory.value?.items) {
    for (const item of inventory.value.items) {
      if (item.slot >= 0 && item.slot < 36) {
        grid[item.slot] = item
      }
    }
  }
  return grid
})

// Format item name from ID (e.g., "hytale:diamond_sword" -> "Diamond Sword")
function formatItemName(itemId: string): string {
  const name = itemId.split(':').pop() || itemId
  return name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}
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
        <div class="relative bg-dark-200 rounded-xl border border-dark-50 shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
          <!-- Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-dark-50">
            <div class="flex items-center gap-4">
              <!-- Player Avatar -->
              <div class="w-12 h-12 bg-hytale-orange/20 rounded-lg flex items-center justify-center flex-shrink-0">
                <span class="text-hytale-orange font-bold text-xl">{{ playerInitial }}</span>
              </div>
              <div>
                <h3 class="text-lg font-semibold text-white">{{ playerName }}</h3>
                <p v-if="playerUuid || details?.uuid" class="text-xs text-gray-500 font-mono">
                  {{ playerUuid || details?.uuid }}
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
              @click="activeTab = 'appearance'"
              :class="[
                'px-4 py-2 rounded-t-lg font-medium text-sm transition-colors',
                activeTab === 'appearance'
                  ? 'bg-dark-100 text-white'
                  : 'text-gray-400 hover:text-white'
              ]"
            >
              {{ t('players.details.appearance') }}
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
              <p class="text-gray-500 text-sm mt-2">{{ t('players.pluginHint') }}</p>
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
                  <p class="text-white font-medium capitalize">{{ details.gamemode || 'Unknown' }}</p>
                </div>

                <!-- Health -->
                <div class="bg-dark-200 rounded-lg p-4">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                    </svg>
                    {{ t('players.details.health') }}
                  </div>
                  <p :class="['font-medium', healthColor]">
                    {{ details.health?.toFixed(1) || '?' }} / {{ details.maxHealth?.toFixed(1) || '?' }}
                  </p>
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
                      {{ details.position.x.toFixed(1) }}, {{ details.position.y.toFixed(1) }}, {{ details.position.z.toFixed(1) }}
                    </span>
                    <span v-else class="text-gray-500">-</span>
                  </p>
                </div>

                <!-- Rotation -->
                <div class="bg-dark-200 rounded-lg p-4 col-span-2">
                  <div class="flex items-center gap-2 text-gray-400 text-sm mb-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {{ t('players.details.rotation') }}
                  </div>
                  <div class="flex gap-6">
                    <p class="text-white font-mono text-sm">
                      Yaw: <span class="text-hytale-orange">{{ details.yaw?.toFixed(1) || '0' }}</span>
                    </p>
                    <p class="text-white font-mono text-sm">
                      Pitch: <span class="text-hytale-orange">{{ details.pitch?.toFixed(1) || '0' }}</span>
                    </p>
                  </div>
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
              <div v-if="inventory" class="space-y-4">
                <!-- Inventory Stats -->
                <div class="flex items-center justify-between text-sm text-gray-400 mb-2">
                  <span>{{ t('players.details.slots') }}: {{ inventory.usedSlots }} / {{ inventory.totalSlots }}</span>
                </div>

                <!-- Inventory Grid -->
                <div class="grid grid-cols-9 gap-1">
                  <div
                    v-for="(item, index) in inventoryGrid"
                    :key="index"
                    :class="[
                      'aspect-square rounded border flex items-center justify-center relative group',
                      item ? 'bg-dark-200 border-dark-50 cursor-pointer hover:border-hytale-orange/50' : 'bg-dark-300/50 border-dark-100'
                    ]"
                    :title="item ? `${formatItemName(item.itemId)} x${item.amount}` : `Slot ${index}`"
                  >
                    <template v-if="item">
                      <!-- Item icon placeholder -->
                      <div class="w-6 h-6 bg-hytale-orange/20 rounded flex items-center justify-center">
                        <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                        </svg>
                      </div>
                      <!-- Amount badge -->
                      <span v-if="item.amount > 1" class="absolute bottom-0 right-0.5 text-[10px] font-bold text-white">
                        {{ item.amount }}
                      </span>
                    </template>
                  </div>
                </div>

                <!-- Empty inventory message -->
                <div v-if="inventory.usedSlots === 0" class="text-center text-gray-500 py-4">
                  {{ t('players.details.emptyInventory') }}
                </div>
              </div>

              <div v-else class="flex flex-col items-center justify-center h-48 text-center">
                <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                <p class="text-gray-400">{{ t('players.details.inventoryUnavailable') }}</p>
                <p class="text-gray-500 text-sm mt-1">{{ t('players.details.inventoryHint') }}</p>
              </div>
            </div>

            <!-- Appearance Tab -->
            <div v-else-if="activeTab === 'appearance'">
              <div v-if="appearance" class="space-y-4">
                <!-- Player Model Placeholder -->
                <div class="flex justify-center mb-6">
                  <div class="w-32 h-48 bg-dark-200 rounded-lg border border-dark-50 flex items-center justify-center">
                    <div class="text-center">
                      <div class="w-16 h-16 bg-hytale-orange/20 rounded-lg mx-auto flex items-center justify-center mb-2">
                        <span class="text-hytale-orange font-bold text-2xl">{{ playerInitial }}</span>
                      </div>
                      <p class="text-xs text-gray-500">{{ t('players.details.modelPreview') }}</p>
                    </div>
                  </div>
                </div>

                <!-- Appearance Info -->
                <div class="grid grid-cols-2 gap-4">
                  <div class="bg-dark-200 rounded-lg p-4">
                    <div class="text-gray-400 text-sm mb-1">{{ t('players.details.modelType') }}</div>
                    <p class="text-white font-medium capitalize">{{ appearance.modelType || 'Default' }}</p>
                  </div>

                  <div class="bg-dark-200 rounded-lg p-4">
                    <div class="text-gray-400 text-sm mb-1">{{ t('players.details.skinId') }}</div>
                    <p class="text-white font-medium font-mono text-sm">{{ appearance.skinId || '-' }}</p>
                  </div>
                </div>

                <!-- Customization -->
                <div v-if="appearance.customization" class="bg-dark-200 rounded-lg p-4">
                  <div class="text-gray-400 text-sm mb-3">{{ t('players.details.customization') }}</div>
                  <div class="grid grid-cols-2 gap-3 text-sm">
                    <div v-if="appearance.customization.hairStyle">
                      <span class="text-gray-500">{{ t('players.details.hairStyle') }}:</span>
                      <span class="text-white ml-2">{{ appearance.customization.hairStyle }}</span>
                    </div>
                    <div v-if="appearance.customization.hairColor">
                      <span class="text-gray-500">{{ t('players.details.hairColor') }}:</span>
                      <span class="text-white ml-2">{{ appearance.customization.hairColor }}</span>
                    </div>
                    <div v-if="appearance.customization.eyeColor">
                      <span class="text-gray-500">{{ t('players.details.eyeColor') }}:</span>
                      <span class="text-white ml-2">{{ appearance.customization.eyeColor }}</span>
                    </div>
                    <div v-if="appearance.customization.bodyType">
                      <span class="text-gray-500">{{ t('players.details.bodyType') }}:</span>
                      <span class="text-white ml-2">{{ appearance.customization.bodyType }}</span>
                    </div>
                  </div>

                  <!-- No customization data -->
                  <p v-if="!appearance.customization.hairStyle && !appearance.customization.hairColor && !appearance.customization.eyeColor && !appearance.customization.bodyType" class="text-gray-500 text-sm">
                    {{ t('players.details.noCustomization') }}
                  </p>
                </div>
              </div>

              <div v-else class="flex flex-col items-center justify-center h-48 text-center">
                <svg class="w-12 h-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <p class="text-gray-400">{{ t('players.details.appearanceUnavailable') }}</p>
                <p class="text-gray-500 text-sm mt-1">{{ t('players.details.appearanceHint') }}</p>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 border-t border-dark-50 flex justify-end">
            <Button variant="secondary" @click="emit('close')">{{ t('common.close') }}</Button>
          </div>
        </div>
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
</style>
