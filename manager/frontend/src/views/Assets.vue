<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { assetsApi, type AssetStatus, type AssetFileInfo, type FileContent, type SearchResult } from '@/api/assets'

const { t } = useI18n()

// State
const status = ref<AssetStatus | null>(null)
const currentPath = ref('')
const pathHistory = ref<string[]>([])
const files = ref<AssetFileInfo[]>([])
const selectedFile = ref<AssetFileInfo | null>(null)
const fileContent = ref<FileContent | null>(null)
const searchQuery = ref('')
const searchContent = ref(false)
const searchResults = ref<SearchResult[]>([])
const isSearching = ref(false)
const showSearch = ref(false)

// Loading states
const loading = ref(true)
const loadingFiles = ref(false)
const loadingContent = ref(false)
const extracting = ref(false)
const clearing = ref(false)

// Messages
const error = ref('')
const success = ref('')

// Computed
const breadcrumbs = computed(() => {
  if (!currentPath.value) return [{ name: t('assets.root'), path: '' }]
  const parts = currentPath.value.split('/')
  const crumbs = [{ name: t('assets.root'), path: '' }]
  let pathSoFar = ''
  for (const part of parts) {
    pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part
    crumbs.push({ name: part, path: pathSoFar })
  }
  return crumbs
})

const fileTypeIcon = computed(() => (file: AssetFileInfo) => {
  if (file.type === 'directory') return 'folder'
  const ext = file.extension?.toLowerCase()
  if (['.json', '.yml', '.yaml', '.xml'].includes(ext || '')) return 'json'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext || '')) return 'image'
  if (['.txt', '.md', '.log', '.cfg', '.conf', '.ini', '.lua', '.js', '.ts', '.css', '.html'].includes(ext || '')) return 'text'
  return 'file'
})

// Methods
async function loadStatus() {
  loading.value = true
  error.value = ''
  try {
    status.value = await assetsApi.getStatus()
    if (status.value.extracted) {
      await loadDirectory('')
    }
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function extractAssets() {
  extracting.value = true
  error.value = ''
  success.value = ''
  try {
    const result = await assetsApi.extract()
    success.value = t('assets.extractSuccess')
    await loadStatus()
    setTimeout(() => success.value = '', 5000)
  } catch (e) {
    error.value = 'Extraction failed'
  } finally {
    extracting.value = false
  }
}

async function clearCache() {
  clearing.value = true
  error.value = ''
  success.value = ''
  try {
    await assetsApi.clearCache()
    success.value = t('assets.clearSuccess')
    status.value = await assetsApi.getStatus()
    files.value = []
    currentPath.value = ''
    selectedFile.value = null
    fileContent.value = null
    setTimeout(() => success.value = '', 5000)
  } catch (e) {
    error.value = 'Failed to clear cache'
  } finally {
    clearing.value = false
  }
}

async function loadDirectory(path: string) {
  loadingFiles.value = true
  error.value = ''
  selectedFile.value = null
  fileContent.value = null
  try {
    const result = await assetsApi.browse(path)
    files.value = result.items
    currentPath.value = path
  } catch (e) {
    error.value = 'Failed to load directory'
    files.value = []
  } finally {
    loadingFiles.value = false
  }
}

async function navigateToFolder(file: AssetFileInfo) {
  if (file.type !== 'directory') return
  pathHistory.value.push(currentPath.value)
  await loadDirectory(file.path)
}

async function navigateToBreadcrumb(path: string) {
  pathHistory.value = []
  await loadDirectory(path)
}

async function goBack() {
  const prev = pathHistory.value.pop() || ''
  await loadDirectory(prev)
}

async function selectFile(file: AssetFileInfo) {
  if (file.type === 'directory') {
    await navigateToFolder(file)
    return
  }
  selectedFile.value = file
  loadingContent.value = true
  try {
    fileContent.value = await assetsApi.readFile(file.path)
  } catch (e) {
    fileContent.value = null
    error.value = 'Failed to load file'
  } finally {
    loadingContent.value = false
  }
}

async function performSearch() {
  if (searchQuery.value.length < 2) return
  isSearching.value = true
  error.value = ''
  try {
    const result = await assetsApi.search(searchQuery.value, {
      searchContent: searchContent.value,
      limit: 100,
    })
    searchResults.value = result.results
  } catch (e) {
    error.value = 'Search failed'
    searchResults.value = []
  } finally {
    isSearching.value = false
  }
}

async function selectSearchResult(result: SearchResult) {
  if (result.type === 'directory') {
    showSearch.value = false
    await loadDirectory(result.path)
  } else {
    showSearch.value = false
    // Navigate to parent folder and select file
    const parentPath = result.path.includes('/') ? result.path.substring(0, result.path.lastIndexOf('/')) : ''
    await loadDirectory(parentPath)
    const file = files.value.find(f => f.path === result.path)
    if (file) {
      await selectFile(file)
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

function copyPath() {
  if (selectedFile.value) {
    navigator.clipboard.writeText(selectedFile.value.path)
  }
}

function downloadFile() {
  if (selectedFile.value) {
    window.open(assetsApi.getDownloadUrl(selectedFile.value.path), '_blank')
  }
}

// Debounced search
let searchTimeout: ReturnType<typeof setTimeout> | null = null
watch(searchQuery, () => {
  if (searchTimeout) clearTimeout(searchTimeout)
  if (searchQuery.value.length >= 2) {
    searchTimeout = setTimeout(performSearch, 300)
  } else {
    searchResults.value = []
  }
})

onMounted(loadStatus)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('assets.title') }}</h1>
        <p class="text-gray-400 text-sm">{{ t('assets.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          @click="showSearch = !showSearch"
          class="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors flex items-center gap-2"
          :class="{ 'bg-hytale-orange': showSearch }"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          {{ t('assets.search') }}
        </button>
        <button
          @click="loadStatus"
          class="text-gray-400 hover:text-white transition-colors p-2"
          :class="{ 'animate-spin': loading }"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>
    <div v-if="success" class="p-4 bg-status-success/10 border border-status-success/20 rounded-lg">
      <p class="text-status-success">{{ success }}</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12 text-gray-400">
      {{ t('common.loading') }}
    </div>

    <!-- Search Panel -->
    <div v-else-if="showSearch" class="card">
      <div class="card-header">
        <h3 class="text-lg font-semibold text-white">{{ t('assets.search') }}</h3>
      </div>
      <div class="card-body space-y-4">
        <div class="flex gap-4">
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('assets.searchPlaceholder')"
            class="flex-1 px-4 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-hytale-orange focus:ring-1 focus:ring-hytale-orange"
          />
          <label class="flex items-center gap-2 text-gray-400">
            <input
              v-model="searchContent"
              type="checkbox"
              class="w-4 h-4 rounded bg-gray-700 border-gray-600 text-hytale-orange focus:ring-hytale-orange"
            />
            {{ t('assets.searchContent') }}
          </label>
        </div>

        <!-- Search Results -->
        <div v-if="isSearching" class="text-center py-8 text-gray-400">
          <svg class="w-8 h-8 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('common.loading') }}
        </div>
        <div v-else-if="searchResults.length > 0" class="max-h-96 overflow-y-auto space-y-1">
          <button
            v-for="result in searchResults"
            :key="result.path"
            @click="selectSearchResult(result)"
            class="w-full text-left px-4 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg flex items-start gap-3 transition-colors"
          >
            <svg v-if="result.type === 'directory'" class="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <svg v-else class="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <div class="flex-1 min-w-0">
              <p class="text-white font-medium truncate">{{ result.name }}</p>
              <p class="text-gray-500 text-sm truncate">{{ result.path }}</p>
              <p v-if="result.contentPreview" class="text-gray-400 text-xs mt-1 truncate">{{ result.contentPreview }}</p>
            </div>
            <span v-if="result.matchType === 'content'" class="text-xs text-hytale-orange bg-hytale-orange/20 px-2 py-0.5 rounded">Content</span>
          </button>
        </div>
        <div v-else-if="searchQuery.length >= 2" class="text-center py-8 text-gray-400">
          {{ t('assets.noResults') }}
        </div>
      </div>
    </div>

    <!-- Status Card (when not extracted) -->
    <div v-else-if="status && !status.extracted" class="card">
      <div class="card-header">
        <h3 class="text-lg font-semibold text-white">{{ t('assets.status') }}</h3>
      </div>
      <div class="card-body">
        <div class="text-center py-8">
          <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
          </svg>
          <p class="text-gray-400 mb-2">{{ t('assets.notExtracted') }}</p>
          <p v-if="status.sourceExists" class="text-gray-500 text-sm mb-4">
            {{ t('assets.sourceFile') }}: {{ status.sourceFile?.split('/').pop() }}
          </p>
          <p v-else class="text-status-error text-sm mb-4">{{ t('assets.sourceNotFound') }}</p>
          <button
            v-if="status.sourceExists"
            @click="extractAssets"
            :disabled="extracting"
            class="px-6 py-3 bg-hytale-orange hover:bg-hytale-orange/80 disabled:bg-gray-600 text-white font-medium rounded-lg transition-colors"
          >
            {{ extracting ? t('assets.extracting') : t('assets.extract') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Main Browser -->
    <template v-else-if="status && status.extracted">
      <!-- Status Bar -->
      <div class="card">
        <div class="card-body py-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-6 text-sm">
              <span class="text-gray-400">
                <span class="text-white font-medium">{{ status.fileCount.toLocaleString() }}</span> {{ t('assets.fileCount') }}
              </span>
              <span class="text-gray-400">
                <span class="text-white font-medium">{{ formatSize(status.totalSize) }}</span> {{ t('assets.totalSize') }}
              </span>
              <span v-if="status.extractedAt" class="text-gray-400">
                {{ t('assets.extractedAt') }}: <span class="text-white">{{ formatDate(status.extractedAt) }}</span>
              </span>
              <span v-if="status.needsUpdate" class="text-status-warning flex items-center gap-1">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                {{ t('assets.needsUpdate') }}
              </span>
            </div>
            <div class="flex items-center gap-2">
              <button
                @click="extractAssets"
                :disabled="extracting"
                class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-sm rounded-lg transition-colors"
              >
                {{ extracting ? t('assets.extracting') : t('assets.reExtract') }}
              </button>
              <button
                @click="clearCache"
                :disabled="clearing"
                class="px-3 py-1.5 bg-gray-700 hover:bg-status-error/20 hover:text-status-error disabled:bg-gray-800 text-gray-400 text-sm rounded-lg transition-colors"
              >
                {{ clearing ? t('assets.clearing') : t('assets.clearCache') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Browser Grid -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- File List -->
        <div class="card lg:col-span-1">
          <div class="card-header">
            <h3 class="text-lg font-semibold text-white">{{ t('assets.browse') }}</h3>
          </div>
          <div class="card-body p-0">
            <!-- Breadcrumbs -->
            <div class="px-4 py-2 border-b border-gray-700 flex items-center gap-1 text-sm overflow-x-auto">
              <template v-for="(crumb, i) in breadcrumbs" :key="crumb.path">
                <button
                  @click="navigateToBreadcrumb(crumb.path)"
                  class="text-gray-400 hover:text-white transition-colors whitespace-nowrap"
                  :class="{ 'text-hytale-orange font-medium': i === breadcrumbs.length - 1 }"
                >
                  {{ crumb.name }}
                </button>
                <span v-if="i < breadcrumbs.length - 1" class="text-gray-600">/</span>
              </template>
            </div>

            <!-- Back button -->
            <button
              v-if="currentPath"
              @click="goBack"
              class="w-full px-4 py-2 text-left hover:bg-gray-700/50 flex items-center gap-2 border-b border-gray-700 text-gray-400"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12" />
              </svg>
              {{ t('assets.backToParent') }}
            </button>

            <!-- File list -->
            <div class="overflow-y-auto" style="max-height: calc(100vh - 400px);">
              <div v-if="loadingFiles" class="text-center py-8 text-gray-400">
                {{ t('common.loading') }}
              </div>
              <div v-else-if="files.length === 0" class="text-center py-8 text-gray-400">
                {{ t('assets.noFiles') }}
              </div>
              <button
                v-else
                v-for="file in files"
                :key="file.path"
                @click="selectFile(file)"
                class="w-full px-4 py-2 text-left hover:bg-gray-700/50 flex items-center gap-3 border-b border-gray-700/50 transition-colors"
                :class="{ 'bg-hytale-orange/20 border-l-2 border-l-hytale-orange': selectedFile?.path === file.path }"
              >
                <!-- Icon -->
                <svg v-if="file.type === 'directory'" class="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <svg v-else-if="fileTypeIcon(file) === 'json'" class="w-5 h-5 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <svg v-else-if="fileTypeIcon(file) === 'image'" class="w-5 h-5 text-purple-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <svg v-else-if="fileTypeIcon(file) === 'text'" class="w-5 h-5 text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <svg v-else class="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <!-- Name and info -->
                <div class="flex-1 min-w-0">
                  <p class="text-white truncate">{{ file.name }}</p>
                  <p v-if="file.type === 'file'" class="text-gray-500 text-xs">{{ formatSize(file.size) }}</p>
                </div>
                <!-- Arrow for folders -->
                <svg v-if="file.type === 'directory'" class="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- File Viewer -->
        <div class="lg:col-span-2">
          <div v-if="loadingContent" class="card">
            <div class="card-body text-center py-12">
              <svg class="w-8 h-8 animate-spin mx-auto text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
          </div>

          <div v-else-if="selectedFile && fileContent" class="card">
            <div class="card-header flex items-center justify-between">
              <div>
                <h3 class="text-lg font-semibold text-white">{{ selectedFile.name }}</h3>
                <p class="text-sm text-gray-400">{{ selectedFile.path }}</p>
              </div>
              <div class="flex items-center gap-2">
                <button
                  @click="copyPath"
                  class="p-2 text-gray-400 hover:text-white transition-colors"
                  :title="t('assets.copyPath')"
                >
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
                <button
                  @click="downloadFile"
                  class="p-2 text-gray-400 hover:text-white transition-colors"
                  :title="t('assets.download')"
                >
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="card-body">
              <!-- Image viewer -->
              <div v-if="fileContent.mimeType?.startsWith('image/')" class="text-center">
                <img
                  :src="`data:${fileContent.mimeType};base64,${fileContent.content}`"
                  :alt="selectedFile.name"
                  class="max-w-full max-h-[500px] mx-auto rounded-lg border border-gray-700"
                />
                <p class="text-gray-500 text-sm mt-2">{{ formatSize(fileContent.size) }}</p>
              </div>

              <!-- JSON viewer -->
              <div v-else-if="fileContent.mimeType === 'application/json'" class="relative">
                <pre class="bg-gray-900 p-4 rounded-lg text-sm text-gray-300 overflow-auto max-h-[500px] font-mono">{{ typeof fileContent.content === 'string' ? JSON.stringify(JSON.parse(fileContent.content), null, 2) : fileContent.content }}</pre>
              </div>

              <!-- Text viewer -->
              <div v-else-if="!fileContent.isBinary" class="relative">
                <pre class="bg-gray-900 p-4 rounded-lg text-sm text-gray-300 overflow-auto max-h-[500px] font-mono whitespace-pre-wrap">{{ fileContent.content }}</pre>
              </div>

              <!-- Hex viewer -->
              <div v-else class="relative">
                <p class="text-gray-400 mb-2">{{ t('assets.viewer.hex') }} (first 1KB)</p>
                <pre class="bg-gray-900 p-4 rounded-lg text-xs text-gray-400 overflow-auto max-h-[400px] font-mono">{{ fileContent.content }}</pre>
                <p class="text-gray-500 text-sm mt-2">{{ formatSize(fileContent.size) }}</p>
              </div>
            </div>
          </div>

          <!-- No file selected -->
          <div v-else class="card">
            <div class="card-body text-center py-12">
              <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p class="text-gray-400">{{ t('assets.preview') }}</p>
              <p class="text-gray-500 text-sm mt-1">Select a file from the list to view its contents</p>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
