<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import Card from '@/components/ui/Card.vue'
import {
  modsApi,
  pluginsApi,
  configApi,
  modStoreApi,
  modtaleApi,
  stackmartApi,
  type ModInfo,
  type ConfigFile,
  type ModStoreEntry,
  type LocalizedString,
  type ModtaleProject,
  type ModtaleProjectDetails,
  type ModtaleStatus,
  type ModtaleSortOption,
  type ModtaleClassification,
  type ModtaleInstalledInfo,
  type StackMartResource,
  type StackMartResourceDetails,
  type StackMartStatus,
  type StackMartSortOption,
  type StackMartCategory,
  type StackMartInstalledInfo,
} from '@/api/management'
import { getLocale } from '@/i18n'

const { t } = useI18n()
const authStore = useAuthStore()

// Helper to get localized string based on current locale
function getLocalizedText(text: string | LocalizedString | undefined | null): string {
  if (!text) return ''
  if (typeof text === 'string') return text

  // Handle object type (LocalizedString)
  if (typeof text === 'object') {
    const locale = getLocale()
    // Map locale to key (handle pt_br -> pt_br)
    const localeKey = locale === 'pt_br' ? 'pt_br' : locale

    // Try current locale, then English, then German, then Portuguese, then first available value
    const result = text[localeKey as keyof LocalizedString]
      || text.en
      || text.de
      || text.pt_br
      || Object.values(text).find(v => typeof v === 'string' && v.length > 0)
      || ''

    return result
  }

  // Fallback: convert to string
  return String(text)
}

type TabType = 'mods' | 'plugins' | 'store' | 'modtale' | 'stackmart'

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
const configSaveSuccess = ref(false)

// Mod Store state
const storeMods = ref<ModStoreEntry[]>([])
const storeLoading = ref(false)
const installingMod = ref<string | null>(null)
const installSuccess = ref<string | null>(null)

// Modtale state
const modtaleStatus = ref<ModtaleStatus | null>(null)
const modtaleMods = ref<ModtaleProject[]>([])
const modtaleLoading = ref(false)
const modtaleSearch = ref('')
const modtaleSort = ref<ModtaleSortOption>('downloads')
const modtaleClassification = ref<ModtaleClassification | ''>('')
const modtaleTags = ref<string[]>([])
const modtaleAvailableTags = ref<string[]>([])
const modtalePage = ref(0)
const modtaleTotalPages = ref(0)
const modtaleTotalElements = ref(0)
const modtaleInstallingId = ref<string | null>(null)
const modtaleInstallSuccess = ref<string | null>(null)
const modtaleUninstallingId = ref<string | null>(null)
const showModtaleSettings = ref(false)
const showModtaleDetail = ref(false)
const modtaleDetailProject = ref<ModtaleProjectDetails | null>(null)
const modtaleDetailLoading = ref(false)
const modtaleInstalled = ref<Record<string, ModtaleInstalledInfo>>({})

// StackMart state
const stackmartStatus = ref<StackMartStatus | null>(null)
const stackmartResources = ref<StackMartResource[]>([])
const stackmartLoading = ref(false)
const stackmartSearch = ref('')
const stackmartSort = ref<StackMartSortOption>('popular')
const stackmartCategory = ref<StackMartCategory | ''>('')
const stackmartCategories = ref<string[]>([])
const stackmartPage = ref(1)
const stackmartTotalPages = ref(0)
const stackmartTotal = ref(0)
const stackmartInstallingId = ref<string | null>(null)
const stackmartInstallSuccess = ref<string | null>(null)
const stackmartUninstallingId = ref<string | null>(null)
const showStackMartSettings = ref(false)
const showStackMartDetail = ref(false)
const stackmartDetailResource = ref<StackMartResourceDetails | null>(null)
const stackmartDetailLoading = ref(false)
const stackmartInstalled = ref<Record<string, StackMartInstalledInfo>>({})

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

async function loadStoreData() {
  storeLoading.value = true
  error.value = ''
  try {
    const result = await modStoreApi.getAvailable()
    storeMods.value = result.mods
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    storeLoading.value = false
  }
}

async function installStoreMod(modId: string) {
  installingMod.value = modId
  installSuccess.value = null
  error.value = ''
  try {
    const result = await modStoreApi.install(modId)
    if (result.success) {
      installSuccess.value = modId
      await loadStoreData()
      await loadData()
      setTimeout(() => { installSuccess.value = null }, 3000)
    } else {
      error.value = result.error || t('errors.serverError')
    }
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    installingMod.value = null
  }
}

async function uninstallStoreMod(modId: string) {
  if (!confirm(t('mods.confirmUninstall', { name: modId }))) return

  installingMod.value = modId
  error.value = ''
  try {
    const result = await modStoreApi.uninstall(modId)
    if (result.success) {
      await loadStoreData()
      await loadData()
    } else {
      error.value = result.error || t('errors.serverError')
    }
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    installingMod.value = null
  }
}

const updatingMod = ref<string | null>(null)
const updateSuccess = ref<string | null>(null)

async function updateStoreMod(modId: string) {
  updatingMod.value = modId
  updateSuccess.value = null
  error.value = ''
  try {
    const result = await modStoreApi.update(modId)
    if (result.success) {
      updateSuccess.value = modId
      await loadStoreData()
      await loadData()
      setTimeout(() => { updateSuccess.value = null }, 3000)
    } else {
      error.value = result.error || t('errors.serverError')
    }
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    updatingMod.value = null
  }
}

function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    map: 'bg-blue-500/20 text-blue-400',
    utility: 'bg-green-500/20 text-green-400',
    gameplay: 'bg-purple-500/20 text-purple-400',
    admin: 'bg-red-500/20 text-red-400',
    other: 'bg-gray-500/20 text-gray-400',
  }
  return colors[category] || colors.other
}

function getCategoryIcon(category: string): string {
  const icons: Record<string, string> = {
    map: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7',
    utility: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    gameplay: 'M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    admin: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    other: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  }
  return icons[category] || icons.other
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
  configSaveSuccess.value = false
  try {
    await configApi.write(selectedConfig.value.path, configContent.value)
    configSaveSuccess.value = true
    // Hide success message after 3 seconds
    setTimeout(() => {
      configSaveSuccess.value = false
    }, 3000)
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

function switchToStore() {
  activeTab.value = 'store'
  if (storeMods.value.length === 0) {
    loadStoreData()
  }
}

// Modtale functions
async function loadModtaleStatus() {
  try {
    modtaleStatus.value = await modtaleApi.getStatus()
  } catch (e) {
    console.error('Failed to load Modtale status:', e)
  }
}

async function loadModtaleInstalled() {
  try {
    const result = await modtaleApi.getInstalled()
    modtaleInstalled.value = result.installed
  } catch (e) {
    console.error('Failed to load installed Modtale mods:', e)
  }
}

async function loadModtaleTags() {
  try {
    const result = await modtaleApi.getTags()
    modtaleAvailableTags.value = result.tags
  } catch (e) {
    console.error('Failed to load Modtale tags:', e)
  }
}

async function searchModtale() {
  modtaleLoading.value = true
  error.value = ''
  try {
    const result = await modtaleApi.search({
      search: modtaleSearch.value || undefined,
      page: modtalePage.value,
      size: 20,
      sort: modtaleSort.value,
      classification: modtaleClassification.value || undefined,
      tags: modtaleTags.value.length > 0 ? modtaleTags.value : undefined,
    })
    modtaleMods.value = result.content
    modtaleTotalPages.value = result.totalPages
    modtaleTotalElements.value = result.totalElements
  } catch (e: any) {
    if (e.response?.status === 503) {
      error.value = t('mods.modtaleUnavailable')
    } else {
      error.value = e.response?.data?.error || t('errors.serverError')
    }
  } finally {
    modtaleLoading.value = false
  }
}

async function switchToModtale() {
  activeTab.value = 'modtale'
  if (!modtaleStatus.value) {
    await loadModtaleStatus()
  }
  // Always load installed mods to check for updates
  loadModtaleInstalled()
  if (modtaleAvailableTags.value.length === 0) {
    loadModtaleTags()
  }
  if (modtaleMods.value.length === 0) {
    searchModtale()
  }
}

async function installFromModtale(project: ModtaleProject) {
  modtaleInstallingId.value = project.id
  modtaleInstallSuccess.value = null
  error.value = ''
  try {
    const result = await modtaleApi.install(project.id)
    if (result.success) {
      modtaleInstallSuccess.value = project.id
      await Promise.all([loadData(), loadModtaleInstalled()])
      setTimeout(() => { modtaleInstallSuccess.value = null }, 3000)
    } else {
      error.value = result.error || t('errors.serverError')
    }
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    modtaleInstallingId.value = null
  }
}

async function uninstallFromModtale(project: ModtaleProject) {
  if (!confirm(t('mods.confirmUninstall', { name: project.title }))) return

  modtaleUninstallingId.value = project.id
  error.value = ''
  try {
    const result = await modtaleApi.uninstall(project.id)
    if (result.success) {
      await Promise.all([loadData(), loadModtaleInstalled()])
    } else {
      error.value = result.error || t('errors.serverError')
    }
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    modtaleUninstallingId.value = null
  }
}

function isModtaleInstalled(projectId: string): boolean {
  return !!modtaleInstalled.value[projectId]
}

function getInstalledVersion(projectId: string): string | null {
  return modtaleInstalled.value[projectId]?.version || null
}

async function openModtaleDetail(project: ModtaleProject) {
  showModtaleDetail.value = true
  modtaleDetailLoading.value = true
  modtaleDetailProject.value = null
  try {
    modtaleDetailProject.value = await modtaleApi.getProject(project.id)
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    modtaleDetailLoading.value = false
  }
}

function getClassificationColor(classification: string): string {
  const colors: Record<string, string> = {
    PLUGIN: 'bg-purple-500/20 text-purple-400',
    DATA: 'bg-blue-500/20 text-blue-400',
    ART: 'bg-pink-500/20 text-pink-400',
    SAVE: 'bg-green-500/20 text-green-400',
    MODPACK: 'bg-orange-500/20 text-orange-400',
  }
  return colors[classification] || 'bg-gray-500/20 text-gray-400'
}

function formatDownloads(num: number | null | undefined): string {
  if (num == null) return '0'
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

// Watch for search/filter changes
watch([modtaleSearch, modtaleSort, modtaleClassification, modtaleTags], () => {
  modtalePage.value = 0
  searchModtale()
}, { deep: true })

watch(modtalePage, () => {
  searchModtale()
})

// StackMart functions
async function loadStackMartStatus() {
  try {
    stackmartStatus.value = await stackmartApi.getStatus()
  } catch (e) {
    console.error('Failed to load StackMart status:', e)
  }
}

async function loadStackMartInstalled() {
  try {
    const result = await stackmartApi.getInstalled()
    stackmartInstalled.value = result.installed
  } catch (e) {
    console.error('Failed to load installed StackMart resources:', e)
  }
}

async function loadStackMartCategories() {
  try {
    const result = await stackmartApi.getCategories()
    stackmartCategories.value = result.categories
  } catch (e) {
    console.error('Failed to load StackMart categories:', e)
  }
}

async function searchStackMart() {
  stackmartLoading.value = true
  error.value = ''
  try {
    const result = await stackmartApi.search({
      search: stackmartSearch.value || undefined,
      page: stackmartPage.value,
      limit: 20,
      sort: stackmartSort.value,
      category: stackmartCategory.value || undefined,
    })
    stackmartResources.value = result.resources
    stackmartTotalPages.value = result.totalPages
    stackmartTotal.value = result.total
  } catch (e: any) {
    if (e.response?.status === 503) {
      error.value = t('mods.stackmartUnavailable')
    } else {
      error.value = e.response?.data?.error || t('errors.serverError')
    }
  } finally {
    stackmartLoading.value = false
  }
}

async function switchToStackMart() {
  activeTab.value = 'stackmart'
  if (!stackmartStatus.value) {
    await loadStackMartStatus()
  }
  loadStackMartInstalled()
  if (stackmartCategories.value.length === 0) {
    loadStackMartCategories()
  }
  if (stackmartResources.value.length === 0) {
    searchStackMart()
  }
}

async function installFromStackMart(resource: StackMartResource) {
  stackmartInstallingId.value = resource.id
  stackmartInstallSuccess.value = null
  error.value = ''
  try {
    const result = await stackmartApi.install(resource.id)
    if (result.success) {
      stackmartInstallSuccess.value = resource.id
      await Promise.all([loadData(), loadStackMartInstalled()])
      setTimeout(() => { stackmartInstallSuccess.value = null }, 3000)
    } else {
      error.value = result.error || t('errors.serverError')
    }
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    stackmartInstallingId.value = null
  }
}

async function uninstallFromStackMart(resource: StackMartResource) {
  if (!confirm(t('mods.confirmUninstall', { name: resource.name }))) return

  stackmartUninstallingId.value = resource.id
  error.value = ''
  try {
    const result = await stackmartApi.uninstall(resource.id)
    if (result.success) {
      await Promise.all([loadData(), loadStackMartInstalled()])
    } else {
      error.value = result.error || t('errors.serverError')
    }
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    stackmartUninstallingId.value = null
  }
}

function isStackMartInstalled(resourceId: string): boolean {
  return !!stackmartInstalled.value[resourceId]
}

function getStackMartInstalledVersion(resourceId: string): string | null {
  return stackmartInstalled.value[resourceId]?.version || null
}

async function openStackMartDetail(resource: StackMartResource) {
  showStackMartDetail.value = true
  stackmartDetailLoading.value = true
  stackmartDetailResource.value = null
  try {
    const result = await stackmartApi.getResource(resource.id)
    stackmartDetailResource.value = result.resource
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    stackmartDetailLoading.value = false
  }
}

function getStackMartCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    plugins: 'bg-purple-500/20 text-purple-400',
    mods: 'bg-blue-500/20 text-blue-400',
    scripts: 'bg-green-500/20 text-green-400',
    tools: 'bg-orange-500/20 text-orange-400',
  }
  return colors[category?.toLowerCase()] || 'bg-gray-500/20 text-gray-400'
}

// Watch for StackMart search/filter changes
watch([stackmartSearch, stackmartSort, stackmartCategory], () => {
  stackmartPage.value = 1
  searchStackMart()
})

watch(stackmartPage, () => {
  searchStackMart()
})

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
          v-if="authStore.hasAnyPermission('mods.install', 'plugins.install')"
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
      <button
        @click="switchToStore"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
          activeTab === 'store'
            ? 'bg-emerald-500 text-white'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {{ t('mods.store') }}
      </button>
      <button
        @click="switchToModtale"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
          activeTab === 'modtale'
            ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
        Modtale
      </button>
      <button
        @click="switchToStackMart"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
          activeTab === 'stackmart'
            ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
        </svg>
        StackMart
      </button>
    </div>

    <!-- Info Card (Mods/Plugins tabs) -->
    <Card v-if="activeTab === 'mods' || activeTab === 'plugins'">
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

    <!-- Store Info Card -->
    <Card v-if="activeTab === 'store'">
      <div class="flex items-start gap-4">
        <div class="p-3 bg-emerald-500/20 rounded-lg">
          <svg class="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="font-semibold text-white">{{ t('mods.storeTitle') }}</h3>
          <p class="text-sm text-gray-400 mt-1">{{ t('mods.storeDescription') }}</p>
          <p class="text-sm text-gray-500 mt-2">{{ t('mods.restartNote') }}</p>
        </div>
      </div>
    </Card>

    <!-- Items List (Mods/Plugins) -->
    <Card v-if="activeTab === 'mods' || activeTab === 'plugins'" :title="activeTab === 'mods' ? t('mods.mods') : t('mods.plugins')" :padding="false">
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
              v-if="authStore.hasPermission(activeTab === 'mods' ? 'mods.config' : 'plugins.config')"
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
              v-if="authStore.hasPermission(activeTab === 'mods' ? 'mods.delete' : 'plugins.delete')"
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
              v-if="authStore.hasPermission(activeTab === 'mods' ? 'mods.toggle' : 'plugins.toggle')"
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

    <!-- Mod Store List -->
    <Card v-if="activeTab === 'store'" :title="t('mods.availableMods')" :padding="false">
      <div v-if="storeLoading" class="text-center text-gray-500 p-8">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="storeMods.length === 0" class="text-center text-gray-500 p-8">
        <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {{ t('mods.noStoreMods') }}
      </div>

      <div v-else class="divide-y divide-dark-50/30">
        <div
          v-for="mod in storeMods"
          :key="mod.id"
          class="flex items-center justify-between p-4 hover:bg-dark-50/20 transition-colors"
        >
          <div class="flex items-center gap-4">
            <!-- Icon -->
            <div :class="['w-12 h-12 rounded-lg flex items-center justify-center', getCategoryColor(mod.category)]">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="getCategoryIcon(mod.category)" />
              </svg>
            </div>

            <!-- Info -->
            <div class="flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="font-medium text-white">{{ mod.name }}</p>
                <span :class="['px-2 py-0.5 rounded text-xs', getCategoryColor(mod.category)]">
                  {{ mod.category }}
                </span>
                <span v-if="mod.installed" class="px-2 py-0.5 rounded text-xs bg-status-success/20 text-status-success">
                  {{ t('mods.installed') }} {{ mod.installedVersion }}
                </span>
                <span v-if="mod.hasUpdate" class="px-2 py-0.5 rounded text-xs bg-hytale-orange/20 text-hytale-orange animate-pulse">
                  {{ t('mods.updateAvailable') }}: {{ mod.latestVersion }}
                </span>
                <span v-if="installSuccess === mod.id" class="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-400 animate-pulse">
                  {{ t('mods.installSuccess') }}
                </span>
                <span v-if="updateSuccess === mod.id" class="px-2 py-0.5 rounded text-xs bg-hytale-orange/20 text-hytale-orange animate-pulse">
                  {{ t('mods.updateSuccess') }}
                </span>
              </div>
              <p class="text-sm text-gray-400 mt-1">{{ getLocalizedText(mod.description) }}</p>
              <!-- Hint (if available) -->
              <div v-if="mod.hints && getLocalizedText(mod.hints)" class="mt-2 p-2 bg-status-warning/10 border border-status-warning/30 rounded text-xs text-status-warning flex items-start gap-2">
                <svg class="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{{ getLocalizedText(mod.hints) }}</span>
              </div>
              <div class="flex items-center gap-3 text-sm text-gray-500 mt-1">
                <span>{{ t('mods.by') }} {{ mod.author }}</span>
                <a :href="'https://github.com/' + mod.github" target="_blank" class="text-blue-400 hover:underline flex items-center gap-1">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
                  </svg>
                  GitHub
                </a>
                <span v-if="mod.ports" class="text-gray-600">
                  {{ t('mods.ports') }}: {{ mod.ports.map(p => p.default).join(', ') }}
                </span>
              </div>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-2">
            <!-- Update Button (only if installed and has update) -->
            <button
              v-if="mod.installed && mod.hasUpdate && authStore.hasPermission('mods.install')"
              @click="updateStoreMod(mod.id)"
              :disabled="updatingMod === mod.id"
              class="px-4 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              <svg v-if="updatingMod === mod.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {{ updatingMod === mod.id ? t('mods.updating') : t('mods.update') }}
            </button>
            <!-- Install Button -->
            <button
              v-if="!mod.installed && authStore.hasPermission('mods.install')"
              @click="installStoreMod(mod.id)"
              :disabled="installingMod === mod.id"
              class="px-4 py-2 bg-emerald-500 text-white font-medium rounded-lg hover:bg-emerald-400 transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              <svg v-if="installingMod === mod.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {{ installingMod === mod.id ? t('mods.installing') : t('mods.install') }}
            </button>
            <!-- Uninstall Button -->
            <button
              v-if="mod.installed && authStore.hasPermission('mods.delete')"
              @click="uninstallStoreMod(mod.id)"
              :disabled="installingMod === mod.id || updatingMod === mod.id"
              class="px-4 py-2 bg-status-error/20 text-status-error font-medium rounded-lg hover:bg-status-error/30 transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              <svg v-if="installingMod === mod.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {{ t('mods.uninstall') }}
            </button>
          </div>
        </div>
      </div>
    </Card>

    <!-- Modtale Section -->
    <template v-if="activeTab === 'modtale'">
      <!-- Modtale Info Card with Settings Button -->
      <Card>
        <div class="flex items-start gap-4">
          <div class="p-3 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 rounded-lg">
            <svg class="w-6 h-6 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
          </div>
          <div class="flex-1">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <h3 class="font-semibold text-white">Modtale</h3>
                <a
                  href="https://modtale.net"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-cyan-400 hover:text-cyan-300 transition-colors flex items-center gap-1 text-sm"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  modtale.net
                </a>
              </div>
              <button
                @click="showModtaleSettings = true"
                class="px-3 py-1.5 bg-dark-100 text-gray-300 rounded-lg hover:bg-dark-50 transition-colors flex items-center gap-2 text-sm"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                API Key
              </button>
            </div>
            <p class="text-sm text-gray-400 mt-1">{{ t('mods.modtaleDescription') }}</p>
            <div class="flex items-center gap-4 mt-2 text-sm">
              <span v-if="modtaleStatus?.apiAvailable" class="flex items-center gap-1 text-green-400">
                <span class="w-2 h-2 bg-green-400 rounded-full"></span>
                {{ t('mods.apiOnline') }}
              </span>
              <span v-else class="flex items-center gap-1 text-red-400">
                <span class="w-2 h-2 bg-red-400 rounded-full"></span>
                {{ t('mods.apiOffline') }}
              </span>
              <span v-if="modtaleStatus?.hasApiKey" class="text-cyan-400">
                {{ modtaleStatus.rateLimit?.limit }} req/min
              </span>
              <span v-else class="text-gray-500">
                10 req/min ({{ t('mods.noApiKey') }})
              </span>
              <span class="text-gray-500">
                {{ modtaleTotalElements }} {{ t('mods.modsFound') }}
              </span>
            </div>
          </div>
        </div>
      </Card>

      <!-- Search & Filter -->
      <Card>
        <div class="flex flex-wrap gap-4">
          <!-- Search Input -->
          <div class="flex-1 min-w-[200px]">
            <div class="relative">
              <svg class="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                v-model="modtaleSearch"
                type="text"
                :placeholder="t('mods.searchModtale')"
                class="w-full pl-10 pr-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          <!-- Sort -->
          <select
            v-model="modtaleSort"
            class="px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-cyan-500"
          >
            <option value="downloads">{{ t('mods.sortDownloads') }}</option>
            <option value="updated">{{ t('mods.sortUpdated') }}</option>
            <option value="newest">{{ t('mods.sortNewest') }}</option>
            <option value="rating">{{ t('mods.sortRating') }}</option>
            <option value="relevance">{{ t('mods.sortRelevance') }}</option>
          </select>

          <!-- Classification Filter -->
          <select
            v-model="modtaleClassification"
            class="px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-cyan-500"
          >
            <option value="">{{ t('mods.allTypes') }}</option>
            <option value="PLUGIN">Plugins</option>
            <option value="DATA">Data Packs</option>
            <option value="ART">Art/Resources</option>
            <option value="SAVE">Saves</option>
            <option value="MODPACK">Modpacks</option>
          </select>
        </div>
      </Card>

      <!-- Modtale Results -->
      <Card :title="t('mods.modtaleResults')" :padding="false">
        <div v-if="modtaleLoading" class="text-center text-gray-500 p-8">
          <svg class="w-8 h-8 mx-auto animate-spin text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <p class="mt-2">{{ t('common.loading') }}</p>
        </div>

        <div v-else-if="modtaleMods.length === 0" class="text-center text-gray-500 p-8">
          <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {{ t('mods.noModtaleResults') }}
        </div>

        <div v-else class="divide-y divide-dark-50/30">
          <div
            v-for="mod in modtaleMods"
            :key="mod.id"
            class="flex items-center justify-between p-4 hover:bg-dark-50/20 transition-colors cursor-pointer"
            @click="openModtaleDetail(mod)"
          >
            <div class="flex items-center gap-4 flex-1 min-w-0">
              <!-- Image/Icon -->
              <div class="w-16 h-16 rounded-lg overflow-hidden bg-dark-100 shrink-0">
                <img
                  v-if="mod.imageUrl"
                  :src="mod.imageUrl"
                  :alt="mod.title"
                  class="w-full h-full object-cover"
                />
                <div v-else class="w-full h-full flex items-center justify-center">
                  <svg class="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
              </div>

              <!-- Info -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <p class="font-medium text-white truncate">{{ mod.title }}</p>
                  <span :class="['px-2 py-0.5 rounded text-xs', getClassificationColor(mod.classification)]">
                    {{ mod.classification }}
                  </span>
                  <span v-if="isModtaleInstalled(mod.id)" class="px-2 py-0.5 rounded text-xs bg-status-success/20 text-status-success">
                    {{ t('mods.installed') }} {{ getInstalledVersion(mod.id) }}
                  </span>
                  <span v-if="modtaleInstallSuccess === mod.id" class="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-400 animate-pulse">
                    {{ t('mods.installSuccess') }}
                  </span>
                </div>
                <p class="text-sm text-gray-400 mt-1 line-clamp-1">{{ mod.description }}</p>
                <div class="flex items-center gap-4 text-sm text-gray-500 mt-1">
                  <span>{{ mod.author }}</span>
                  <span class="flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {{ formatDownloads(mod.downloads) }}
                  </span>
                  <span v-if="mod.rating != null && mod.rating > 0" class="flex items-center gap-1">
                    <svg class="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    {{ mod.rating?.toFixed(1) || '0.0' }}
                  </span>
                  <div v-if="mod.tags?.length" class="flex gap-1 flex-wrap">
                    <span v-for="tag in mod.tags.slice(0, 3)" :key="tag" class="px-1.5 py-0.5 rounded text-xs bg-dark-100 text-gray-400">
                      {{ tag }}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-2 shrink-0 ml-4">
              <!-- Uninstall Button (if installed) -->
              <button
                v-if="isModtaleInstalled(mod.id) && authStore.hasPermission('mods.delete')"
                @click.stop="uninstallFromModtale(mod)"
                :disabled="modtaleUninstallingId === mod.id"
                class="px-4 py-2 bg-status-error/20 text-status-error font-medium rounded-lg hover:bg-status-error/30 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <svg v-if="modtaleUninstallingId === mod.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                {{ t('mods.uninstall') }}
              </button>
              <!-- Reinstall Button (if installed) -->
              <button
                v-if="isModtaleInstalled(mod.id) && authStore.hasPermission('mods.install')"
                @click.stop="installFromModtale(mod)"
                :disabled="modtaleInstallingId === mod.id"
                class="px-4 py-2 bg-hytale-orange/20 text-hytale-orange font-medium rounded-lg hover:bg-hytale-orange/30 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <svg v-if="modtaleInstallingId === mod.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {{ t('mods.update') }}
              </button>
              <!-- Install Button (if not installed) -->
              <button
                v-if="!isModtaleInstalled(mod.id) && authStore.hasPermission('mods.install')"
                @click.stop="installFromModtale(mod)"
                :disabled="modtaleInstallingId === mod.id"
                class="px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-medium rounded-lg hover:from-cyan-400 hover:to-blue-400 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <svg v-if="modtaleInstallingId === mod.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {{ modtaleInstallingId === mod.id ? t('mods.installing') : t('mods.install') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Pagination -->
        <div v-if="modtaleTotalPages > 1" class="flex items-center justify-center gap-2 p-4 border-t border-dark-50/30">
          <button
            @click="modtalePage = Math.max(0, modtalePage - 1)"
            :disabled="modtalePage === 0"
            class="px-3 py-1 bg-dark-100 rounded text-gray-400 hover:text-white disabled:opacity-50"
          >
            &larr;
          </button>
          <span class="text-gray-400">
            {{ modtalePage + 1 }} / {{ modtaleTotalPages }}
          </span>
          <button
            @click="modtalePage = Math.min(modtaleTotalPages - 1, modtalePage + 1)"
            :disabled="modtalePage >= modtaleTotalPages - 1"
            class="px-3 py-1 bg-dark-100 rounded text-gray-400 hover:text-white disabled:opacity-50"
          >
            &rarr;
          </button>
        </div>
      </Card>
    </template>

    <!-- Modtale Settings Modal -->
    <div v-if="showModtaleSettings" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-dark-200 rounded-xl w-full max-w-md">
        <div class="p-4 border-b border-dark-50/50 flex items-center justify-between">
          <h2 class="text-xl font-bold text-white">{{ t('mods.modtaleApiSettings') }}</h2>
          <button @click="showModtaleSettings = false" class="text-gray-400 hover:text-white">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="p-6 space-y-4">
          <div class="p-4 bg-dark-100 rounded-lg">
            <h3 class="font-medium text-white mb-2">{{ t('mods.apiStatus') }}</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-gray-400">{{ t('mods.statusLabel') }}:</span>
                <span :class="modtaleStatus?.apiAvailable ? 'text-green-400' : 'text-red-400'">
                  {{ modtaleStatus?.apiAvailable ? t('mods.online') : t('mods.offline') }}
                </span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">{{ t('mods.apiKeyLabel') }}:</span>
                <span :class="modtaleStatus?.hasApiKey ? 'text-green-400' : 'text-yellow-400'">
                  {{ modtaleStatus?.hasApiKey ? t('mods.configured') : t('mods.notConfigured') }}
                </span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">{{ t('mods.rateLimitLabel') }}:</span>
                <span class="text-cyan-400">
                  {{ modtaleStatus?.rateLimit?.limit || 10 }} req/min
                </span>
              </div>
            </div>
          </div>

          <div class="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
            <h3 class="font-medium text-blue-400 mb-2 flex items-center gap-2">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {{ t('mods.setupApiKey') }}
            </h3>
            <p class="text-sm text-gray-400 mb-3">
              {{ t('mods.apiKeyInstructions') }}
            </p>
            <ol class="text-sm text-gray-400 space-y-1 list-decimal list-inside mb-3">
              <li>{{ t('mods.apiKeyStep1') }} <a href="https://modtale.net" target="_blank" class="text-cyan-400 hover:underline">modtale.net</a></li>
              <li>{{ t('mods.apiKeyStep2') }}</li>
              <li>{{ t('mods.apiKeyStep3') }}</li>
              <li>{{ t('mods.apiKeyStep4') }}</li>
            </ol>
            <p class="text-sm text-gray-400">
              {{ t('mods.apiKeyEnvInstructions') }}
            </p>
            <code class="block mt-2 p-2 bg-dark-300 rounded text-sm text-green-400 font-mono">
              MODTALE_API_KEY=md_your_api_key_here
            </code>
          </div>

          <button
            @click="showModtaleSettings = false"
            class="w-full px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-medium rounded-lg hover:from-cyan-400 hover:to-blue-400 transition-colors"
          >
            {{ t('mods.close') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modtale Detail Modal -->
    <div v-if="showModtaleDetail" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-dark-200 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div class="p-4 border-b border-dark-50/50 flex items-center justify-between shrink-0">
          <h2 class="text-xl font-bold text-white">{{ modtaleDetailProject?.title || t('common.loading') }}</h2>
          <button @click="showModtaleDetail = false" class="text-gray-400 hover:text-white">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-6">
          <div v-if="modtaleDetailLoading" class="text-center text-gray-500 py-8">
            <svg class="w-8 h-8 mx-auto animate-spin text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </div>

          <template v-else-if="modtaleDetailProject">
            <div class="flex gap-6 mb-6">
              <!-- Image -->
              <div v-if="modtaleDetailProject.imageUrl" class="w-32 h-32 rounded-lg overflow-hidden shrink-0">
                <img :src="modtaleDetailProject.imageUrl" :alt="modtaleDetailProject.title" class="w-full h-full object-cover" />
              </div>

              <!-- Info -->
              <div class="flex-1">
                <div class="flex items-center gap-2 flex-wrap mb-2">
                  <span :class="['px-2 py-0.5 rounded text-xs', getClassificationColor(modtaleDetailProject.classification)]">
                    {{ modtaleDetailProject.classification }}
                  </span>
                  <span v-for="tag in (modtaleDetailProject.tags || [])" :key="tag" class="px-2 py-0.5 rounded text-xs bg-dark-100 text-gray-400">
                    {{ tag }}
                  </span>
                </div>
                <p class="text-gray-400 mb-2">{{ modtaleDetailProject.description }}</p>
                <div class="flex items-center gap-4 text-sm text-gray-500">
                  <span>{{ modtaleDetailProject.author }}</span>
                  <span class="flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {{ formatDownloads(modtaleDetailProject.downloads) }} {{ t('mods.sortDownloads') }}
                  </span>
                  <span v-if="modtaleDetailProject.rating != null && modtaleDetailProject.rating > 0" class="flex items-center gap-1">
                    <svg class="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    {{ modtaleDetailProject.rating?.toFixed(1) || '0.0' }}
                  </span>
                </div>
                <div v-if="modtaleDetailProject.repositoryUrl" class="mt-2">
                  <a :href="modtaleDetailProject.repositoryUrl" target="_blank" class="text-cyan-400 hover:underline text-sm">
                    {{ t('mods.repository') }}
                  </a>
                </div>
              </div>
            </div>

            <!-- Versions -->
            <div v-if="modtaleDetailProject.versions?.length" class="mb-6">
              <h3 class="font-semibold text-white mb-3">{{ t('mods.versions') }}</h3>
              <div class="space-y-2">
                <div
                  v-for="version in modtaleDetailProject.versions.slice(0, 5)"
                  :key="version.id"
                  class="flex items-center justify-between p-3 bg-dark-100 rounded-lg"
                >
                  <div>
                    <span class="text-white font-medium">{{ version.versionNumber }}</span>
                    <span v-if="version.channel && version.channel !== 'RELEASE'" class="ml-2 px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400">
                      {{ version.channel }}
                    </span>
                    <span v-if="version.gameVersions?.length" class="ml-2 text-sm text-gray-500">
                      ({{ version.gameVersions.join(', ') }})
                    </span>
                  </div>
                  <button
                    v-if="authStore.hasPermission('mods.install')"
                    @click="modtaleApi.install(modtaleDetailProject!.id, version.versionNumber).then(() => { loadData(); showModtaleDetail = false; })"
                    class="px-3 py-1 bg-cyan-500 text-white rounded hover:bg-cyan-400 transition-colors text-sm"
                  >
                    {{ t('mods.install') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Description -->
            <div v-if="modtaleDetailProject.about" class="prose prose-invert max-w-none">
              <h3 class="font-semibold text-white mb-3">{{ t('mods.description') }}</h3>
              <div class="text-gray-400 whitespace-pre-wrap">{{ modtaleDetailProject.about }}</div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- StackMart Section -->
    <template v-if="activeTab === 'stackmart'">
      <!-- StackMart Info Card with Settings Button -->
      <Card>
        <div class="flex items-start gap-4">
          <div class="p-3 bg-gradient-to-r from-amber-500/20 to-orange-500/20 rounded-lg">
            <svg class="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
            </svg>
          </div>
          <div class="flex-1">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <h3 class="font-semibold text-white">StackMart</h3>
                <a
                  href="https://stackmart.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-amber-400 hover:text-amber-300 transition-colors flex items-center gap-1 text-sm"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  stackmart.org
                </a>
              </div>
              <button
                @click="showStackMartSettings = true"
                class="px-3 py-1.5 bg-dark-100 text-gray-300 rounded-lg hover:bg-dark-50 transition-colors flex items-center gap-2 text-sm"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                API Key
              </button>
            </div>
            <p class="text-sm text-gray-400 mt-1">{{ t('mods.stackmartDescription') }}</p>
            <div class="flex items-center gap-4 mt-2 text-sm">
              <span v-if="stackmartStatus?.apiAvailable" class="flex items-center gap-1 text-green-400">
                <span class="w-2 h-2 bg-green-400 rounded-full"></span>
                {{ t('mods.apiOnline') }}
              </span>
              <span v-else class="flex items-center gap-1 text-red-400">
                <span class="w-2 h-2 bg-red-400 rounded-full"></span>
                {{ t('mods.apiOffline') }}
              </span>
              <span class="text-gray-500">
                {{ stackmartStatus?.rateLimit?.limit || 100 }} req/min
              </span>
              <span class="text-gray-500">
                {{ stackmartTotal }} {{ t('mods.resourcesFound') }}
              </span>
            </div>
          </div>
        </div>
      </Card>

      <!-- StackMart Search & Filter -->
      <Card>
        <div class="flex flex-wrap gap-4">
          <!-- Search Input -->
          <div class="flex-1 min-w-[200px]">
            <div class="relative">
              <svg class="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                v-model="stackmartSearch"
                type="text"
                :placeholder="t('mods.searchStackMart')"
                class="w-full pl-10 pr-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          <!-- Sort -->
          <select
            v-model="stackmartSort"
            class="px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-amber-500"
          >
            <option value="popular">{{ t('mods.sortPopular') }}</option>
            <option value="recent">{{ t('mods.sortRecent') }}</option>
            <option value="rated">{{ t('mods.sortRating') }}</option>
          </select>

          <!-- Category Filter -->
          <select
            v-model="stackmartCategory"
            class="px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-amber-500"
          >
            <option value="">{{ t('mods.allCategories') }}</option>
            <option value="plugins">Plugins</option>
            <option value="mods">Mods</option>
            <option value="scripts">Scripts</option>
            <option value="tools">Tools</option>
          </select>
        </div>
      </Card>

      <!-- StackMart Results -->
      <Card :title="t('mods.stackmartResults')" :padding="false">
        <div v-if="stackmartLoading" class="text-center text-gray-500 p-8">
          <svg class="w-8 h-8 mx-auto animate-spin text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <p class="mt-2">{{ t('common.loading') }}</p>
        </div>

        <div v-else-if="stackmartResources.length === 0" class="text-center text-gray-500 p-8">
          <svg class="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {{ t('mods.noStackMartResults') }}
        </div>

        <div v-else class="divide-y divide-dark-50/30">
          <div
            v-for="resource in stackmartResources"
            :key="resource.id"
            class="flex items-center justify-between p-4 hover:bg-dark-50/20 transition-colors cursor-pointer"
            @click="openStackMartDetail(resource)"
          >
            <div class="flex items-center gap-4 flex-1 min-w-0">
              <!-- Image/Icon -->
              <div class="w-16 h-16 rounded-lg overflow-hidden bg-dark-100 shrink-0">
                <img
                  v-if="resource.iconUrl"
                  :src="resource.iconUrl.startsWith('http') ? resource.iconUrl : `https://stackmart.org${resource.iconUrl}`"
                  :alt="resource.name"
                  class="w-full h-full object-cover"
                />
                <div v-else class="w-full h-full flex items-center justify-center">
                  <svg class="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
                  </svg>
                </div>
              </div>

              <!-- Info -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <p class="font-medium text-white truncate">{{ resource.name }}</p>
                  <span :class="['px-2 py-0.5 rounded text-xs', getStackMartCategoryColor(resource.category)]">
                    {{ resource.category }}
                  </span>
                  <span v-if="isStackMartInstalled(resource.id)" class="px-2 py-0.5 rounded text-xs bg-status-success/20 text-status-success">
                    {{ t('mods.installed') }} {{ getStackMartInstalledVersion(resource.id) }}
                  </span>
                  <span v-if="stackmartInstallSuccess === resource.id" class="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-400 animate-pulse">
                    {{ t('mods.installSuccess') }}
                  </span>
                </div>
                <p class="text-sm text-gray-400 mt-1 line-clamp-1">{{ resource.tagline }}</p>
                <div class="flex items-center gap-4 text-sm text-gray-500 mt-1">
                  <span>{{ resource.author }}</span>
                  <span class="flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {{ formatDownloads(resource.downloads) }}
                  </span>
                  <span v-if="resource.rating != null && resource.rating > 0" class="flex items-center gap-1">
                    <svg class="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    {{ resource.rating?.toFixed(1) || '0.0' }}
                  </span>
                  <span class="text-xs text-gray-600">v{{ resource.version }}</span>
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-2 shrink-0 ml-4">
              <!-- Uninstall Button (if installed) -->
              <button
                v-if="isStackMartInstalled(resource.id) && authStore.hasPermission('mods.delete')"
                @click.stop="uninstallFromStackMart(resource)"
                :disabled="stackmartUninstallingId === resource.id"
                class="px-4 py-2 bg-status-error/20 text-status-error font-medium rounded-lg hover:bg-status-error/30 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <svg v-if="stackmartUninstallingId === resource.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                {{ t('mods.uninstall') }}
              </button>
              <!-- Reinstall Button (if installed) -->
              <button
                v-if="isStackMartInstalled(resource.id) && authStore.hasPermission('mods.install')"
                @click.stop="installFromStackMart(resource)"
                :disabled="stackmartInstallingId === resource.id"
                class="px-4 py-2 bg-amber-500/20 text-amber-400 font-medium rounded-lg hover:bg-amber-500/30 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <svg v-if="stackmartInstallingId === resource.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {{ t('mods.update') }}
              </button>
              <!-- Install Button (if not installed) -->
              <button
                v-if="!isStackMartInstalled(resource.id) && authStore.hasPermission('mods.install')"
                @click.stop="installFromStackMart(resource)"
                :disabled="stackmartInstallingId === resource.id"
                class="px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-medium rounded-lg hover:from-amber-400 hover:to-orange-400 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <svg v-if="stackmartInstallingId === resource.id" class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {{ stackmartInstallingId === resource.id ? t('mods.installing') : t('mods.install') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Pagination -->
        <div v-if="stackmartTotalPages > 1" class="flex items-center justify-center gap-2 p-4 border-t border-dark-50/30">
          <button
            @click="stackmartPage = Math.max(1, stackmartPage - 1)"
            :disabled="stackmartPage === 1"
            class="px-3 py-1 bg-dark-100 rounded text-gray-400 hover:text-white disabled:opacity-50"
          >
            &larr;
          </button>
          <span class="text-gray-400">
            {{ stackmartPage }} / {{ stackmartTotalPages }}
          </span>
          <button
            @click="stackmartPage = Math.min(stackmartTotalPages, stackmartPage + 1)"
            :disabled="stackmartPage >= stackmartTotalPages"
            class="px-3 py-1 bg-dark-100 rounded text-gray-400 hover:text-white disabled:opacity-50"
          >
            &rarr;
          </button>
        </div>
      </Card>
    </template>

    <!-- StackMart Settings Modal -->
    <div v-if="showStackMartSettings" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-dark-200 rounded-xl w-full max-w-md">
        <div class="p-4 border-b border-dark-50/50 flex items-center justify-between">
          <h2 class="text-xl font-bold text-white">StackMart API Settings</h2>
          <button @click="showStackMartSettings = false" class="text-gray-400 hover:text-white">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="p-6 space-y-4">
          <div class="p-4 bg-dark-100 rounded-lg">
            <h3 class="font-medium text-white mb-2">{{ t('mods.apiStatus') }}</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-gray-400">{{ t('mods.statusLabel') }}:</span>
                <span :class="stackmartStatus?.apiAvailable ? 'text-green-400' : 'text-red-400'">
                  {{ stackmartStatus?.apiAvailable ? t('mods.online') : t('mods.offline') }}
                </span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">{{ t('mods.apiKeyLabel') }}:</span>
                <span :class="stackmartStatus?.hasApiKey ? 'text-green-400' : 'text-yellow-400'">
                  {{ stackmartStatus?.hasApiKey ? t('mods.configured') : t('mods.notConfigured') }}
                </span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">{{ t('mods.rateLimitLabel') }}:</span>
                <span class="text-amber-400">
                  {{ stackmartStatus?.rateLimit?.limit || 100 }} req/min
                </span>
              </div>
            </div>
          </div>

          <div class="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <h3 class="font-medium text-amber-400 mb-2 flex items-center gap-2">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {{ t('mods.setupApiKey') }}
            </h3>
            <p class="text-sm text-gray-400 mb-3">
              {{ t('mods.stackmartApiKeyInstructions') }}
            </p>
            <ol class="text-sm text-gray-400 space-y-1 list-decimal list-inside mb-3">
              <li>{{ t('mods.stackmartApiKeyStep1') }} <a href="https://stackmart.org" target="_blank" class="text-amber-400 hover:underline">stackmart.org</a></li>
              <li>{{ t('mods.stackmartApiKeyStep2') }}</li>
              <li>{{ t('mods.stackmartApiKeyStep3') }}</li>
            </ol>
            <code class="block mt-2 p-2 bg-dark-300 rounded text-sm text-green-400 font-mono">
              STACKMART_API_KEY=sm_pub_your_key_here
            </code>
          </div>

          <button
            @click="showStackMartSettings = false"
            class="w-full px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-medium rounded-lg hover:from-amber-400 hover:to-orange-400 transition-colors"
          >
            {{ t('mods.close') }}
          </button>
        </div>
      </div>
    </div>

    <!-- StackMart Detail Modal -->
    <div v-if="showStackMartDetail" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-dark-200 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div class="p-4 border-b border-dark-50/50 flex items-center justify-between shrink-0">
          <h2 class="text-xl font-bold text-white">{{ stackmartDetailResource?.name || t('common.loading') }}</h2>
          <button @click="showStackMartDetail = false" class="text-gray-400 hover:text-white">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-6">
          <div v-if="stackmartDetailLoading" class="text-center text-gray-500 py-8">
            <svg class="w-8 h-8 mx-auto animate-spin text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </div>

          <template v-else-if="stackmartDetailResource">
            <div class="flex gap-6 mb-6">
              <!-- Image -->
              <div v-if="stackmartDetailResource.iconUrl" class="w-32 h-32 rounded-lg overflow-hidden shrink-0">
                <img
                  :src="stackmartDetailResource.iconUrl.startsWith('http') ? stackmartDetailResource.iconUrl : `https://stackmart.org${stackmartDetailResource.iconUrl}`"
                  :alt="stackmartDetailResource.name"
                  class="w-full h-full object-cover"
                />
              </div>

              <!-- Info -->
              <div class="flex-1">
                <div class="flex items-center gap-2 flex-wrap mb-2">
                  <span :class="['px-2 py-0.5 rounded text-xs', getStackMartCategoryColor(stackmartDetailResource.category)]">
                    {{ stackmartDetailResource.category }}
                  </span>
                  <span v-for="tag in (stackmartDetailResource.tags || [])" :key="tag" class="px-2 py-0.5 rounded text-xs bg-dark-100 text-gray-400">
                    {{ tag }}
                  </span>
                </div>
                <p class="text-gray-400 mb-2">{{ stackmartDetailResource.tagline }}</p>
                <div class="flex items-center gap-4 text-sm text-gray-500">
                  <span>{{ stackmartDetailResource.author }}</span>
                  <span class="flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {{ formatDownloads(stackmartDetailResource.downloads) }} Downloads
                  </span>
                  <span v-if="stackmartDetailResource.rating != null && stackmartDetailResource.rating > 0" class="flex items-center gap-1">
                    <svg class="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    {{ stackmartDetailResource.rating?.toFixed(1) || '0.0' }}
                  </span>
                  <span class="text-xs">v{{ stackmartDetailResource.version }}</span>
                </div>
                <div class="flex gap-3 mt-3">
                  <a v-if="stackmartDetailResource.supportUrl" :href="stackmartDetailResource.supportUrl" target="_blank" class="text-amber-400 hover:underline text-sm">
                    Support
                  </a>
                  <a v-if="stackmartDetailResource.documentationUrl" :href="stackmartDetailResource.documentationUrl" target="_blank" class="text-amber-400 hover:underline text-sm">
                    Documentation
                  </a>
                </div>
              </div>
            </div>

            <!-- Features -->
            <div v-if="stackmartDetailResource.features?.length" class="mb-6">
              <h3 class="font-semibold text-white mb-3">Features</h3>
              <ul class="list-disc list-inside text-gray-400 space-y-1">
                <li v-for="feature in stackmartDetailResource.features" :key="feature">{{ feature }}</li>
              </ul>
            </div>

            <!-- Description -->
            <div v-if="stackmartDetailResource.description" class="mb-6">
              <h3 class="font-semibold text-white mb-3">{{ t('mods.description') }}</h3>
              <div class="text-gray-400 whitespace-pre-wrap">{{ stackmartDetailResource.description }}</div>
            </div>

            <!-- Install Button -->
            <div v-if="authStore.hasPermission('mods.install')" class="flex justify-end">
              <button
                @click="installFromStackMart(stackmartDetailResource); showStackMartDetail = false;"
                class="px-6 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-medium rounded-lg hover:from-amber-400 hover:to-orange-400 transition-colors flex items-center gap-2"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {{ t('mods.install') }} v{{ stackmartDetailResource.version }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Config Editor Modal -->
    <div v-if="showConfigModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-dark-200 rounded-xl w-full max-w-7xl h-[85vh] flex flex-col">
        <!-- Modal Header -->
        <div class="p-4 border-b border-dark-50/50 flex items-center justify-between shrink-0">
          <h2 class="text-xl font-bold text-white">{{ t('mods.configEditor') }}: {{ editingItem?.name }}</h2>
          <button @click="showConfigModal = false" class="text-gray-400 hover:text-white">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Modal Content -->
        <div class="flex-1 flex overflow-hidden min-h-0">
          <!-- Config Files List -->
          <div class="w-80 border-r border-dark-50/50 overflow-y-auto p-4 shrink-0">
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
                <div class="font-medium">{{ config.name }}</div>
                <div class="text-xs text-gray-500 truncate mt-0.5">{{ config.path }}</div>
              </button>
            </div>
          </div>

          <!-- Config Editor -->
          <div class="flex-1 flex flex-col p-4 min-w-0">
            <div v-if="!selectedConfig" class="flex-1 flex items-center justify-center text-gray-500">
              {{ t('mods.selectConfig') }}
            </div>
            <template v-else>
              <div class="flex items-center justify-between mb-3 shrink-0">
                <span class="text-sm text-gray-400 truncate mr-4">{{ selectedConfig.path }}</span>
                <div class="flex items-center gap-3 shrink-0">
                  <!-- Success indicator -->
                  <span
                    v-if="configSaveSuccess"
                    class="flex items-center gap-1.5 text-green-400 text-sm animate-fade-in"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                    </svg>
                    {{ t('config.saved') }}
                  </span>
                  <button
                    @click="saveConfigFile"
                    :disabled="configSaving"
                    class="px-4 py-1.5 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors text-sm disabled:opacity-50"
                  >
                    {{ configSaving ? t('common.saving') : t('common.save') }}
                  </button>
                </div>
              </div>
              <div v-if="configLoading" class="flex-1 flex items-center justify-center text-gray-500">
                {{ t('common.loading') }}
              </div>
              <textarea
                v-else
                v-model="configContent"
                class="flex-1 w-full p-4 bg-dark-300 border border-dark-50 rounded-lg text-white font-mono text-sm resize-none focus:outline-none focus:border-hytale-orange min-h-[400px]"
                spellcheck="false"
              />
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
