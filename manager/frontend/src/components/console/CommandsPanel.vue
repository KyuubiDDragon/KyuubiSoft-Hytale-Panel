<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const isOpen = ref(false)
const activeCategory = ref('player')

interface Command {
  command: string
  description: string
  usage: string
}

interface Category {
  id: string
  label: string
  commands: Command[]
}

const categories = computed<Category[]>(() => [
  {
    id: 'player',
    label: t('commands.categories.player'),
    commands: [
      { command: '/kick', description: t('commands.kick.desc'), usage: '/kick <player> [reason]' },
      { command: '/ban', description: t('commands.ban.desc'), usage: '/ban <player> [reason]' },
      { command: '/unban', description: t('commands.unban.desc'), usage: '/unban <player>' },
      { command: '/op add', description: t('commands.op.desc'), usage: '/op add <player>' },
      { command: '/op remove', description: t('commands.deop.desc'), usage: '/op remove <player>' },
      { command: '/whitelist add', description: t('commands.whitelistAdd.desc'), usage: '/whitelist add <player>' },
      { command: '/whitelist remove', description: t('commands.whitelistRemove.desc'), usage: '/whitelist remove <player>' },
      { command: '/kill', description: t('commands.kill.desc'), usage: '/kill <player>' },
      { command: '/gamemode', description: t('commands.gamemode.desc'), usage: '/gamemode <mode> [player]' },
      { command: '/give', description: t('commands.give.desc'), usage: '/give <player> <item> [amount]' },
      { command: '/player stats settomax', description: t('commands.heal.desc'), usage: '/player stats settomax <player> health' },
      { command: '/player effect apply', description: t('commands.effectApply.desc'), usage: '/player effect apply <player> <effect>' },
      { command: '/player effect clear', description: t('commands.effectClear.desc'), usage: '/player effect clear <player>' },
      { command: '/inventory clear', description: t('commands.inventoryClear.desc'), usage: '/inventory clear <player>' },
    ]
  },
  {
    id: 'teleport',
    label: t('commands.categories.teleport'),
    commands: [
      { command: '/tp', description: t('commands.tpPlayer.desc'), usage: '/tp <player> <target>' },
      { command: '/tp', description: t('commands.tpCoords.desc'), usage: '/tp <player> <x> <y> <z>' },
      { command: '/tp', description: t('commands.tpSelf.desc'), usage: '/tp <target>' },
      { command: '/top', description: t('commands.top.desc'), usage: '/top' },
      { command: '/spawn', description: t('commands.spawn.desc'), usage: '/spawn [player]' },
      { command: '/home', description: t('commands.home.desc'), usage: '/home [player]' },
      { command: '/sethome', description: t('commands.sethome.desc'), usage: '/sethome [player]' },
      { command: '/warp', description: t('commands.warp.desc'), usage: '/warp <name> [player]' },
    ]
  },
  {
    id: 'server',
    label: t('commands.categories.server'),
    commands: [
      { command: '/stop', description: t('commands.stop.desc'), usage: '/stop' },
      { command: '/restart', description: t('commands.restart.desc'), usage: '/restart' },
      { command: '/save', description: t('commands.save.desc'), usage: '/save' },
      { command: '/reload', description: t('commands.reload.desc'), usage: '/reload' },
      { command: '/say', description: t('commands.say.desc'), usage: '/say <message>' },
      { command: '/broadcast', description: t('commands.broadcast.desc'), usage: '/broadcast <message>' },
      { command: '/list', description: t('commands.list.desc'), usage: '/list' },
      { command: '/server stats memory', description: t('commands.memory.desc'), usage: '/server stats memory' },
      { command: '/tps', description: t('commands.tps.desc'), usage: '/tps' },
      { command: '/gc', description: t('commands.gc.desc'), usage: '/gc' },
    ]
  },
  {
    id: 'world',
    label: t('commands.categories.world'),
    commands: [
      { command: '/world list', description: t('commands.worldList.desc'), usage: '/world list' },
      { command: '/world create', description: t('commands.worldCreate.desc'), usage: '/world create <name>' },
      { command: '/world load', description: t('commands.worldLoad.desc'), usage: '/world load <name>' },
      { command: '/time set', description: t('commands.timeSet.desc'), usage: '/time set <day|night|noon|value>' },
      { command: '/weather', description: t('commands.weather.desc'), usage: '/weather <clear|rain|storm>' },
      { command: '/difficulty', description: t('commands.difficulty.desc'), usage: '/difficulty <peaceful|easy|normal|hard>' },
    ]
  },
])

const activeCommands = computed(() => {
  return categories.value.find(c => c.id === activeCategory.value)?.commands || []
})

function toggle() {
  isOpen.value = !isOpen.value
}

function copyCommand(usage: string) {
  navigator.clipboard.writeText(usage)
}

defineExpose({ toggle, isOpen })
</script>

<template>
  <!-- Toggle Button -->
  <button
    @click="toggle"
    class="fixed right-4 bottom-20 z-40 p-3 bg-hytale-orange text-white rounded-full shadow-lg hover:bg-hytale-orange/90 transition-all"
    :title="t('commands.title')"
  >
    <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  </button>

  <!-- Slide-out Panel -->
  <Transition name="slide">
    <div
      v-if="isOpen"
      class="fixed right-0 top-0 h-full w-96 bg-dark-200 border-l border-dark-50/50 shadow-2xl z-50 flex flex-col"
    >
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-dark-50/50">
        <h2 class="text-lg font-semibold text-white">{{ t('commands.title') }}</h2>
        <button @click="toggle" class="p-1 text-gray-400 hover:text-white transition-colors">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Category Tabs -->
      <div class="flex border-b border-dark-50/50 overflow-x-auto">
        <button
          v-for="cat in categories"
          :key="cat.id"
          @click="activeCategory = cat.id"
          :class="[
            'px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
            activeCategory === cat.id
              ? 'text-hytale-orange border-b-2 border-hytale-orange'
              : 'text-gray-400 hover:text-white'
          ]"
        >
          {{ cat.label }}
        </button>
      </div>

      <!-- Commands List -->
      <div class="flex-1 overflow-y-auto p-4 space-y-3">
        <div
          v-for="cmd in activeCommands"
          :key="cmd.usage"
          class="bg-dark-100 rounded-lg p-3 hover:bg-dark-50/50 transition-colors group"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1 min-w-0">
              <code class="text-hytale-orange font-mono text-sm">{{ cmd.command }}</code>
              <p class="text-gray-400 text-xs mt-1">{{ cmd.description }}</p>
            </div>
            <button
              @click="copyCommand(cmd.usage)"
              class="p-1.5 text-gray-500 hover:text-white opacity-0 group-hover:opacity-100 transition-all"
              :title="t('common.copy')"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
          <div class="mt-2 bg-dark-200 rounded px-2 py-1">
            <code class="text-xs text-gray-300 font-mono">{{ cmd.usage }}</code>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="p-3 border-t border-dark-50/50 text-center">
        <p class="text-xs text-gray-500">{{ t('commands.clickToCopy') }}</p>
      </div>
    </div>
  </Transition>

  <!-- Backdrop -->
  <Transition name="fade">
    <div
      v-if="isOpen"
      @click="toggle"
      class="fixed inset-0 bg-black/50 z-40"
    ></div>
  </Transition>
</template>

<style scoped>
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.3s ease;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
