<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConsoleStore } from '@/stores/console'
import { useWebSocket } from '@/composables/useWebSocket'

const { t } = useI18n()
const consoleStore = useConsoleStore()
const { sendCommand } = useWebSocket()

const terminalRef = ref<HTMLDivElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const commandInput = ref('')
const searchFilter = ref('')
const levelFilter = ref<'all' | 'error' | 'warn' | 'info' | 'debug'>('all')

// Command auto-complete
const showSuggestions = ref(false)
const selectedSuggestion = ref(0)

// Real Hytale Server commands extracted from HytaleServer.jar
const knownCommands = [
  // Authentication
  '/auth',
  '/auth login device',
  '/auth login browser',
  '/auth logout',
  '/auth status',
  '/auth select',
  '/auth cancel',
  // Server Management
  '/stop',
  '/server',
  '/server stats',
  '/server gc',
  '/server dump',
  '/version',
  '/help',
  '/commands',
  '/backup',
  // Player Management
  '/kick',
  '/ban',
  '/unban',
  '/op',
  '/op add',
  '/op remove',
  '/op self',
  '/perm',
  '/perm user',
  '/perm group',
  '/perm test',
  '/who',
  '/whoami',
  '/list',
  '/maxplayers',
  '/player',
  '/player reset',
  '/player respawn',
  '/player stats get',
  '/player stats set',
  '/player stats add',
  '/player stats reset',
  // Teleport Commands
  '/tp',
  '/teleport',
  '/teleport all',
  '/teleport back',
  '/teleport forward',
  '/teleport history',
  '/teleport home',
  '/teleport top',
  '/teleport world',
  '/teleport tocoordinates',
  '/teleport toplayer',
  '/teleport playertoplayer',
  // World Commands
  '/world',
  '/world add',
  '/world remove',
  '/world list',
  '/world load',
  '/world save',
  '/world prune',
  '/world tps',
  '/world perf',
  '/world settings',
  '/worldconfig',
  '/worldconfig seed',
  '/worldconfig setspawn',
  '/worldconfig setpvp',
  '/worldconfig pausetime',
  // Whitelist
  '/whitelist',
  '/whitelist add',
  '/whitelist remove',
  '/whitelist enable',
  '/whitelist disable',
  '/whitelist status',
  '/whitelist list',
  '/whitelist clear',
  // Items & Spawning
  '/give',
  '/give armor',
  '/spawn',
  '/spawn item',
  '/spawn block',
  '/spawn prefab',
  '/spawn markers',
  '/spawn set',
  '/spawn setdefault',
  // Time & Weather
  '/time',
  '/time set',
  '/time pause',
  '/time dilation',
  '/weather',
  '/weather get',
  '/weather set',
  '/weather reset',
  // Game
  '/gamemode',
  '/inventory',
  '/inventory clear',
  '/inventory see',
  '/kill',
  '/damage',
  '/emote',
  // Plugins
  '/plugin',
  '/plugin list',
  '/plugin load',
  '/plugin unload',
  '/plugin reload',
  // Chat & Communication
  '/say',
  '/msg',
  '/notify',
  // Warps
  '/warp',
  '/warp list',
  '/warp set',
  '/warp go',
  '/warp remove',
  '/warp reload',
  // Blocks & Building
  '/block',
  '/block set',
  '/block get',
  '/block bulk',
  '/fill',
  '/replace',
  '/copy',
  '/paste',
  '/cut',
  '/undo',
  '/redo',
  '/pos1',
  '/pos2',
  // Debug & Dev
  '/debug',
  '/entity',
  '/entity count',
  '/entity remove',
  '/entity clean',
  '/npc',
  '/npc spawn',
  '/chunk',
  '/chunk load',
  '/chunk unload',
  '/chunk info',
]

const filteredCommands = computed(() => {
  if (!commandInput.value.startsWith('/')) return []
  if (commandInput.value === '/') return knownCommands.slice(0, 10)
  const input = commandInput.value.toLowerCase()
  return knownCommands.filter(cmd => cmd.toLowerCase().startsWith(input)).slice(0, 10)
})

function selectSuggestion(cmd: string) {
  commandInput.value = cmd
  showSuggestions.value = false
  inputRef.value?.focus()
}

function handleKeyDown(e: KeyboardEvent) {
  if (!showSuggestions.value || filteredCommands.value.length === 0) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedSuggestion.value = (selectedSuggestion.value + 1) % filteredCommands.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedSuggestion.value = selectedSuggestion.value === 0
      ? filteredCommands.value.length - 1
      : selectedSuggestion.value - 1
  } else if (e.key === 'Tab' || e.key === 'Enter') {
    if (filteredCommands.value.length > 0 && showSuggestions.value) {
      e.preventDefault()
      selectSuggestion(filteredCommands.value[selectedSuggestion.value])
    }
  } else if (e.key === 'Escape') {
    showSuggestions.value = false
  }
}

watch(commandInput, (val) => {
  if (val.startsWith('/')) {
    showSuggestions.value = filteredCommands.value.length > 0
    selectedSuggestion.value = 0
  } else {
    showSuggestions.value = false
  }
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
  sendCommand(commandInput.value)
  commandInput.value = ''

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

// Auto-scroll to bottom when new logs arrive
watch(
  () => consoleStore.logs.length,
  async () => {
    if (consoleStore.autoScroll && terminalRef.value) {
      await nextTick()
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight
    }
  }
)

// Initial scroll
onMounted(() => {
  if (terminalRef.value) {
    terminalRef.value.scrollTop = terminalRef.value.scrollHeight
  }
})
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
          class="w-full pl-9 pr-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
        />
        <svg class="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>

      <!-- Level Filter Buttons -->
      <div class="flex gap-1">
        <button
          @click="levelFilter = 'all'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            levelFilter === 'all' ? 'bg-hytale-orange text-dark' : 'bg-dark-100 text-gray-400 hover:text-white'
          ]"
        >
          {{ t('console.showAll') }}
        </button>
        <button
          @click="levelFilter = 'error'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            levelFilter === 'error' ? 'bg-status-error text-white' : 'bg-dark-100 text-gray-400 hover:text-status-error'
          ]"
        >
          {{ t('console.showErrors') }}
        </button>
        <button
          @click="levelFilter = 'warn'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            levelFilter === 'warn' ? 'bg-status-warning text-dark' : 'bg-dark-100 text-gray-400 hover:text-status-warning'
          ]"
        >
          {{ t('console.showWarnings') }}
        </button>
        <button
          @click="levelFilter = 'info'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
            levelFilter === 'info' ? 'bg-blue-500 text-white' : 'bg-dark-100 text-gray-400 hover:text-blue-400'
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
      <div v-if="filteredLogs.length === 0" class="text-gray-500 text-center py-8">
        {{ searchFilter || levelFilter !== 'all' ? t('console.noLogs') + ' (filtered)' : t('console.noLogs') }}
      </div>
      <div
        v-for="log in filteredLogs"
        :key="log.id"
        :class="getLogClass(log.level)"
      >
        <span class="text-gray-500 mr-2">[{{ log.timestamp.split('T')[1]?.split('.')[0] || log.timestamp }}]</span>
        <span
          v-if="log.level && log.level !== 'INFO'"
          :class="{
            'bg-status-error/20 text-status-error': log.level === 'ERROR' || log.level === 'SEVERE',
            'bg-status-warning/20 text-status-warning': log.level === 'WARN' || log.level === 'WARNING',
            'bg-gray-500/20 text-gray-400': log.level === 'DEBUG'
          }"
          class="px-1.5 py-0.5 rounded text-xs font-medium mr-2"
        >{{ log.level }}</span>
        <span :class="{
          'text-status-error font-medium': log.level === 'ERROR' || log.level === 'SEVERE',
          'text-status-warning': log.level === 'WARN' || log.level === 'WARNING',
          'text-gray-500': log.level === 'DEBUG',
          'text-gray-300': log.level === 'INFO' || !log.level
        }">{{ log.message }}</span>
      </div>
    </div>

    <!-- Command Input - Always visible at bottom -->
    <div class="mt-4 flex-shrink-0">
      <form @submit.prevent="handleSubmit" class="relative">
        <div class="flex gap-2">
          <div class="relative flex-1">
            <input
              ref="inputRef"
              v-model="commandInput"
              @keydown="handleKeyDown"
              @blur="setTimeout(() => showSuggestions = false, 150)"
              type="text"
              :placeholder="t('console.commandPlaceholder')"
              class="input w-full font-mono"
            />

            <!-- Auto-complete dropdown -->
            <div
              v-if="showSuggestions && filteredCommands.length > 0"
              class="absolute bottom-full left-0 right-0 mb-1 bg-dark-300 border border-dark-50 rounded-lg overflow-hidden shadow-lg z-10"
            >
              <button
                v-for="(cmd, index) in filteredCommands"
                :key="cmd"
                type="button"
                @click="selectSuggestion(cmd)"
                :class="[
                  'w-full px-4 py-2 text-left font-mono text-sm transition-colors',
                  index === selectedSuggestion
                    ? 'bg-hytale-orange/20 text-hytale-orange'
                    : 'text-gray-300 hover:bg-dark-100'
                ]"
              >
                {{ cmd }}
              </button>
            </div>
          </div>
          <button type="submit" class="btn btn-primary">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </form>

      <!-- Controls -->
      <div class="flex items-center justify-between mt-3">
        <div class="flex items-center gap-4">
          <button
            @click="clearLogs"
            class="text-sm text-gray-400 hover:text-white flex items-center gap-1"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {{ t('console.clear') }}
          </button>

          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              :checked="consoleStore.autoScroll"
              @change="consoleStore.toggleAutoScroll()"
              class="rounded border-dark-50 bg-dark-300 text-hytale-orange focus:ring-hytale-orange"
            />
            {{ t('console.autoScroll') }}
          </label>

          <!-- Log count -->
          <span class="text-xs text-gray-500">
            {{ filteredLogs.length }} / {{ consoleStore.logs.length }}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <span
            :class="[
              'w-2 h-2 rounded-full',
              consoleStore.connected ? 'bg-status-success' : 'bg-status-error'
            ]"
          />
          <span class="text-sm text-gray-400">
            {{ consoleStore.connected ? t('console.connected') : t('console.disconnected') }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
