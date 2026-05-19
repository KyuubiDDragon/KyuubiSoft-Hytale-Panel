<script setup lang="ts">
/**
 * Auto-generated mod/plugin wiki.
 *
 * Markdown is rendered by a tiny in-house renderer so we avoid pulling in
 * `marked` + `dompurify`. All user/manifest-supplied strings are escaped
 * before being inserted into innerHTML.
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import { useAuthStore } from '@/stores/auth'

interface WikiEntry {
  slug: string
  name: string
  description?: string
  author?: string
  version?: string
  category: string
  commands: string[]
  source: 'mod' | 'plugin'
  fileName: string
}

interface WikiIndex {
  generatedAt: string
  entries: WikiEntry[]
}

interface WikiPage {
  entry: WikiEntry
  markdown: string
}

interface WikiConfig {
  publicAccess: boolean
}

const { t } = useI18n()
const authStore = useAuthStore()

const index = ref<WikiIndex | null>(null)
const selected = ref<WikiPage | null>(null)
const loading = ref(false)
const regenerating = ref(false)
const cfg = ref<WikiConfig>({ publicAccess: false })
const message = ref('')

const canManage = computed(() => authStore.hasPermission('wiki.manage'))

const grouped = computed(() => {
  const out = new Map<string, WikiEntry[]>()
  for (const e of index.value?.entries ?? []) {
    const arr = out.get(e.category) ?? []
    arr.push(e)
    out.set(e.category, arr)
  }
  return Array.from(out.entries()).sort(([a], [b]) => a.localeCompare(b))
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Minimal markdown -> HTML for headings, code, lists, bold/italic, paragraphs.
// Block-level scanner; keeps the surface area tiny so we don't need a sanitiser.
function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inCode = false
  let codeBuf: string[] = []
  let listBuf: string[] = []
  const flushList = () => {
    if (listBuf.length > 0) {
      out.push('<ul class="list-disc pl-6 my-2 text-gray-300">' + listBuf.map((l) => `<li>${renderInline(l)}</li>`).join('') + '</ul>')
      listBuf = []
    }
  }
  for (const rawLine of lines) {
    if (inCode) {
      if (rawLine.startsWith('```')) {
        out.push(`<pre class="bg-dark-300 rounded p-3 my-2 text-xs text-gray-200 overflow-auto"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
        inCode = false
        codeBuf = []
      } else {
        codeBuf.push(rawLine)
      }
      continue
    }
    if (rawLine.startsWith('```')) {
      flushList()
      inCode = true
      codeBuf = []
      continue
    }
    if (rawLine.startsWith('# ')) {
      flushList()
      out.push(`<h1 class="text-2xl font-bold text-white mt-4 mb-2">${renderInline(rawLine.slice(2))}</h1>`)
    } else if (rawLine.startsWith('## ')) {
      flushList()
      out.push(`<h2 class="text-xl font-semibold text-white mt-4 mb-2">${renderInline(rawLine.slice(3))}</h2>`)
    } else if (rawLine.startsWith('### ')) {
      flushList()
      out.push(`<h3 class="text-lg font-semibold text-gray-100 mt-3 mb-1">${renderInline(rawLine.slice(4))}</h3>`)
    } else if (rawLine.startsWith('- ')) {
      listBuf.push(rawLine.slice(2))
    } else if (rawLine.trim() === '') {
      flushList()
      out.push('')
    } else {
      flushList()
      out.push(`<p class="my-2 text-gray-300">${renderInline(rawLine)}</p>`)
    }
  }
  flushList()
  return out.join('\n')
}

function renderInline(s: string): string {
  let h = escapeHtml(s)
  // `inline code`
  h = h.replace(/`([^`]+)`/g, '<code class="bg-dark-300 px-1 rounded text-hytale-orange text-sm">$1</code>')
  // **bold**
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-white">$1</strong>')
  // *italic*
  h = h.replace(/(^|[\s_])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return h
}

async function loadIndex() {
  loading.value = true
  try {
    const { data } = await api.get<WikiIndex>('/wiki')
    index.value = data
    // Auto-select first entry if any
    if (data.entries.length > 0 && !selected.value) {
      await select(data.entries[0])
    }
  } finally {
    loading.value = false
  }
}

async function loadConfig() {
  try {
    const { data } = await api.get<WikiConfig>('/wiki/config')
    cfg.value = data
  } catch { /* not allowed when read-only — that's fine */ }
}

async function select(entry: WikiEntry) {
  try {
    const { data } = await api.get<WikiPage>(`/wiki/${entry.slug}`)
    selected.value = data
  } catch (err) {
    console.error('[wiki] load page failed', err)
  }
}

async function regenerate() {
  regenerating.value = true
  message.value = ''
  try {
    const { data } = await api.post<{ count: number; generatedAt: string }>('/wiki/regenerate')
    message.value = t('wiki.regenerated', { n: data.count })
    await loadIndex()
  } catch (err) {
    console.error('[wiki] regenerate failed', err)
  } finally {
    regenerating.value = false
  }
}

async function togglePublic() {
  cfg.value.publicAccess = !cfg.value.publicAccess
  await api.put('/wiki/config', cfg.value)
}

onMounted(async () => {
  await loadIndex()
  if (canManage.value) await loadConfig()
})
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex items-center justify-between mb-4 shrink-0">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('wiki.title') }}</h1>
        <p class="text-gray-400 text-sm mt-1">{{ t('wiki.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <label v-if="canManage" class="flex items-center gap-2 text-sm text-gray-300">
          <input :checked="cfg.publicAccess" @change="togglePublic" type="checkbox" class="accent-hytale-orange" />
          {{ t('wiki.publicAccess') }}
        </label>
        <button
          v-if="canManage"
          @click="regenerate"
          :disabled="regenerating"
          class="px-3 py-1.5 bg-hytale-orange text-dark font-medium rounded-lg disabled:opacity-50"
        >
          {{ regenerating ? t('wiki.regenerating') : t('wiki.regenerate') }}
        </button>
      </div>
    </div>

    <div v-if="message" class="bg-green-500/10 text-green-300 text-sm rounded px-3 py-2 mb-3">{{ message }}</div>
    <p v-if="canManage" class="text-xs text-gray-500 mb-3">{{ t('wiki.publicHint') }}</p>

    <div class="flex-1 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 min-h-0">
      <!-- Index sidebar -->
      <div class="bg-dark-200 rounded-xl p-3 overflow-auto">
        <div v-if="loading" class="text-gray-500 text-sm">{{ t('common.loading') }}</div>
        <div v-else-if="(index?.entries.length ?? 0) === 0" class="text-gray-500 text-sm">{{ t('wiki.noEntries') }}</div>
        <div v-else>
          <div v-for="[cat, entries] in grouped" :key="cat" class="mb-3">
            <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">{{ cat }}</p>
            <button
              v-for="e in entries"
              :key="e.slug"
              @click="select(e)"
              :class="['block w-full text-left px-2 py-1 rounded text-sm', selected?.entry.slug === e.slug ? 'bg-dark-100 text-white' : 'text-gray-300 hover:bg-dark-100']"
            >
              {{ e.name }}
              <span v-if="e.version" class="text-gray-500 text-xs ml-1">v{{ e.version }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Markdown body -->
      <div class="bg-dark-200 rounded-xl p-6 overflow-auto">
        <div v-if="!selected" class="text-gray-500 text-sm">{{ t('wiki.selectEntry') }}</div>
        <div v-else>
          <div class="prose-wiki" v-html="renderMarkdown(selected.markdown)"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prose-wiki :deep(a) { color: #f97316; }
</style>
