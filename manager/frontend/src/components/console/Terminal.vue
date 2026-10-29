<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useConsoleStore } from '@/stores/console'
import { useWebSocket } from '@/composables/useWebSocket'
import { formatLogMessage } from '@/utils/formatItemPath'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import CommandReplyBlock from '@/components/console/CommandReplyBlock.vue'
import { useCommandAutocomplete, type CommandSuggestion } from '@/composables/useCommandAutocomplete'

const { t } = useI18n()
const authStore = useAuthStore()
const consoleStore = useConsoleStore()
const { sendCommand, reconnect, loadAllLogs, isLoadingLogs } = useWebSocket()

const terminalRef = ref<HTMLDivElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const commandInput = ref('')
const searchFilter = ref('')
const levelFilter = ref<'all' | 'error' | 'warn' | 'info' | 'debug'>('all')
const showClearConfirm = ref(false)

// Command auto-complete: the server's real command list via the KyuubiSoft
// API plugin (vanilla + mod commands, syntax, argument values), otherwise a
// short built-in list.
const showSuggestions = ref(false)
const selectedSuggestion = ref(0)
// Late server suggestions must not reopen the list after the input lost focus.
const inputFocused = ref(false)
const { suggestions, activeCommand, loadCommands, refreshCommands } = useCommandAutocomplete(commandInput)

function selectSuggestion(suggestion: CommandSuggestion) {
  commandInput.value = suggestion.value
  selectedSuggestion.value = 0
  inputRef.value?.focus()
}

function handleKeyDown(e: KeyboardEvent) {
  if (!showSuggestions.value || suggestions.value.length === 0) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedSuggestion.value = (selectedSuggestion.value + 1) % suggestions.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedSuggestion.value = selectedSuggestion.value === 0
      ? suggestions.value.length - 1
      : selectedSuggestion.value - 1
  } else if (e.key === 'Tab' || e.key === 'Enter') {
    const suggestion = suggestions.value[selectedSuggestion.value]
    // Enter on a line that is already complete sends it.
    if (e.key === 'Enter' && suggestion && suggestion.value.trim() === commandInput.value.trim()) return
    if (suggestion) {
      e.preventDefault()
      selectSuggestion(suggestion)
    }
  } else if (e.key === 'Escape') {
    showSuggestions.value = false
  }
}

watch([commandInput, suggestions], ([val]) => {
  showSuggestions.value = inputFocused.value && val.startsWith('/') && suggestions.value.length > 0
  if (selectedSuggestion.value >= suggestions.value.length) selectedSuggestion.value = 0
})

watch(commandInput, () => {
  selectedSuggestion.value = 0
})

// Syntax of the command being typed, shown under the input.
const syntaxHint = computed(() => {
  const node = activeCommand.value
  if (!node || !commandInput.value.startsWith('/')) return null
  const usage = node.usage ?? `/${node.name}`
  const options = (node.optionalArgs ?? [])
    .map((o) => (o.kind === 'flag' ? `[--${o.name}]` : `[--${o.name}=<${o.type ?? o.name}>]`))
    .join(' ')
  return { usage: options ? `${usage} ${options}` : usage, description: node.description }
})

// Filtered logs based on search and level
const filteredLogs = computed(() => {
  let logs = consoleStore.logs

  // Filter by level
  if (levelFilter.value !== 'all') {
    logs = logs.filter(log => {
      const level = (log.level || 'INFO').toUpperCase()
      switch (levelFilter.value) {
        case 'error':
          return level === 'ERROR' || level === 'SEVERE'
        case 'warn':
          return level === 'WARN' || level === 'WARNING'
        case 'info':
          return level === 'INFO'
        case 'debug':
          return level === 'DEBUG'
        default:
          return true
      }
    })
  }

  // Filter by search text
  if (searchFilter.value.trim()) {
    const search = searchFilter.value.toLowerCase()
    logs = logs.filter(log =>
      log.message.toLowerCase().includes(search) ||
      (log.level && log.level.toLowerCase().includes(search))
    )
  }

  return logs
})

async function handleSubmit() {
  if (!commandInput.value.trim()) return
  showSuggestions.value = false
  const sent = sendCommand(commandInput.value)
  if (sent) {
    commandInput.value = ''
  } else {
    // Keep the typed command so the user can retry, and tell them why nothing
    // happened (the socket was reconnecting / disconnected).
    consoleStore.addLog({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: t('console.notConnected'),
    })
  }

  // Auto-scroll to bottom after command is sent
  await nextTick()
  setTimeout(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight
    }
  }, 100)
}

function clearLogs() {
  consoleStore.clearLogs()
}

function getLogClass(level: string): string {
  switch (level.toUpperCase()) {
    case 'ERROR':
    case 'SEVERE':
      return 'terminal-line error'
    case 'WARN':
    case 'WARNING':
      return 'terminal-line warn'
    case 'DEBUG':
      return 'terminal-line debug'
    default:
      return 'terminal-line info'
  }
}

// Scroll to bottom helper - scrolls multiple times to ensure it works
function scrollToBottom(retries = 3) {
  if (!terminalRef.value) return

  const el = terminalRef.value
  el.scrollTop = el.scrollHeight

  // Retry a few times to handle delayed renders
  if (retries > 0) {
    requestAnimationFrame(() => {
      if (el.scrollTop < el.scrollHeight - el.clientHeight - 10) {
        el.scrollTop = el.scrollHeight
        if (retries > 1) {
          requestAnimationFrame(() => scrollToBottom(retries - 1))
        }
      }
    })
  }
}

// Hide the command suggestions shortly after blur (delayed so a click on a
// suggestion still registers). Defined as a method because `setTimeout` isn't
// available on the component instance inside template expressions.
function hideSuggestionsSoon(): void {
  inputFocused.value = false
  setTimeout(() => { showSuggestions.value = false }, 150)
}

function onInputFocus(): void {
  inputFocused.value = true
  refreshCommands()
}

// Auto-scroll interval - more reliable than watchers for continuous updates
let autoScrollInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  if (authStore.hasPermission('console.execute')) void loadCommands()

  // Initial scroll
  scrollToBottom()

  // Poll-based auto-scroll - checks every 100ms if we should scroll
  autoScrollInterval = setInterval(() => {
    if (consoleStore.autoScroll && terminalRef.value) {
      const el = terminalRef.value
      // Only scroll if not already at bottom
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 5) {
        el.scrollTop = el.scrollHeight
      }
    }
  }, 100)
})

onUnmounted(() => {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval)
    autoScrollInterval = null
  }
})

// Also trigger scroll on log changes for immediate response
watch(
  () => consoleStore.logsUpdated,
  () => {
    if (consoleStore.autoScroll) {
      scrollToBottom()
    }
  },
  { flush: 'post' }
)
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Filter Bar -->
    <div class="flex items-center gap-3 mb-3 flex-shrink-0">
      <!-- Search Input -->
      <div class="relative flex-1">
        <input
          v-model="searchFilter"
          type="text"
          :placeholder="t('console.filterPlaceholder')"
          class="w-full pl-9 pr-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink text-sm placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
        />
        <svg class="w-4 h-4 text-ink-subtle absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>

      <!-- Level Filter Buttons -->
      <div class="flex gap-1">
        <button
          @click="levelFilter = 'all'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            levelFilter === 'all' ? 'bg-hytale-orange text-dark' : 'bg-surface-overlay text-ink-muted hover:text-ink'
          ]"
        >
          {{ t('console.showAll') }}
        </button>
        <button
          @click="levelFilter = 'error'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            levelFilter === 'error' ? 'bg-status-error text-white' : 'bg-surface-overlay text-ink-muted hover:text-status-error'
          ]"
        >
          {{ t('console.showErrors') }}
        </button>
        <button
          @click="levelFilter = 'warn'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            levelFilter === 'warn' ? 'bg-status-warning text-dark' : 'bg-surface-overlay text-ink-muted hover:text-status-warning'
          ]"
        >
          {{ t('console.showWarnings') }}
        </button>
        <button
          @click="levelFilter = 'info'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            levelFilter === 'info' ? 'bg-blue-500 text-white' : 'bg-surface-overlay text-ink-muted hover:text-blue-400'
          ]"
        >
          {{ t('console.showInfo') }}
        </button>
      </div>
    </div>

    <!-- Terminal Output -->
    <div
      ref="terminalRef"
      class="terminal flex-1 min-h-0 overflow-y-auto"
      style="max-height: calc(100vh - 340px);"
    >
      <div v-if="filteredLogs.length === 0" class="text-ink-subtle text-center py-8">
        {{ searchFilter || levelFilter !== 'all' ? t('console.noLogs') + ' ' + t('console.filtered') : t('console.noLogs') }}
      </div>
      <div
        v-for="log in filteredLogs"
        :key="log.id"
        class="cv-auto"
        :class="getLogClass(log.level)"
      >
        <span class="text-ink-subtle mr-2">[{{ log.timestamp.split('T')[1]?.split('.')[0] || log.timestamp }}]</span>
        <span
          v-if="log.level && log.level !== 'INFO'"
          :class="{
            'bg-status-error/20 text-status-error': log.level === 'ERROR' || log.level === 'SEVERE',
            'bg-status-warning/20 text-status-warning': log.level === 'WARN' || log.level === 'WARNING',
            'bg-gray-500/20 text-ink-muted': log.level === 'DEBUG'
          }"
          class="px-1.5 py-0.5 rounded text-xs font-medium mr-2"
        >{{ log.level }}</span>
        <span :class="{
          'text-status-error font-medium': log.level === 'ERROR' || log.level === 'SEVERE',
          'text-status-warning': log.level === 'WARN' || log.level === 'WARNING',
          'text-ink-subtle': log.level === 'DEBUG',
          'text-ink-muted': log.level === 'INFO' || !log.level
        }">{{ formatLogMessage(log.message) }}</span>
        <!-- The server's answer to a command sent from here -->
        <CommandReplyBlock v-if="log.reply" :reply="log.reply" />
      </div>
    </div>

    <!-- Command Input - Always visible at bottom -->
    <div class="mt-4 flex-shrink-0">
      <form v-if="authStore.hasPermission('console.execute')" @submit.prevent="handleSubmit" class="relative">
        <div class="flex gap-2">
          <div class="relative flex-1">
            <input
              ref="inputRef"
              v-model="commandInput"
              @keydown="handleKeyDown"
              @blur="hideSuggestionsSoon"
              @focus="onInputFocus"
              type="text"
              :placeholder="t('console.commandPlaceholder')"
              class="input w-full font-mono"
            />

            <!-- Auto-complete dropdown -->
            <div
              v-if="showSuggestions && suggestions.length > 0"
              class="absolute bottom-full left-0 right-0 mb-1 bg-surface-muted border border-border rounded-lg overflow-hidden shadow-lg z-10"
            >
              <button
                v-for="(suggestion, index) in suggestions"
                :key="suggestion.value"
                type="button"
                @mousedown.prevent
                @click="selectSuggestion(suggestion)"
                :title="suggestion.description"
                :class="[
                  'w-full px-4 py-2 text-left font-mono text-sm transition-colors flex items-baseline gap-2',
                  index === selectedSuggestion
                    ? 'bg-hytale-orange/20 text-hytale-orange'
                    : 'text-ink-muted hover:bg-surface-overlay',
                  suggestion.blocked ? 'opacity-50' : ''
                ]"
              >
                <span class="flex-shrink-0">{{ suggestion.label }}</span>
                <span v-if="suggestion.hint" class="text-ink-subtle flex-shrink-0">{{ suggestion.hint }}</span>
                <span v-if="suggestion.description" class="text-ink-subtle font-sans text-xs truncate">{{ suggestion.description }}</span>
                <span
                  v-if="suggestion.blocked"
                  class="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded bg-status-error/15 text-status-error font-sans text-xs"
                >{{ t('console.suggestionBlocked') }}</span>
                <span
                  v-else-if="suggestion.admin"
                  class="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded bg-status-warning/15 text-status-warning font-sans text-xs"
                >{{ t('console.suggestionAdmin') }}</span>
              </button>
            </div>
          </div>
          <button type="submit" class="btn btn-primary">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        <!-- Syntax of the command being typed (from the server's command list) -->
        <p v-if="syntaxHint" class="mt-1 text-xs text-ink-subtle font-mono truncate" :title="syntaxHint.description">
          {{ t('console.syntax') }}: {{ syntaxHint.usage }}
          <span v-if="syntaxHint.description" class="font-sans"> · {{ syntaxHint.description }}</span>
        </p>
      </form>
      <div v-else class="p-3 bg-surface-overlay rounded-lg text-ink-subtle text-sm text-center">
        {{ t('common.noPermission') }}
      </div>

      <!-- Console bypass warning for admins -->
      <div v-if="authStore.hasPermission('console.execute')" class="mt-2 p-2 bg-status-warning/10 border border-status-warning/20 rounded-lg">
        <p class="text-status-warning text-xs flex items-center gap-2">
          <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {{ t('console.bypassWarning') }}
        </p>
      </div>

      <!-- Controls -->
      <div class="flex items-center justify-between mt-3">
        <div class="flex items-center gap-4">
          <button
            @click="showClearConfirm = true"
            class="text-sm text-ink-muted hover:text-ink flex items-center gap-1"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {{ t('console.clear') }}
          </button>

          <!-- Load All Logs Button -->
          <button
            @click="loadAllLogs(0)"
            :disabled="isLoadingLogs"
            class="text-sm text-ink-muted hover:text-ink flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg v-if="isLoadingLogs" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {{ t('console.loadAll') }}
          </button>

          <label class="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
            <input
              type="checkbox"
              :checked="consoleStore.autoScroll"
              @change="consoleStore.toggleAutoScroll()"
              class="rounded border-border bg-surface-muted text-hytale-orange focus:ring-hytale-orange"
            />
            {{ t('console.autoScroll') }}
          </label>

          <!-- Log count -->
          <span class="text-xs text-ink-subtle">
            {{ filteredLogs.length }} / {{ consoleStore.logs.length }}
          </span>
        </div>

        <div class="flex items-center gap-3">
          <!-- Reconnect Button -->
          <button
            v-if="!consoleStore.connected"
            @click="reconnect"
            class="text-sm text-hytale-orange hover:text-hytale-orange-light flex items-center gap-1"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {{ t('console.reconnect') }}
          </button>

          <!-- Connection Status -->
          <div class="flex items-center gap-2">
            <span
              :class="[
                'w-2 h-2 rounded-full',
                consoleStore.connected ? 'bg-status-success' : 'bg-status-error'
              ]"
            />
            <span class="text-sm text-ink-muted">
              {{ consoleStore.connected ? t('console.connected') : t('console.disconnected') }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Confirm Clear Logs -->
    <ConfirmDialog
      :show="showClearConfirm"
      :title="t('console.clear')"
      :message="t('console.confirmClear')"
      :confirm-text="t('console.clear')"
      :cancel-text="t('common.cancel')"
      variant="primary"
      @confirm="clearLogs(); showClearConfirm = false"
      @cancel="showClearConfirm = false"
    />
  </div>
</template>
