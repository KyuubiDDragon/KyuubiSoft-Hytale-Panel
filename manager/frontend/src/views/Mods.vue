<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import { modsApi, pluginsApi, configApi, type ModInfo, type ConfigFile } from '@/api/management'

const { t } = useI18n()

type TabType = 'mods' | 'plugins'

const activeTab = ref<TabType>('mods')
const mods = ref<ModInfo[]>([])
const plugins = ref<ModInfo[]>([])
const modsPath = ref('')
const pluginsPath = ref('')
const loading = ref(true)
const error = ref('')
const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// Config editor state
const showConfigModal = ref(false)
const editingItem = ref<ModInfo | null>(null)
const configFiles = ref<ConfigFile[]>([])
const selectedConfig = ref<ConfigFile | null>(null)
const configContent = ref('')
const configLoading = ref(false)
const configSaving = ref(false)

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [modsData, pluginsData] = await Promise.all([
      modsApi.get(),
      pluginsApi.get(),
    ])
    mods.value = modsData.mods
    modsPath.value = modsData.path
    plugins.value = pluginsData.plugins
    pluginsPath.value = pluginsData.path
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function toggleMod(mod: ModInfo) {
  try {
    await modsApi.toggle(mod.filename)
    await loadData()
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function togglePlugin(plugin: ModInfo) {
  try {
    await pluginsApi.toggle(plugin.filename)
    await loadData()
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

function triggerUpload() {
  fileInput.value?.click()
}

async function handleFileUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  uploading.value = true
  error.value = ''

  try {
    if (activeTab.value === 'mods') {
      await modsApi.upload(file)
    } else {
      await pluginsApi.upload(file)
    }
    await loadData()
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    uploading.value = false
    target.value = ''
  }
}

async function deleteItem(item: ModInfo) {
  if (!confirm(t('mods.confirmDelete', { name: item.name }))) return

  try {
    if (activeTab.value === 'mods') {
      await modsApi.delete(item.filename)
    } else {
      await pluginsApi.delete(item.filename)
    }
    await loadData()
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function openConfigEditor(item: ModInfo) {
  editingItem.value = item
  configFiles.value = []
  selectedConfig.value = null
  configContent.value = ''
  configLoading.value = true
  showConfigModal.value = true

  try {
    const api = activeTab.value === 'mods' ? modsApi : pluginsApi
    const result = await api.getConfigs(item.filename)
    configFiles.value = result.configs
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    configLoading.value = false
  }
}

async function loadConfigFile(config: ConfigFile) {
  selectedConfig.value = config
  configLoading.value = true

  try {
    const result = await configApi.read(config.path)
    configContent.value = result.content
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    configLoading.value = false
  }
}

async function saveConfigFile() {
  if (!selectedConfig.value) return

  configSaving.value = true
  try {
    await configApi.write(selectedConfig.value.path, configContent.value)
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    configSaving.value = false
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString()
}

const currentItems = computed(() => activeTab.value === 'mods' ? mods.value : plugins.value)
const currentPath = computed(() => activeTab.value === 'mods' ? modsPath.value : pluginsPath.value)
const enabledCount = computed(() => currentItems.value.filter(i => i.enabled).length)

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- Hidden file input -->
    <input
      ref="fileInput"
      type="file"
      accept=".jar,.zip,.js,.lua,.dll,.so"
      class="hidden"
      @change="handleFileUpload"
    />

    <!-- Page Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('mods.title') }}</h1>
        <p class="text-gray-400 mt-1">{{ t('mods.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <button
          @click="triggerUpload"
          :disabled="uploading"
          class="px-4 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <svg v-if="uploading" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          {{ t('mods.upload') }}
        </button>
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
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2">
      <button
        @click="activeTab = 'mods'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
          activeTab === 'mods'
            ? 'bg-hytale-orange text-dark'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
        {{ t('mods.mods') }} ({{ mods.length }})
      </button>
      <button
        @click="activeTab = 'plugins'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
          activeTab === 'plugins'
            ? 'bg-purple-500 text-white'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14v6m-3-3h6M6 10h2a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2zm10 0h2a2 2 0 002-2V6a2 2 0 00-2-2h-2a2 2 0 00-2 2v2a2 2 0 002 2zM6 20h2a2 2 0 002-2v-2a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2z" />
        </svg>
        {{ t('mods.plugins') }} ({{ plugins.length }})
      </button>
    </div>

    <!-- Info Card -->
    <Card>
      <div class="flex items-start gap-4">
        <div class="p-3 bg-hytale-orange/20 rounded-lg">
          <svg class="w-6 h-6 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="font-semibold text-white">{{ enabledCount }} {{ t('mods.active') }}</h3>
          <p class="text-sm text-gray-400 mt-1">{{ t('mods.path') }}: <code class="text-xs bg-dark-100 px-2 py-0.5 rounded">{{ currentPath }}</code></p>
          <p class="text-sm text-gray-500 mt-2">{{ t('mods.restartNote') }}</p>
        </div>
      </div>
    </Card>

    <!-- Items List -->
    <Card :title="activeTab === 'mods' ? t('mods.mods') : t('mods.plugins')" :padding="false">
      <div v-if="loading" class="text-center text-gray-500 p-8">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="currentItems.length === 0" class="text-center text-gray-500 p-8">
        <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
        </svg>
        {{ activeTab === 'mods' ? t('mods.noMods') : t('mods.noPlugins') }}
      </div>

      <div v-else class="divide-y divide-dark-50/30">
        <div
          v-for="item in currentItems"
          :key="item.filename"
          class="flex items-center justify-between p-4 hover:bg-dark-50/20 transition-colors"
        >
          <div class="flex items-center gap-4">
            <!-- Icon -->
            <div
              :class="[
                'w-12 h-12 rounded-lg flex items-center justify-center',
                item.enabled
                  ? (activeTab === 'mods' ? 'bg-hytale-orange/20' : 'bg-purple-500/20')
                  : 'bg-gray-600/20'
              ]"
            >
              <svg
                class="w-6 h-6"
                :class="item.enabled ? (activeTab === 'mods' ? 'text-hytale-orange' : 'text-purple-400') : 'text-gray-500'"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path v-if="activeTab === 'mods'" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14v6m-3-3h6M6 10h2a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2zm10 0h2a2 2 0 002-2V6a2 2 0 00-2-2h-2a2 2 0 00-2 2v2a2 2 0 002 2zM6 20h2a2 2 0 002-2v-2a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2z" />
              </svg>
            </div>

            <!-- Info -->
            <div>
              <p :class="['font-medium', item.enabled ? 'text-white' : 'text-gray-500']">{{ item.name }}</p>
              <div class="flex items-center gap-3 text-sm text-gray-500">
                <span>{{ formatSize(item.size) }}</span>
                <span>{{ formatDate(item.lastModified) }}</span>
                <span
                  :class="[
                    'px-2 py-0.5 rounded text-xs',
                    item.enabled ? 'bg-status-success/20 text-status-success' : 'bg-gray-600/20 text-gray-500'
                  ]"
                >
                  {{ item.enabled ? t('mods.enabled') : t('mods.disabled') }}
                </span>
              </div>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-3">
            <!-- Config Button -->
            <button
              @click="openConfigEditor(item)"
              class="p-2 text-gray-400 hover:text-blue-400 transition-colors"
              :title="t('mods.editConfig')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            <!-- Delete Button -->
            <button
              @click="deleteItem(item)"
              class="p-2 text-gray-400 hover:text-status-error transition-colors"
              :title="t('common.delete')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>

            <!-- Toggle Button -->
            <button
              @click="activeTab === 'mods' ? toggleMod(item) : togglePlugin(item)"
              :class="[
                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                item.enabled ? (activeTab === 'mods' ? 'bg-hytale-orange' : 'bg-purple-500') : 'bg-dark-50'
              ]"
            >
              <span
                :class="[
                  'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                  item.enabled ? 'translate-x-6' : 'translate-x-1'
                ]"
              />
            </button>
          </div>
        </div>
      </div>
    </Card>

    <!-- Config Editor Modal -->
    <div v-if="showConfigModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-dark-200 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <!-- Modal Header -->
        <div class="p-4 border-b border-dark-50/50 flex items-center justify-between">
          <h2 class="text-xl font-bold text-white">{{ t('mods.configEditor') }}: {{ editingItem?.name }}</h2>
          <button @click="showConfigModal = false" class="text-gray-400 hover:text-white">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Modal Content -->
        <div class="flex-1 flex overflow-hidden">
          <!-- Config Files List -->
          <div class="w-64 border-r border-dark-50/50 overflow-y-auto p-4">
            <h3 class="text-sm font-semibold text-gray-400 uppercase mb-3">{{ t('mods.configFiles') }}</h3>
            <div v-if="configLoading && !selectedConfig" class="text-gray-500 text-sm">
              {{ t('common.loading') }}
            </div>
            <div v-else-if="configFiles.length === 0" class="text-gray-500 text-sm">
              {{ t('mods.noConfigs') }}
            </div>
            <div v-else class="space-y-1">
              <button
                v-for="config in configFiles"
                :key="config.path"
                @click="loadConfigFile(config)"
                :class="[
                  'w-full px-3 py-2 rounded text-left text-sm transition-colors',
                  selectedConfig?.path === config.path
                    ? 'bg-hytale-orange/20 text-hytale-orange'
                    : 'text-gray-300 hover:bg-dark-100'
                ]"
              >
                {{ config.name }}
              </button>
            </div>
          </div>

          <!-- Config Editor -->
          <div class="flex-1 flex flex-col p-4">
            <div v-if="!selectedConfig" class="flex-1 flex items-center justify-center text-gray-500">
              {{ t('mods.selectConfig') }}
            </div>
            <template v-else>
              <div class="flex items-center justify-between mb-3">
                <span class="text-sm text-gray-400">{{ selectedConfig.path }}</span>
                <button
                  @click="saveConfigFile"
                  :disabled="configSaving"
                  class="px-4 py-1.5 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors text-sm disabled:opacity-50"
                >
                  {{ configSaving ? t('common.saving') : t('common.save') }}
                </button>
              </div>
              <div v-if="configLoading" class="flex-1 flex items-center justify-center text-gray-500">
                {{ t('common.loading') }}
              </div>
              <textarea
                v-else
                v-model="configContent"
                class="flex-1 w-full p-4 bg-dark-300 border border-dark-50 rounded-lg text-white font-mono text-sm resize-none focus:outline-none focus:border-hytale-orange"
                spellcheck="false"
              />
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
