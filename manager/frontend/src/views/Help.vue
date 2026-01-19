<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'

const { t } = useI18n()

const searchQuery = ref('')
const activeCategory = ref('all')
const copiedCommand = ref<string | null>(null)

interface Command {
  command: string
  description: string
  usage: string
  permission?: string
}

interface Category {
  id: string
  labelKey: string
  icon: string
  commands: Command[]
}

const categories: Category[] = [
  {
    id: 'player',
    labelKey: 'help.categories.player',
    icon: 'players',
    commands: [
      { command: '/kick', description: 'help.commands.kick', usage: '/kick <player> [reason]', permission: 'hytale.command.kick' },
      { command: '/ban', description: 'help.commands.ban', usage: '/ban <player> [reason]', permission: 'hytale.command.ban' },
      { command: '/unban', description: 'help.commands.unban', usage: '/unban <player>', permission: 'hytale.command.unban' },
      { command: '/op add', description: 'help.commands.opAdd', usage: '/op add <player>', permission: 'hytale.command.op' },
      { command: '/op remove', description: 'help.commands.opRemove', usage: '/op remove <player>', permission: 'hytale.command.op' },
      { command: '/whitelist add', description: 'help.commands.whitelistAdd', usage: '/whitelist add <player>', permission: 'hytale.command.whitelist' },
      { command: '/whitelist remove', description: 'help.commands.whitelistRemove', usage: '/whitelist remove <player>', permission: 'hytale.command.whitelist' },
      { command: '/kill', description: 'help.commands.kill', usage: '/kill <player>', permission: 'hytale.command.kill' },
      { command: '/player stats settomax', description: 'help.commands.statsSettomax', usage: '/player stats settomax <player> health', permission: 'hytale.command.player' },
      { command: '/player stats set', description: 'help.commands.statsSet', usage: '/player stats set <player> <stat> <value>', permission: 'hytale.command.player' },
      { command: '/player effect apply', description: 'help.commands.effectApply', usage: '/player effect apply <player> <effect>', permission: 'hytale.command.player' },
      { command: '/player effect clear', description: 'help.commands.effectClear', usage: '/player effect clear <player>', permission: 'hytale.command.player' },
      { command: '/player respawn', description: 'help.commands.respawn', usage: '/player respawn <player>', permission: 'hytale.command.player' },
      { command: '/give', description: 'help.commands.give', usage: '/give <player> <item> [amount]', permission: 'hytale.command.give' },
      { command: '/inventory clear', description: 'help.commands.inventoryClear', usage: '/inventory clear <player>', permission: 'hytale.command.inventory' },
      { command: '/inventory open', description: 'help.commands.inventoryOpen', usage: '/inventory open <player>', permission: 'hytale.command.inventory' },
      { command: '/gamemode creative', description: 'help.commands.gamemodeCreative', usage: '/gamemode creative [player]', permission: 'hytale.command.gamemode' },
      { command: '/gamemode adventure', description: 'help.commands.gamemodeAdventure', usage: '/gamemode adventure [player]', permission: 'hytale.command.gamemode' },
    ]
  },
  {
    id: 'admin',
    labelKey: 'help.categories.admin',
    icon: 'server',
    commands: [
      { command: '/stop', description: 'help.commands.stop', usage: '/stop', permission: 'hytale.command.stop' },
      { command: '/restart', description: 'help.commands.restart', usage: '/restart', permission: 'hytale.command.restart' },
      { command: '/save', description: 'help.commands.save', usage: '/save', permission: 'hytale.command.save' },
      { command: '/reload', description: 'help.commands.reload', usage: '/reload', permission: 'hytale.command.reload' },
      { command: '/say', description: 'help.commands.say', usage: '/say <message>', permission: 'hytale.command.say' },
      { command: '/tell', description: 'help.commands.tell', usage: '/tell <player> <message>', permission: 'hytale.command.tell' },
      { command: '/broadcast', description: 'help.commands.broadcast', usage: '/broadcast <message>', permission: 'hytale.command.broadcast' },
      { command: '/list', description: 'help.commands.list', usage: '/list', permission: 'hytale.command.list' },
      { command: '/info', description: 'help.commands.info', usage: '/info', permission: 'hytale.command.info' },
      { command: '/help', description: 'help.commands.help', usage: '/help [command]', permission: 'hytale.command.help' },
      { command: '/version', description: 'help.commands.version', usage: '/version', permission: 'hytale.command.version' },
      { command: '/status', description: 'help.commands.status', usage: '/status', permission: 'hytale.command.status' },
      { command: '/performance', description: 'help.commands.performance', usage: '/performance', permission: 'hytale.command.performance' },
    ]
  },
  {
    id: 'world',
    labelKey: 'help.categories.world',
    icon: 'worlds',
    commands: [
      { command: '/world list', description: 'help.commands.worldList', usage: '/world list', permission: 'hytale.command.world' },
      { command: '/world create', description: 'help.commands.worldCreate', usage: '/world create <name>', permission: 'hytale.command.world' },
      { command: '/world delete', description: 'help.commands.worldDelete', usage: '/world delete <name>', permission: 'hytale.command.world' },
      { command: '/world load', description: 'help.commands.worldLoad', usage: '/world load <name>', permission: 'hytale.command.world' },
      { command: '/world unload', description: 'help.commands.worldUnload', usage: '/world unload <name>', permission: 'hytale.command.world' },
      { command: '/time set', description: 'help.commands.timeSet', usage: '/time set <day|night|noon|midnight|value>', permission: 'hytale.command.time' },
      { command: '/time add', description: 'help.commands.timeAdd', usage: '/time add <value>', permission: 'hytale.command.time' },
      { command: '/weather clear', description: 'help.commands.weatherClear', usage: '/weather clear [duration]', permission: 'hytale.command.weather' },
      { command: '/weather rain', description: 'help.commands.weatherRain', usage: '/weather rain [duration]', permission: 'hytale.command.weather' },
      { command: '/weather storm', description: 'help.commands.weatherStorm', usage: '/weather storm [duration]', permission: 'hytale.command.weather' },
      { command: '/difficulty', description: 'help.commands.difficulty', usage: '/difficulty <peaceful|easy|normal|hard>', permission: 'hytale.command.difficulty' },
      { command: '/gamerule', description: 'help.commands.gamerule', usage: '/gamerule <rule> <value>', permission: 'hytale.command.gamerule' },
    ]
  },
  {
    id: 'teleport',
    labelKey: 'help.categories.teleport',
    icon: 'teleport',
    commands: [
      { command: '/tp', description: 'help.commands.tpPlayer', usage: '/tp <player> <target>', permission: 'hytale.command.teleport' },
      { command: '/tp', description: 'help.commands.tpCoords', usage: '/tp <player> <x> <y> <z>', permission: 'hytale.command.teleport' },
      { command: '/tp', description: 'help.commands.tpSelf', usage: '/tp <target>', permission: 'hytale.command.teleport' },
      { command: '/tp', description: 'help.commands.tpWorld', usage: '/tp <player> <x> <y> <z> --world <name>', permission: 'hytale.command.teleport' },
      { command: '/top', description: 'help.commands.top', usage: '/top', permission: 'hytale.command.top' },
      { command: '/spawn', description: 'help.commands.spawn', usage: '/spawn [player]', permission: 'hytale.command.spawn' },
      { command: '/home', description: 'help.commands.home', usage: '/home [player]', permission: 'hytale.command.home' },
      { command: '/sethome', description: 'help.commands.sethome', usage: '/sethome [player]', permission: 'hytale.command.sethome' },
      { command: '/warp', description: 'help.commands.warp', usage: '/warp <name> [player]', permission: 'hytale.command.warp' },
      { command: '/setwarp', description: 'help.commands.setwarp', usage: '/setwarp <name>', permission: 'hytale.command.setwarp' },
      { command: '/delwarp', description: 'help.commands.delwarp', usage: '/delwarp <name>', permission: 'hytale.command.delwarp' },
    ]
  },
  {
    id: 'entities',
    labelKey: 'help.categories.entities',
    icon: 'entities',
    commands: [
      { command: '/summon', description: 'help.commands.summon', usage: '/summon <entity> [x] [y] [z]', permission: 'hytale.command.summon' },
      { command: '/entity kill', description: 'help.commands.entityKill', usage: '/entity kill <type|all>', permission: 'hytale.command.entity' },
      { command: '/entity count', description: 'help.commands.entityCount', usage: '/entity count', permission: 'hytale.command.entity' },
      { command: '/npc create', description: 'help.commands.npcCreate', usage: '/npc create <name>', permission: 'hytale.command.npc' },
      { command: '/npc remove', description: 'help.commands.npcRemove', usage: '/npc remove <id>', permission: 'hytale.command.npc' },
    ]
  },
  {
    id: 'blocks',
    labelKey: 'help.categories.blocks',
    icon: 'blocks',
    commands: [
      { command: '/setblock', description: 'help.commands.setblock', usage: '/setblock <x> <y> <z> <block>', permission: 'hytale.command.setblock' },
      { command: '/fill', description: 'help.commands.fill', usage: '/fill <x1> <y1> <z1> <x2> <y2> <z2> <block>', permission: 'hytale.command.fill' },
      { command: '/clone', description: 'help.commands.clone', usage: '/clone <x1> <y1> <z1> <x2> <y2> <z2> <x> <y> <z>', permission: 'hytale.command.clone' },
    ]
  },
  {
    id: 'xp',
    labelKey: 'help.categories.xp',
    icon: 'xp',
    commands: [
      { command: '/xp add', description: 'help.commands.xpAdd', usage: '/xp add <player> <amount>', permission: 'hytale.command.xp' },
      { command: '/xp set', description: 'help.commands.xpSet', usage: '/xp set <player> <amount>', permission: 'hytale.command.xp' },
      { command: '/level add', description: 'help.commands.levelAdd', usage: '/level add <player> <amount>', permission: 'hytale.command.level' },
      { command: '/level set', description: 'help.commands.levelSet', usage: '/level set <player> <amount>', permission: 'hytale.command.level' },
    ]
  },
  {
    id: 'debug',
    labelKey: 'help.categories.debug',
    icon: 'debug',
    commands: [
      { command: '/debug', description: 'help.commands.debug', usage: '/debug [on|off]', permission: 'hytale.command.debug' },
      { command: '/tps', description: 'help.commands.tps', usage: '/tps', permission: 'hytale.command.tps' },
      { command: '/gc', description: 'help.commands.gc', usage: '/gc', permission: 'hytale.command.gc' },
      { command: '/memory', description: 'help.commands.memory', usage: '/memory', permission: 'hytale.command.memory' },
      { command: '/chunk load', description: 'help.commands.chunkLoad', usage: '/chunk load <x> <z>', permission: 'hytale.command.chunk' },
      { command: '/chunk unload', description: 'help.commands.chunkUnload', usage: '/chunk unload <x> <z>', permission: 'hytale.command.chunk' },
      { command: '/log level', description: 'help.commands.logLevel', usage: '/log level <debug|info|warn|error>', permission: 'hytale.command.log' },
    ]
  },
]

const allCategories = computed(() => [
  { id: 'all', labelKey: 'help.categories.all', icon: 'all' },
  ...categories
])

const filteredCommands = computed(() => {
  let commands: (Command & { categoryId: string })[] = []

  if (activeCategory.value === 'all') {
    categories.forEach(cat => {
      cat.commands.forEach(cmd => {
        commands.push({ ...cmd, categoryId: cat.id })
      })
    })
  } else {
    const category = categories.find(c => c.id === activeCategory.value)
    if (category) {
      category.commands.forEach(cmd => {
        commands.push({ ...cmd, categoryId: category.id })
      })
    }
  }

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    commands = commands.filter(cmd =>
      cmd.command.toLowerCase().includes(query) ||
      t(cmd.description).toLowerCase().includes(query) ||
      cmd.usage.toLowerCase().includes(query)
    )
  }

  return commands
})

const commandCount = computed(() => {
  let total = 0
  categories.forEach(cat => {
    total += cat.commands.length
  })
  return total
})

function copyCommand(usage: string) {
  navigator.clipboard.writeText(usage)
  copiedCommand.value = usage
  setTimeout(() => {
    copiedCommand.value = null
  }, 2000)
}

function getCategoryLabel(id: string): string {
  const cat = categories.find(c => c.id === id)
  return cat ? t(cat.labelKey) : id
}
</script>

<template>
  <div class="h-[calc(100vh-8rem)] flex flex-col">
    <!-- Page Title -->
    <div class="mb-6 flex-shrink-0">
      <h1 class="text-2xl font-bold text-white">{{ t('help.title') }}</h1>
      <p class="text-gray-400 mt-1">{{ t('help.subtitle', { count: commandCount }) }}</p>
    </div>

    <!-- Main Content -->
    <div class="flex-1 flex gap-6 min-h-0 overflow-hidden">
      <!-- Sidebar Categories -->
      <Card class="w-64 flex-shrink-0 flex flex-col" :padding="false">
        <div class="p-4 border-b border-dark-50/50 flex-shrink-0">
          <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">{{ t('help.categoriesTitle') }}</h3>
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
                : 'text-gray-400 hover:bg-dark-50/50 hover:text-white'
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
            <!-- Teleport Icon -->
            <svg v-else-if="cat.icon === 'teleport'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <!-- Entities Icon -->
            <svg v-else-if="cat.icon === 'entities'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <!-- Blocks Icon -->
            <svg v-else-if="cat.icon === 'blocks'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <!-- XP Icon -->
            <svg v-else-if="cat.icon === 'xp'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <!-- Debug Icon -->
            <svg v-else-if="cat.icon === 'debug'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span class="text-sm font-medium">{{ t(cat.labelKey) }}</span>
          </button>
        </div>
      </Card>

      <!-- Commands List -->
      <Card class="flex-1 flex flex-col min-h-0" :padding="false">
        <!-- Search Bar -->
        <div class="p-4 border-b border-dark-50/50 flex-shrink-0">
          <div class="relative">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('help.searchPlaceholder')"
              class="w-full pl-10 pr-4 py-2.5 bg-dark-100 border border-dark-50/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange/50 focus:ring-1 focus:ring-hytale-orange/50 transition-colors"
            />
          </div>
        </div>

        <!-- Commands -->
        <div class="flex-1 overflow-y-auto p-4">
          <div v-if="filteredCommands.length === 0" class="flex flex-col items-center justify-center h-full text-gray-500">
            <svg class="w-12 h-12 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>{{ t('help.noResults') }}</p>
          </div>

          <div v-else class="space-y-3">
            <div
              v-for="(cmd, index) in filteredCommands"
              :key="`${cmd.command}-${index}`"
              class="bg-dark-100 rounded-lg p-4 hover:bg-dark-50/50 transition-colors group"
            >
              <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-3 mb-2">
                    <code class="text-hytale-orange font-mono text-base font-semibold">{{ cmd.command }}</code>
                    <span
                      v-if="activeCategory === 'all'"
                      class="px-2 py-0.5 text-xs rounded bg-dark-200 text-gray-400"
                    >
                      {{ getCategoryLabel(cmd.categoryId) }}
                    </span>
                  </div>
                  <p class="text-gray-300 text-sm mb-3">{{ t(cmd.description) }}</p>
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-500 uppercase font-semibold">{{ t('help.usage') }}:</span>
                    <code class="text-sm text-gray-300 font-mono bg-dark-200 px-2 py-1 rounded">{{ cmd.usage }}</code>
                  </div>
                  <div v-if="cmd.permission" class="mt-2 flex items-center gap-2">
                    <span class="text-xs text-gray-500 uppercase font-semibold">{{ t('help.permission') }}:</span>
                    <code class="text-xs text-gray-400 font-mono">{{ cmd.permission }}</code>
                  </div>
                </div>
                <button
                  @click="copyCommand(cmd.usage)"
                  :class="[
                    'p-2 rounded-lg transition-all flex-shrink-0',
                    copiedCommand === cmd.usage
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-dark-200 text-gray-400 hover:text-white hover:bg-dark-50/50 opacity-0 group-hover:opacity-100'
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
        <div class="p-4 border-t border-dark-50/50 bg-dark-100/50 flex-shrink-0">
          <div class="flex items-center justify-between text-sm text-gray-500">
            <span>{{ t('help.commandsShown', { shown: filteredCommands.length, total: commandCount }) }}</span>
            <div class="flex items-center gap-4">
              <div class="flex items-center gap-2">
                <span class="text-xs">{{ t('help.tipPrefix') }}:</span>
                <code class="text-xs bg-dark-200 px-1.5 py-0.5 rounded text-gray-400">~</code>
                <span class="text-xs">{{ t('help.tipRelative') }}</span>
              </div>
              <div class="flex items-center gap-2">
                <code class="text-xs bg-dark-200 px-1.5 py-0.5 rounded text-gray-400">@a @p @r @s</code>
                <span class="text-xs">{{ t('help.tipSelectors') }}</span>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
