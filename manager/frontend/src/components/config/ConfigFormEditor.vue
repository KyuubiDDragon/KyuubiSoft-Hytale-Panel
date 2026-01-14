<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{
  modelValue: string
  filename: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue }

const parsedConfig = ref<{ [key: string]: ConfigValue }>({})
const parseError = ref<string | null>(null)

// Parse JSON when modelValue changes
watch(() => props.modelValue, (newValue) => {
  try {
    parsedConfig.value = JSON.parse(newValue || '{}')
    parseError.value = null
  } catch (e) {
    parseError.value = 'Invalid JSON format'
    parsedConfig.value = {}
  }
}, { immediate: true })

// Update modelValue when parsedConfig changes
function updateConfig() {
  try {
    const json = JSON.stringify(parsedConfig.value, null, 2)
    emit('update:modelValue', json)
  } catch (e) {
    // Ignore stringify errors
  }
}

function updateValue(key: string, value: ConfigValue) {
  parsedConfig.value[key] = value
  updateConfig()
}

function updateNestedValue(parentKey: string, childKey: string, value: ConfigValue) {
  if (typeof parsedConfig.value[parentKey] === 'object' && parsedConfig.value[parentKey] !== null) {
    (parsedConfig.value[parentKey] as { [key: string]: ConfigValue })[childKey] = value
    updateConfig()
  }
}

function getValueType(value: ConfigValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function formatKey(key: string): string {
  // Convert camelCase or snake_case to readable format
  return key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim()
}

const topLevelKeys = computed(() => Object.keys(parsedConfig.value))
</script>

<template>
  <div class="space-y-4">
    <!-- Parse Error -->
    <div v-if="parseError" class="p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
      {{ parseError }}
    </div>

    <!-- Empty State -->
    <div v-else-if="topLevelKeys.length === 0" class="text-center py-8 text-gray-500">
      No configuration properties found
    </div>

    <!-- Form Fields -->
    <div v-else class="space-y-4">
      <div v-for="key in topLevelKeys" :key="key" class="space-y-2">
        <!-- String Input -->
        <div v-if="getValueType(parsedConfig[key]) === 'string'" class="space-y-1">
          <label class="block text-sm font-medium text-gray-300">{{ formatKey(key) }}</label>
          <input
            :value="parsedConfig[key] as string"
            @input="updateValue(key, ($event.target as HTMLInputElement).value)"
            type="text"
            class="w-full px-4 py-2 bg-dark-300 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
          />
        </div>

        <!-- Number Input -->
        <div v-else-if="getValueType(parsedConfig[key]) === 'number'" class="space-y-1">
          <label class="block text-sm font-medium text-gray-300">{{ formatKey(key) }}</label>
          <input
            :value="parsedConfig[key] as number"
            @input="updateValue(key, parseFloat(($event.target as HTMLInputElement).value) || 0)"
            type="number"
            class="w-full px-4 py-2 bg-dark-300 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
          />
        </div>

        <!-- Boolean Toggle -->
        <div v-else-if="getValueType(parsedConfig[key]) === 'boolean'" class="flex items-center justify-between py-2">
          <label class="text-sm font-medium text-gray-300">{{ formatKey(key) }}</label>
          <button
            @click="updateValue(key, !parsedConfig[key])"
            :class="[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              parsedConfig[key] ? 'bg-hytale-orange' : 'bg-dark-50'
            ]"
          >
            <span
              :class="[
                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                parsedConfig[key] ? 'translate-x-6' : 'translate-x-1'
              ]"
            />
          </button>
        </div>

        <!-- Nested Object -->
        <div v-else-if="getValueType(parsedConfig[key]) === 'object'" class="space-y-2">
          <label class="block text-sm font-medium text-hytale-orange">{{ formatKey(key) }}</label>
          <div class="ml-4 pl-4 border-l-2 border-dark-50 space-y-3">
            <template v-for="(childValue, childKey) in (parsedConfig[key] as { [key: string]: ConfigValue })" :key="childKey">
              <!-- Nested String -->
              <div v-if="getValueType(childValue) === 'string'" class="space-y-1">
                <label class="block text-xs font-medium text-gray-400">{{ formatKey(String(childKey)) }}</label>
                <input
                  :value="childValue as string"
                  @input="updateNestedValue(key, String(childKey), ($event.target as HTMLInputElement).value)"
                  type="text"
                  class="w-full px-3 py-1.5 bg-dark-300 border border-dark-50 rounded-lg text-white text-sm focus:outline-none focus:border-hytale-orange"
                />
              </div>

              <!-- Nested Number -->
              <div v-else-if="getValueType(childValue) === 'number'" class="space-y-1">
                <label class="block text-xs font-medium text-gray-400">{{ formatKey(String(childKey)) }}</label>
                <input
                  :value="childValue as number"
                  @input="updateNestedValue(key, String(childKey), parseFloat(($event.target as HTMLInputElement).value) || 0)"
                  type="number"
                  class="w-full px-3 py-1.5 bg-dark-300 border border-dark-50 rounded-lg text-white text-sm focus:outline-none focus:border-hytale-orange"
                />
              </div>

              <!-- Nested Boolean -->
              <div v-else-if="getValueType(childValue) === 'boolean'" class="flex items-center justify-between py-1">
                <label class="text-xs font-medium text-gray-400">{{ formatKey(String(childKey)) }}</label>
                <button
                  @click="updateNestedValue(key, String(childKey), !childValue)"
                  :class="[
                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                    childValue ? 'bg-hytale-orange' : 'bg-dark-50'
                  ]"
                >
                  <span
                    :class="[
                      'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                      childValue ? 'translate-x-5' : 'translate-x-1'
                    ]"
                  />
                </button>
              </div>

              <!-- Other types shown as text -->
              <div v-else class="space-y-1">
                <label class="block text-xs font-medium text-gray-400">{{ formatKey(String(childKey)) }}</label>
                <div class="px-3 py-1.5 bg-dark-400 border border-dark-50 rounded-lg text-gray-500 text-sm font-mono">
                  {{ JSON.stringify(childValue) }}
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Array (shown as JSON) -->
        <div v-else-if="getValueType(parsedConfig[key]) === 'array'" class="space-y-1">
          <label class="block text-sm font-medium text-gray-300">{{ formatKey(key) }} (Array)</label>
          <div class="px-3 py-2 bg-dark-400 border border-dark-50 rounded-lg text-gray-400 text-sm font-mono max-h-32 overflow-auto">
            {{ JSON.stringify(parsedConfig[key], null, 2) }}
          </div>
        </div>

        <!-- Null or Unknown -->
        <div v-else class="space-y-1">
          <label class="block text-sm font-medium text-gray-300">{{ formatKey(key) }}</label>
          <input
            :value="String(parsedConfig[key])"
            @input="updateValue(key, ($event.target as HTMLInputElement).value)"
            type="text"
            class="w-full px-4 py-2 bg-dark-300 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
          />
        </div>
      </div>
    </div>
  </div>
</template>
