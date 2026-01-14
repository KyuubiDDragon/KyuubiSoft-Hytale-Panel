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
const arrayEditors = ref<{ [key: string]: string }>({})

// Parse JSON when modelValue changes
watch(() => props.modelValue, (newValue) => {
  try {
    parsedConfig.value = JSON.parse(newValue || '{}')
    parseError.value = null
    // Initialize array editors
    initArrayEditors(parsedConfig.value, '')
  } catch (e) {
    parseError.value = 'Invalid JSON format'
    parsedConfig.value = {}
  }
}, { immediate: true })

function initArrayEditors(obj: { [key: string]: ConfigValue }, prefix: string) {
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    const value = obj[key]
    if (Array.isArray(value)) {
      arrayEditors.value[fullKey] = JSON.stringify(value, null, 2)
    } else if (typeof value === 'object' && value !== null) {
      initArrayEditors(value as { [key: string]: ConfigValue }, fullKey)
    }
  }
}

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

function updateNestedValue(path: string[], value: ConfigValue) {
  let current: any = parsedConfig.value
  for (let i = 0; i < path.length - 1; i++) {
    current = current[path[i]]
  }
  current[path[path.length - 1]] = value
  updateConfig()
}

function updateArrayValue(key: string, jsonStr: string) {
  arrayEditors.value[key] = jsonStr
  try {
    const parsed = JSON.parse(jsonStr)
    if (Array.isArray(parsed)) {
      const keys = key.split('.')
      if (keys.length === 1) {
        parsedConfig.value[key] = parsed
      } else {
        updateNestedValue(keys, parsed)
      }
      updateConfig()
    }
  } catch (e) {
    // Invalid JSON - don't update
  }
}

function getValueType(value: ConfigValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim()
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.includes('.')
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
          <label class="block text-sm font-medium text-gray-300">
            {{ formatKey(key) }}
            <span v-if="isPathLike(parsedConfig[key] as string)" class="text-xs text-gray-500 ml-2">(path)</span>
          </label>
          <input
            :value="parsedConfig[key] as string"
            @input="updateValue(key, ($event.target as HTMLInputElement).value)"
            type="text"
            class="w-full px-4 py-2 bg-dark-300 border border-dark-50 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-hytale-orange"
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
        <div v-else-if="getValueType(parsedConfig[key]) === 'boolean'" class="flex items-center justify-between py-2 px-1">
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

        <!-- Array (editable textarea) -->
        <div v-else-if="getValueType(parsedConfig[key]) === 'array'" class="space-y-1">
          <label class="block text-sm font-medium text-gray-300">
            {{ formatKey(key) }}
            <span class="text-xs text-hytale-orange ml-2">(Array - {{ (parsedConfig[key] as ConfigValue[]).length }} items)</span>
          </label>
          <textarea
            :value="arrayEditors[key] || JSON.stringify(parsedConfig[key], null, 2)"
            @input="updateArrayValue(key, ($event.target as HTMLTextAreaElement).value)"
            rows="4"
            class="w-full px-3 py-2 bg-dark-300 border border-dark-50 rounded-lg text-white text-sm font-mono focus:outline-none focus:border-hytale-orange resize-y"
            spellcheck="false"
          ></textarea>
        </div>

        <!-- Nested Object -->
        <div v-else-if="getValueType(parsedConfig[key]) === 'object'" class="space-y-2">
          <label class="block text-sm font-medium text-hytale-orange">{{ formatKey(key) }}</label>
          <div class="ml-4 pl-4 border-l-2 border-dark-50 space-y-3">
            <template v-for="(childValue, childKey) in (parsedConfig[key] as { [key: string]: ConfigValue })" :key="childKey">
              <!-- Nested String -->
              <div v-if="getValueType(childValue) === 'string'" class="space-y-1">
                <label class="block text-xs font-medium text-gray-400">
                  {{ formatKey(String(childKey)) }}
                  <span v-if="isPathLike(childValue as string)" class="text-gray-500 ml-1">(path)</span>
                </label>
                <input
                  :value="childValue as string"
                  @input="updateNestedValue([key, String(childKey)], ($event.target as HTMLInputElement).value)"
                  type="text"
                  class="w-full px-3 py-1.5 bg-dark-300 border border-dark-50 rounded-lg text-white text-sm font-mono focus:outline-none focus:border-hytale-orange"
                />
              </div>

              <!-- Nested Number -->
              <div v-else-if="getValueType(childValue) === 'number'" class="space-y-1">
                <label class="block text-xs font-medium text-gray-400">{{ formatKey(String(childKey)) }}</label>
                <input
                  :value="childValue as number"
                  @input="updateNestedValue([key, String(childKey)], parseFloat(($event.target as HTMLInputElement).value) || 0)"
                  type="number"
                  class="w-full px-3 py-1.5 bg-dark-300 border border-dark-50 rounded-lg text-white text-sm focus:outline-none focus:border-hytale-orange"
                />
              </div>

              <!-- Nested Boolean -->
              <div v-else-if="getValueType(childValue) === 'boolean'" class="flex items-center justify-between py-1 px-1">
                <label class="text-xs font-medium text-gray-400">{{ formatKey(String(childKey)) }}</label>
                <button
                  @click="updateNestedValue([key, String(childKey)], !childValue)"
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

              <!-- Nested Array -->
              <div v-else-if="getValueType(childValue) === 'array'" class="space-y-1">
                <label class="block text-xs font-medium text-gray-400">
                  {{ formatKey(String(childKey)) }}
                  <span class="text-hytale-orange ml-1">(Array)</span>
                </label>
                <textarea
                  :value="arrayEditors[`${key}.${childKey}`] || JSON.stringify(childValue, null, 2)"
                  @input="updateArrayValue(`${key}.${childKey}`, ($event.target as HTMLTextAreaElement).value)"
                  rows="3"
                  class="w-full px-3 py-1.5 bg-dark-300 border border-dark-50 rounded-lg text-white text-xs font-mono focus:outline-none focus:border-hytale-orange resize-y"
                  spellcheck="false"
                ></textarea>
              </div>

              <!-- Nested Object (show as JSON) -->
              <div v-else-if="getValueType(childValue) === 'object'" class="space-y-1">
                <label class="block text-xs font-medium text-gray-400">
                  {{ formatKey(String(childKey)) }}
                  <span class="text-gray-500 ml-1">(Object)</span>
                </label>
                <textarea
                  :value="JSON.stringify(childValue, null, 2)"
                  @input="(() => { try { updateNestedValue([key, String(childKey)], JSON.parse(($event.target as HTMLTextAreaElement).value)) } catch {} })()"
                  rows="4"
                  class="w-full px-3 py-1.5 bg-dark-300 border border-dark-50 rounded-lg text-white text-xs font-mono focus:outline-none focus:border-hytale-orange resize-y"
                  spellcheck="false"
                ></textarea>
              </div>

              <!-- Null -->
              <div v-else class="space-y-1">
                <label class="block text-xs font-medium text-gray-400">{{ formatKey(String(childKey)) }}</label>
                <input
                  :value="String(childValue)"
                  @input="updateNestedValue([key, String(childKey)], ($event.target as HTMLInputElement).value || null)"
                  type="text"
                  placeholder="null"
                  class="w-full px-3 py-1.5 bg-dark-300 border border-dark-50 rounded-lg text-white text-sm focus:outline-none focus:border-hytale-orange"
                />
              </div>
            </template>
          </div>
        </div>

        <!-- Null or Unknown -->
        <div v-else class="space-y-1">
          <label class="block text-sm font-medium text-gray-300">{{ formatKey(key) }}</label>
          <input
            :value="parsedConfig[key] === null ? '' : String(parsedConfig[key])"
            @input="updateValue(key, ($event.target as HTMLInputElement).value || null)"
            type="text"
            placeholder="null"
            class="w-full px-4 py-2 bg-dark-300 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
          />
        </div>
      </div>
    </div>
  </div>
</template>
