<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import api from '@/api/client'

interface Command {
  id: string
  title: string
  hint?: string
  group: 'Action' | 'Navigation' | 'Theme'
  run: () => void | Promise<void>
}

const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()
const themeStore = useThemeStore()

const open = ref(false)
const query = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const selectedIndex = ref(0)

function close() {
  open.value = false
  query.value = ''
  selectedIndex.value = 0
}

// Navigation entries derive from the existing router so we don't keep a
// second list in sync. Filter routes that have a title and need auth.
const navigationCommands = computed<Command[]>(() => {
  const routes = router.getRoutes()
  return routes
    .filter(r => !!r.name && !r.path.includes(':') && r.path !== '/' && r.path !== '/login' && r.path !== '/setup')
    .map(r => ({
      id: `nav:${String(r.name)}`,
      title: String(r.name).charAt(0).toUpperCase() + String(r.name).slice(1),
      hint: r.path,
      group: 'Navigation' as const,
      run: () => { void router.push(r.path) },
    }))
})

// Quick actions hit the existing backend endpoints. We don't surface ones
// the user isn't allowed to call.
const actionCommands = computed<Command[]>(() => {
  const c: Command[] = []
  if (authStore.hasPermission('server.start')) {
    c.push({
      id: 'action:start', title: t('cmd.startServer', 'Start server'),
      group: 'Action', run: () => api.post('/server/start'),
    })
  }
  if (authStore.hasPermission('server.stop')) {
    c.push({
      id: 'action:stop', title: t('cmd.stopServer', 'Stop server'),
      group: 'Action', run: () => api.post('/server/stop'),
    })
  }
  if (authStore.hasPermission('server.restart')) {
    c.push({
      id: 'action:restart', title: t('cmd.restartServer', 'Restart server'),
      group: 'Action', run: () => api.post('/server/restart'),
    })
  }
  if (authStore.hasPermission('backups.create')) {
    c.push({
      id: 'action:backup', title: t('cmd.createBackup', 'Create backup'),
      group: 'Action', run: () => api.post('/backups'),
    })
  }
  return c
})

const themeCommands = computed<Command[]>(() => [{
  id: 'theme:toggle',
  title: themeStore.theme === 'dark' ? t('cmd.lightMode', 'Switch to light mode') : t('cmd.darkMode', 'Switch to dark mode'),
  group: 'Theme',
  run: () => themeStore.toggle(),
}])

const allCommands = computed<Command[]>(() => [
  ...actionCommands.value,
  ...themeCommands.value,
  ...navigationCommands.value,
])

const results = computed<Command[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return allCommands.value.slice(0, 20)
  return allCommands.value
    .filter(c => c.title.toLowerCase().includes(q) || (c.hint?.toLowerCase().includes(q) ?? false))
    .slice(0, 30)
})

watch(results, () => { selectedIndex.value = 0 })

async function runSelected() {
  const cmd = results.value[selectedIndex.value]
  if (!cmd) return
  close()
  await cmd.run()
}

function onKey(e: KeyboardEvent) {
  const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
  if (isCmdK) {
    e.preventDefault()
    open.value = !open.value
    if (open.value) {
      nextTick(() => inputRef.value?.focus())
    }
    return
  }
  if (!open.value) return
  if (e.key === 'Escape') { close(); return }
  if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex.value = Math.min(selectedIndex.value + 1, results.value.length - 1) }
  if (e.key === 'ArrowUp')   { e.preventDefault(); selectedIndex.value = Math.max(selectedIndex.value - 1, 0) }
  if (e.key === 'Enter')     { e.preventDefault(); void runSelected() }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="open" class="fixed inset-0 z-[100] flex items-start justify-center pt-24 px-4 bg-black/60 backdrop-blur-sm" @click.self="close">
        <div class="w-full max-w-xl rounded-xl shadow-2xl border border-border bg-surface-raised overflow-hidden">
          <div class="flex items-center gap-3 px-4 py-3 border-b border-border">
            <svg class="w-5 h-5 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              :placeholder="t('cmd.placeholder', 'Type a command or search…')"
              class="flex-1 bg-transparent outline-none text-base text-ink placeholder:text-ink-muted"
              aria-label="Command palette"
            />
            <kbd class="hidden sm:block text-xs px-1.5 py-0.5 rounded bg-surface-overlay text-ink-muted border border-border">esc</kbd>
          </div>
          <div class="max-h-80 overflow-y-auto p-2" role="listbox">
            <template v-if="results.length === 0">
              <div class="p-6 text-center text-sm text-ink-muted">{{ t('cmd.noResults', 'No results') }}</div>
            </template>
            <template v-else>
              <template v-for="(cmd, i) in results" :key="cmd.id">
                <div
                  role="option"
                  :aria-selected="i === selectedIndex"
                  @mouseenter="selectedIndex = i"
                  @click="runSelected"
                  class="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer"
                  :class="i === selectedIndex ? 'bg-hytale-orange/15 text-ink' : 'text-ink-muted hover:bg-surface-overlay'"
                >
                  <div class="flex flex-col">
                    <span class="text-sm">{{ cmd.title }}</span>
                    <span v-if="cmd.hint" class="text-xs text-ink-muted">{{ cmd.hint }}</span>
                  </div>
                  <span class="text-[10px] uppercase tracking-wider text-ink-muted">{{ cmd.group }}</span>
                </div>
              </template>
            </template>
          </div>
          <div class="flex items-center justify-between px-4 py-2 border-t border-border text-xs text-ink-muted">
            <div class="flex gap-3">
              <span><kbd class="px-1 py-0.5 rounded bg-surface-overlay">↑↓</kbd> navigate</span>
              <span><kbd class="px-1 py-0.5 rounded bg-surface-overlay">↵</kbd> run</span>
            </div>
            <span><kbd class="px-1 py-0.5 rounded bg-surface-overlay">⌘K</kbd> toggle</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
