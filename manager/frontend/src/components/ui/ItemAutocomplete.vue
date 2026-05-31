<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { assetsApi, type ItemInfo } from '@/api/assets'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  disabled?: boolean
}>(), {
  placeholder: 'hytale:diamond',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const showDropdown = ref(false)
const items = ref<ItemInfo[]>([])
const loading = ref(false)
const selectedIndex = ref(-1)
const inputValue = ref(props.modelValue)

// Debounce timer
let searchTimer: ReturnType<typeof setTimeout> | null = null

// Sync inputValue with modelValue
watch(() => props.modelValue, (newVal) => {
  inputValue.value = newVal
})

// Search items when input changes
watch(inputValue, async (newVal) => {
  if (searchTimer) clearTimeout(searchTimer)

  if (!newVal || newVal.length < 2) {
    items.value = []
    showDropdown.value = false
    return
  }

  searchTimer = setTimeout(async () => {
    loading.value = true
    try {
      const results = await assetsApi.searchItems(newVal, 10)
      items.value = results
      showDropdown.value = results.length > 0
      selectedIndex.value = -1
    } catch (error) {
      console.error('Failed to search items:', error)
      items.value = []
    } finally {
      loading.value = false
    }
  }, 200)
})

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement
  inputValue.value = target.value
  emit('update:modelValue', target.value)
}

function selectItem(item: ItemInfo) {
  inputValue.value = item.id
  emit('update:modelValue', item.id)
  showDropdown.value = false
  selectedIndex.value = -1
}

function handleKeydown(event: KeyboardEvent) {
  if (!showDropdown.value) return

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      selectedIndex.value = Math.min(selectedIndex.value + 1, items.value.length - 1)
      break
    case 'ArrowUp':
      event.preventDefault()
      selectedIndex.value = Math.max(selectedIndex.value - 1, -1)
      break
    case 'Enter':
      event.preventDefault()
      if (selectedIndex.value >= 0 && selectedIndex.value < items.value.length) {
        selectItem(items.value[selectedIndex.value])
      }
      break
    case 'Escape':
      showDropdown.value = false
      selectedIndex.value = -1
      break
  }
}

function handleFocus() {
  if (items.value.length > 0) {
    showDropdown.value = true
  }
}

function handleClickOutside(event: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(event.target as Node)) {
    showDropdown.value = false
  }
}

function getItemIconUrl(itemId: string): string {
  return assetsApi.getItemIconUrl(itemId)
}

function handleImageError(event: Event) {
  const img = event.target as HTMLImageElement
  img.style.display = 'none'
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <div ref="containerRef" class="relative">
    <div class="relative">
      <input
        ref="inputRef"
        type="text"
        :value="inputValue"
        :placeholder="placeholder"
        :disabled="disabled"
        class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange pr-8"
        @input="handleInput"
        @keydown="handleKeydown"
        @focus="handleFocus"
      />
      <div v-if="loading" class="absolute right-3 top-1/2 -translate-y-1/2">
        <svg class="w-4 h-4 animate-spin text-ink-muted" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      </div>
    </div>

    <!-- Dropdown -->
    <div
      v-if="showDropdown && items.length > 0"
      class="absolute z-50 w-full mt-1 bg-surface-raised border border-border rounded-lg shadow-xl max-h-60 overflow-y-auto"
    >
      <button
        v-for="(item, index) in items"
        :key="item.id"
        type="button"
        :class="[
          'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
          index === selectedIndex ? 'bg-hytale-orange/20 text-white' : 'text-ink-muted hover:bg-surface-overlay'
        ]"
        @click="selectItem(item)"
        @mouseenter="selectedIndex = index"
      >
        <!-- Item Icon -->
        <div class="w-8 h-8 bg-surface-overlay rounded flex items-center justify-center flex-shrink-0 overflow-hidden">
          <img
            :src="getItemIconUrl(item.id)"
            :alt="item.name"
            class="w-6 h-6 object-contain"
            @error="handleImageError"
          />
        </div>

        <!-- Item Info -->
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">{{ item.name }}</div>
          <div class="text-xs text-ink-subtle truncate">{{ item.id }}</div>
        </div>

        <!-- Category Badge -->
        <span
          v-if="item.category"
          class="px-2 py-0.5 text-xs rounded bg-surface-overlay text-ink-muted flex-shrink-0"
        >
          {{ item.category }}
        </span>
      </button>
    </div>
  </div>
</template>
