<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import { consoleApi, type CommandNode } from '@/api/console'
import { HYTALE_COMMANDS, type CommandCategory, type CommandTierLabel } from '@/utils/hytaleCommands'

const { t } = useI18n()

const searchQuery = ref('')
const activeCategory = ref('all')
const copiedCommand = ref<string | null>(null)

interface Command {
  command: string
  /** Translated (documented commands) or the server's own text (live list). */
  description: string
  usage: string
  tier: CommandTierLabel
  /** Permission node the server checks (live list only). */
  permission?: string
}

interface Category {
  id: string
  labelKey: string
  icon: string
  commands: Command[]
}

const ICONS: Record<CommandCategory['id'], string> = {
  players: 'players',
  access: 'access',
  server: 'server',
  world: 'worlds',
  chat: 'chat',
}

// Hytale 0.7 commands with the syntax the server accepts.
const documented = computed<Category[]>(() =>
  HYTALE_COMMANDS.map((category) => ({
    id: category.id,
    labelKey: `help.categories.${category.id}`,
    icon: ICONS[category.id],
    commands: category.commands.map((cmd) => ({
      command: cmd.command,
      usage: cmd.usage,
      tier: cmd.tier,
      description: t(`help.commands.${cmd.key}`),
    })),
  })),
)

// Every command of the running server, mods included, when the user may read
// the console's command list (console.execute) and the server has sent one.
const liveCommands = ref<Command[]>([])

function flatten(nodes: CommandNode[], prefix = ''): Command[] {
  return nodes.flatMap((node) => {
    const path = `${prefix} ${node.name}`.trim()
    const own: Command = {
      command: `/${path}`,
      usage: node.usage || `/${path}`,
      description: node.description ?? '',
      tier: node.panel?.permission === 'console.execute' ? 'plain' : 'admin',
      permission: node.permission,
    }
    return [own, ...flatten(node.subcommands ?? [], path)]
  })
}

onMounted(async () => {
  try {
    const registry = await consoleApi.getCommands()
    if (registry.available && registry.source !== 'fallback') {
      liveCommands.value = flatten(registry.commands)
    }
  } catch {
    // No console permission or no server: the documented list is enough.
  }
})

const categories = computed<Category[]>(() =>
  liveCommands.value.length > 0
    ? [
        ...documented.value,
        { id: 'live', labelKey: 'help.categories.live', icon: 'live', commands: liveCommands.value },
      ]
    : documented.value,
)

const allCategories = computed(() => [
  { id: 'all', labelKey: 'help.categories.all', icon: 'all' },
  ...categories.value,
])

const filteredCommands = computed(() => {
  let commands: (Command & { categoryId: string })[] = []

  if (activeCategory.value === 'all') {
    documented.value.forEach((cat) => {
      cat.commands.forEach((cmd) => {
        commands.push({ ...cmd, categoryId: cat.id })
      })
    })
  } else {
    const category = categories.value.find((c) => c.id === activeCategory.value)
    if (category) {
      category.commands.forEach((cmd) => {
        commands.push({ ...cmd, categoryId: category.id })
      })
    }
  }

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    commands = commands.filter(
      (cmd) =>
        cmd.command.toLowerCase().includes(query) ||
        cmd.description.toLowerCase().includes(query) ||
        cmd.usage.toLowerCase().includes(query),
    )
  }

  return commands
})

const commandCount = computed(() =>
  documented.value.reduce((total, cat) => total + cat.commands.length, 0),
)

function copyCommand(usage: string) {
  navigator.clipboard.writeText(usage)
  copiedCommand.value = usage
  setTimeout(() => {
    copiedCommand.value = null
  }, 2000)
}

function getCategoryLabel(id: string): string {
  const cat = categories.value.find((c) => c.id === id)
  return cat ? t(cat.labelKey) : id
}
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Page Title -->
    <div class="mb-6 flex-shrink-0">
      <h1 class="text-2xl font-bold text-ink">{{ t('help.title') }}</h1>
      <p class="text-ink-muted mt-1">{{ t('help.subtitle', { count: commandCount }) }}</p>
    </div>

    <!-- Main Content -->
    <div class="flex-1 flex gap-6 min-h-0 overflow-hidden">
      <!-- Sidebar Categories -->
      <Card class="w-64 flex-shrink-0 flex flex-col" :padding="false">
        <div class="p-4 border-b border-border/60 flex-shrink-0">
          <h3 class="text-sm font-semibold text-ink-muted uppercase tracking-wider">{{ t('help.categoriesTitle') }}</h3>
        </div>
        <div class="flex-1 overflow-y-auto p-2">
          <button
            v-for="cat in allCategories"
            :key="cat.id"
            @click="activeCategory = cat.id"
            :class="[
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all',
              activeCategory === cat.id
                ? 'bg-hytale-orange/20 text-hytale-orange'
                : 'text-ink-muted hover:bg-surface-overlay/50 hover:text-ink'
            ]"
          >
            <!-- All Icon -->
            <svg v-if="cat.icon === 'all'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
            <!-- Players Icon -->
            <svg v-else-if="cat.icon === 'players'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
            <!-- Server Icon -->
            <svg v-else-if="cat.icon === 'server'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
            <!-- Worlds Icon -->
            <svg v-else-if="cat.icon === 'worlds'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <!-- Chat Icon -->
            <svg v-else-if="cat.icon === 'chat'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <!-- Access Icon -->
            <svg v-else-if="cat.icon === 'access'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <!-- Live Icon (the list of the running server) -->
            <svg v-else-if="cat.icon === 'live'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span class="text-sm font-medium">{{ t(cat.labelKey) }}</span>
          </button>
        </div>
      </Card>

      <!-- Commands List -->
      <Card class="flex-1 flex flex-col min-h-0" :padding="false">
        <!-- Search Bar -->
        <div class="p-4 border-b border-border/60 flex-shrink-0">
          <div class="relative">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('help.searchPlaceholder')"
              class="w-full pl-10 pr-4 py-2.5 bg-surface-overlay border border-border/60 rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange/50 focus:ring-1 focus:ring-hytale-orange/50 transition-colors"
            />
          </div>
        </div>

        <!-- Commands -->
        <div class="flex-1 overflow-y-auto p-4">
          <div v-if="filteredCommands.length === 0" class="flex flex-col items-center justify-center h-full text-ink-subtle">
            <svg class="w-12 h-12 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>{{ t('help.noResults') }}</p>
          </div>

          <div v-else class="space-y-3">
            <div
              v-for="(cmd, index) in filteredCommands"
              :key="`${cmd.command}-${index}`"
              class="bg-surface-overlay rounded-lg p-4 hover:bg-surface-overlay/50 transition-colors group"
            >
              <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-3 mb-2">
                    <code class="text-hytale-orange font-mono text-base font-semibold">{{ cmd.command }}</code>
                    <span
                      v-if="activeCategory === 'all'"
                      class="px-2 py-0.5 text-xs rounded bg-surface-raised text-ink-muted"
                    >
                      {{ getCategoryLabel(cmd.categoryId) }}
                    </span>
                  </div>
                  <p v-if="cmd.description" class="text-ink-muted text-sm mb-3">{{ cmd.description }}</p>
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-ink-subtle uppercase font-semibold">{{ t('help.usage') }}:</span>
                    <code class="text-sm text-ink-muted font-mono bg-surface-raised px-2 py-1 rounded">{{ cmd.usage }}</code>
                  </div>
                  <div class="mt-2 flex flex-wrap items-center gap-2">
                    <span class="text-xs text-ink-subtle uppercase font-semibold">{{ t('help.panelTier') }}:</span>
                    <span
                      :class="[
                        'px-2 py-0.5 text-xs rounded',
                        cmd.tier === 'admin' ? 'bg-red-500/15 text-red-400' : 'bg-green-500/15 text-green-400',
                      ]"
                      :title="cmd.tier === 'admin' ? t('help.tierAdminHint') : t('help.tierPlainHint')"
                    >
                      {{ cmd.tier === 'admin' ? t('help.tierAdmin') : t('help.tierPlain') }}
                    </span>
                    <template v-if="cmd.permission">
                      <span class="text-xs text-ink-subtle uppercase font-semibold ml-2">{{ t('help.permission') }}:</span>
                      <code class="text-xs text-ink-muted font-mono">{{ cmd.permission }}</code>
                    </template>
                  </div>
                </div>
                <button
                  @click="copyCommand(cmd.usage)"
                  :class="[
                    'p-2 rounded-lg transition-all flex-shrink-0',
                    copiedCommand === cmd.usage
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-surface-raised text-ink-muted hover:text-ink hover:bg-surface-overlay/50 opacity-0 group-hover:opacity-100'
                  ]"
                  :title="t('help.copyCommand')"
                >
                  <svg v-if="copiedCommand === cmd.usage" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer Info -->
        <div class="p-4 border-t border-border/60 bg-surface-overlay/50 flex-shrink-0">
          <div class="flex items-center justify-between text-sm text-ink-subtle">
            <span>{{ t('help.commandsShown', { shown: filteredCommands.length, total: commandCount }) }}</span>
            <div class="flex items-center gap-4">
              <div class="flex items-center gap-2">
                <span class="text-xs">{{ t('help.tipPrefix') }}:</span>
                <code class="text-xs bg-surface-raised px-1.5 py-0.5 rounded text-ink-muted">--help</code>
                <span class="text-xs">{{ t('help.tipHelpFlag') }}</span>
              </div>
              <span class="text-xs">{{ t('help.notInHytale') }}</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
