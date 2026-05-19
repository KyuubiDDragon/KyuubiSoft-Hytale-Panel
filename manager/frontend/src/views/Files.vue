<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, shallowRef, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  filesApi,
  detectLanguage,
  formatBytes,
  type FileRoot,
  type FileEntry,
} from '@/api/files'
import TreeItem, { type TreeNode } from '@/components/files/TreeItem.vue'

// Monaco is imported dynamically (large bundle)
type MonacoModule = typeof import('monaco-editor')
type MonacoEditor = ReturnType<MonacoModule['editor']['create']>

const { t } = useI18n()

// ---------- State ---------------------------------------------------------

const roots = ref<FileRoot[]>([])
const activeRootId = ref<string>('')
const activeRoot = computed(() => roots.value.find((r) => r.id === activeRootId.value) || null)
const isReadOnly = computed(() => !activeRoot.value?.rw)

const rootNodes = ref<TreeNode[]>([])
const selectedPath = ref<string>('')
const searchTerm = ref('')

const fileContent = ref<string>('')
const fileMtimeMs = ref<number>(0)
const fileIsBinary = ref(false)
const fileSize = ref(0)
const originalContent = ref('')
const isModified = computed(() => fileContent.value !== originalContent.value)

const loadingTree = ref(false)
const loadingFile = ref(false)
const saving = ref(false)
const errorMsg = ref('')
const successMsg = ref('')

const fileInputRef = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)
const showConflictDialog = ref(false)

const editorContainer = ref<HTMLElement | null>(null)
const monacoRef = shallowRef<MonacoModule | null>(null)
const editorRef = shallowRef<MonacoEditor | null>(null)

// ---------- Monaco loader ------------------------------------------------

let monacoLoadPromise: Promise<MonacoModule> | null = null

function loadMonaco(): Promise<MonacoModule> {
  if (!monacoLoadPromise) {
    monacoLoadPromise = (async () => {
      const mod = await import('monaco-editor/esm/vs/editor/editor.api')
      // Minimal worker: keeps the bundle small (no language-server workers).
      ;(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
        getWorker: () => {
          const blob = new Blob(
            ["self.onmessage = function() {};"],
            { type: 'application/javascript' },
          )
          return new Worker(URL.createObjectURL(blob))
        },
      }
      monacoRef.value = mod as unknown as MonacoModule
      return mod as unknown as MonacoModule
    })()
  }
  return monacoLoadPromise
}

async function ensureEditor() {
  if (!editorContainer.value) return
  const monaco = await loadMonaco()
  if (editorRef.value) return
  editorRef.value = monaco.editor.create(editorContainer.value, {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 2,
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    readOnly: isReadOnly.value,
  })
  editorRef.value.onDidChangeModelContent(() => {
    fileContent.value = editorRef.value?.getValue() ?? ''
  })
  editorRef.value.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
    () => saveFile(),
  )
}

function disposeEditor() {
  if (editorRef.value) {
    editorRef.value.dispose()
    editorRef.value = null
  }
}

// ---------- Tree / browsing ---------------------------------------------

function makeNode(e: FileEntry): TreeNode {
  return { ...e, expanded: false, loaded: false, loading: false, children: [] }
}

async function loadRoots() {
  try {
    roots.value = await filesApi.listRoots()
    if (roots.value.length > 0 && !activeRootId.value) {
      activeRootId.value = roots.value[0].id
    }
  } catch (e) {
    errorMsg.value = t('files.error.loadRoots')
  }
}

async function loadRootTree() {
  if (!activeRootId.value) return
  loadingTree.value = true
  rootNodes.value = []
  selectedPath.value = ''
  resetEditor()
  try {
    const res = await filesApi.list(activeRootId.value, '')
    rootNodes.value = res.entries.map(makeNode)
  } catch (e: unknown) {
    errorMsg.value = errorFromUnknown(e, t('files.error.loadDir'))
  } finally {
    loadingTree.value = false
  }
}

async function toggleNode(node: TreeNode) {
  if (node.type !== 'directory') return
  if (node.expanded) {
    node.expanded = false
    return
  }
  if (!node.loaded) {
    node.loading = true
    try {
      const res = await filesApi.list(activeRootId.value, node.path)
      node.children = res.entries.map(makeNode)
      node.loaded = true
    } catch (e: unknown) {
      errorMsg.value = errorFromUnknown(e, t('files.error.loadDir'))
    } finally {
      node.loading = false
    }
  }
  node.expanded = true
}

async function selectFile(node: TreeNode) {
  if (node.type !== 'file') {
    toggleNode(node)
    return
  }
  if (isModified.value) {
    if (!confirm(t('files.confirm.discardChanges'))) return
  }
  loadingFile.value = true
  errorMsg.value = ''
  selectedPath.value = node.path
  try {
    const res = await filesApi.read(activeRootId.value, node.path)
    fileIsBinary.value = res.isBinary
    fileSize.value = res.size
    fileMtimeMs.value = res.mtimeMs
    if (res.isBinary) {
      fileContent.value = ''
      originalContent.value = ''
    } else {
      fileContent.value = res.content
      originalContent.value = res.content
      await nextTick()
      await ensureEditor()
      if (editorRef.value && monacoRef.value) {
        const lang = detectLanguage(node.name)
        const model = editorRef.value.getModel()
        if (model) {
          monacoRef.value.editor.setModelLanguage(model, lang)
        }
        editorRef.value.setValue(res.content)
        editorRef.value.updateOptions({ readOnly: isReadOnly.value })
      }
    }
  } catch (e: unknown) {
    errorMsg.value = errorFromUnknown(e, t('files.error.loadFile'))
  } finally {
    loadingFile.value = false
  }
}

function resetEditor() {
  selectedPath.value = ''
  fileContent.value = ''
  originalContent.value = ''
  fileMtimeMs.value = 0
  fileIsBinary.value = false
  if (editorRef.value) editorRef.value.setValue('')
}

// ---------- Save / conflict ---------------------------------------------

async function saveFile() {
  if (!selectedPath.value || isReadOnly.value || fileIsBinary.value) return
  saving.value = true
  errorMsg.value = ''
  successMsg.value = ''
  try {
    const res = await filesApi.write({
      rootId: activeRootId.value,
      path: selectedPath.value,
      content: fileContent.value,
      encoding: 'utf-8',
      ifMatchMtime: fileMtimeMs.value,
    })
    fileMtimeMs.value = res.mtimeMs
    originalContent.value = fileContent.value
    successMsg.value = t('files.success.saved')
    setTimeout(() => (successMsg.value = ''), 3000)
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: { error?: string; code?: string } } }
    if (err.response?.status === 409) {
      showConflictDialog.value = true
    } else {
      errorMsg.value = errorFromUnknown(e, t('files.error.save'))
    }
  } finally {
    saving.value = false
  }
}

async function reloadAfterConflict() {
  showConflictDialog.value = false
  const path = selectedPath.value
  if (!path) return
  const node = findNodeByPath(rootNodes.value, path)
  if (node) {
    originalContent.value = ''
    fileContent.value = ''
    await selectFile(node)
  }
}

function findNodeByPath(list: TreeNode[], path: string): TreeNode | null {
  for (const n of list) {
    if (n.path === path) return n
    if (n.children.length > 0) {
      const r = findNodeByPath(n.children, path)
      if (r) return r
    }
  }
  return null
}

// ---------- Upload / Delete / Move / Download ---------------------------

async function refreshActiveDir() {
  await loadRootTree()
}

function triggerUpload() {
  fileInputRef.value?.click()
}

async function handleFileUpload(files: FileList | null, targetDir = '') {
  if (!files || files.length === 0) return
  if (isReadOnly.value) return
  errorMsg.value = ''
  for (const file of Array.from(files)) {
    try {
      await filesApi.upload(activeRootId.value, targetDir, file)
    } catch (e: unknown) {
      errorMsg.value = errorFromUnknown(e, t('files.error.upload'))
      break
    }
  }
  await refreshActiveDir()
  successMsg.value = t('files.success.uploaded')
  setTimeout(() => (successMsg.value = ''), 3000)
}

function onFileInputChange(ev: Event) {
  const target = ev.target as HTMLInputElement
  handleFileUpload(target.files)
  target.value = ''
}

function onDrop(ev: DragEvent) {
  ev.preventDefault()
  dragActive.value = false
  if (isReadOnly.value) return
  const files = ev.dataTransfer?.files
  if (files) handleFileUpload(files)
}

function onDragOver(ev: DragEvent) {
  ev.preventDefault()
  if (!isReadOnly.value) dragActive.value = true
}

function onDragLeave() {
  dragActive.value = false
}

async function deleteSelected() {
  if (!selectedPath.value || isReadOnly.value) return
  if (!confirm(t('files.confirm.delete', { path: selectedPath.value }))) return
  try {
    await filesApi.remove(activeRootId.value, selectedPath.value, 'confirmed')
    successMsg.value = t('files.success.deleted')
    setTimeout(() => (successMsg.value = ''), 3000)
    resetEditor()
    await loadRootTree()
  } catch (e: unknown) {
    errorMsg.value = errorFromUnknown(e, t('files.error.delete'))
  }
}

async function moveSelected() {
  if (!selectedPath.value || isReadOnly.value) return
  const to = prompt(t('files.prompt.move'), selectedPath.value)
  if (!to || to === selectedPath.value) return
  try {
    await filesApi.move(activeRootId.value, selectedPath.value, to)
    successMsg.value = t('files.success.moved')
    setTimeout(() => (successMsg.value = ''), 3000)
    resetEditor()
    await loadRootTree()
  } catch (e: unknown) {
    errorMsg.value = errorFromUnknown(e, t('files.error.move'))
  }
}

function downloadSelected() {
  if (!selectedPath.value) return
  window.open(filesApi.getDownloadUrl(activeRootId.value, selectedPath.value), '_blank')
}

// ---------- Search filter -----------------------------------------------

const filteredTree = computed<TreeNode[]>(() => {
  const term = searchTerm.value.trim().toLowerCase()
  if (!term) return rootNodes.value
  return filterTree(rootNodes.value, term)
})

function filterTree(nodes: TreeNode[], term: string): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    const childMatches = node.children.length > 0 ? filterTree(node.children, term) : []
    const nameMatch = node.name.toLowerCase().includes(term)
    if (nameMatch || childMatches.length > 0) {
      result.push({
        ...node,
        expanded: true,
        children: childMatches.length > 0 ? childMatches : node.children,
      })
    }
  }
  return result
}

// ---------- Utilities ----------------------------------------------------

function errorFromUnknown(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: { error?: string; code?: string } } }
  return err.response?.data?.error || fallback
}

function iconFor(node: TreeNode): string {
  if (node.type === 'directory') return node.expanded ? 'folder-open' : 'folder'
  const ext = node.name.toLowerCase().split('.').pop() || ''
  if (['json', 'yaml', 'yml', 'xml'].includes(ext)) return 'json'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'image'
  if (['lua', 'js', 'ts', 'sh', 'py'].includes(ext)) return 'code'
  return 'file'
}

// ---------- Lifecycle ----------------------------------------------------

watch(activeRootId, () => {
  loadRootTree()
})

onMounted(async () => {
  await loadRoots()
  await loadRootTree()
})

onBeforeUnmount(() => {
  disposeEditor()
})
</script>

<template>
  <div class="h-[calc(100vh-4rem)] flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-dark-50/50 px-6 py-3">
      <div>
        <h1 class="text-lg font-semibold text-white">{{ t('files.title') }}</h1>
        <p class="text-xs text-gray-400">{{ t('files.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <select
          v-model="activeRootId"
          class="bg-dark-100 border border-dark-50 text-sm text-white rounded px-2 py-1"
        >
          <option v-for="r in roots" :key="r.id" :value="r.id">
            {{ r.label }} {{ r.rw ? '' : '(RO)' }}
          </option>
        </select>
        <button class="btn-secondary text-sm" :title="t('common.refresh')" @click="refreshActiveDir">
          {{ t('common.refresh') }}
        </button>
        <button
          class="btn-secondary text-sm"
          :disabled="isReadOnly"
          :title="t('files.upload')"
          @click="triggerUpload"
        >
          {{ t('files.upload') }}
        </button>
        <input ref="fileInputRef" type="file" multiple class="hidden" @change="onFileInputChange" />
      </div>
    </div>

    <!-- Messages -->
    <div v-if="errorMsg" class="px-6 py-2 bg-red-500/10 text-red-300 text-sm border-b border-red-500/30">
      {{ errorMsg }}
    </div>
    <div v-if="successMsg" class="px-6 py-2 bg-green-500/10 text-green-300 text-sm border-b border-green-500/30">
      {{ successMsg }}
    </div>

    <!-- Main layout -->
    <div class="flex-1 flex min-h-0">
      <!-- Tree -->
      <aside
        class="w-80 border-r border-dark-50/50 bg-dark-200/40 flex flex-col"
        :class="dragActive ? 'ring-2 ring-hytale-orange' : ''"
        @drop="onDrop"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
      >
        <div class="p-3 border-b border-dark-50/50">
          <input
            v-model="searchTerm"
            type="text"
            :placeholder="t('common.search')"
            class="w-full bg-dark-100 border border-dark-50 text-sm text-white rounded px-2 py-1"
          />
        </div>
        <div class="flex-1 overflow-y-auto p-2 text-sm">
          <div v-if="loadingTree" class="text-gray-400 p-3">{{ t('common.loading') }}</div>
          <div v-else-if="filteredTree.length === 0" class="text-gray-500 p-3">
            {{ t('files.empty.dir') }}
          </div>
          <ul v-else class="space-y-0.5">
            <TreeItem
              v-for="n in filteredTree"
              :key="n.path"
              :node="n"
              :selected="selectedPath"
              :depth="0"
              :icon-for="iconFor"
              @toggle="toggleNode"
              @select="selectFile"
            />
          </ul>
        </div>
        <div v-if="isReadOnly" class="p-2 text-xs text-amber-400 border-t border-dark-50/50 bg-amber-500/5">
          {{ t('files.readonlyHint') }}
        </div>
      </aside>

      <!-- Editor / Empty state -->
      <section class="flex-1 flex flex-col min-w-0">
        <!-- Toolbar -->
        <div
          v-if="selectedPath"
          class="flex items-center justify-between px-4 py-2 border-b border-dark-50/50 bg-dark-100/30"
        >
          <div class="flex items-center gap-3 min-w-0">
            <span class="text-sm text-gray-300 truncate" :title="selectedPath">{{ selectedPath }}</span>
            <span v-if="isModified" class="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">
              {{ t('files.modified') }}
            </span>
            <span v-if="fileIsBinary" class="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-300">
              {{ t('files.binary') }}
            </span>
            <span class="text-xs text-gray-500">{{ formatBytes(fileSize) }}</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="btn-primary text-sm"
              :disabled="!isModified || isReadOnly || saving || fileIsBinary"
              @click="saveFile"
            >
              {{ saving ? t('common.saving') : t('common.save') }}
            </button>
            <button class="btn-secondary text-sm" @click="downloadSelected">
              {{ t('common.download') }}
            </button>
            <button
              class="btn-secondary text-sm"
              :disabled="isReadOnly"
              @click="moveSelected"
            >
              {{ t('files.move') }}
            </button>
            <button
              class="btn-danger text-sm"
              :disabled="isReadOnly"
              @click="deleteSelected"
            >
              {{ t('common.delete') }}
            </button>
          </div>
        </div>

        <!-- Empty state -->
        <div
          v-if="!selectedPath"
          class="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm"
        >
          <p class="text-base font-medium mb-1">{{ t('files.empty.title') }}</p>
          <p>{{ t('files.empty.subtitle') }}</p>
        </div>

        <!-- Binary preview -->
        <div v-else-if="fileIsBinary" class="flex-1 flex items-center justify-center text-gray-400 text-sm p-6">
          {{ t('files.binaryHint') }}
        </div>

        <!-- Monaco editor container -->
        <div
          v-else
          ref="editorContainer"
          class="flex-1 min-h-0"
        ></div>
      </section>
    </div>

    <!-- Conflict dialog -->
    <div
      v-if="showConflictDialog"
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
    >
      <div class="bg-dark-100 rounded-lg p-6 max-w-md w-full mx-4 border border-dark-50">
        <h3 class="text-lg font-semibold text-white mb-2">{{ t('files.conflict.title') }}</h3>
        <p class="text-sm text-gray-300 mb-4">{{ t('files.conflict.message') }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn-secondary text-sm" @click="showConflictDialog = false">
            {{ t('common.cancel') }}
          </button>
          <button class="btn-primary text-sm" @click="reloadAfterConflict">
            {{ t('files.conflict.reload') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
