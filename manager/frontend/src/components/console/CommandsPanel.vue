<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { HYTALE_COMMANDS, type CommandTierLabel } from '@/utils/hytaleCommands'

const { t } = useI18n()

const isOpen = ref(false)
const activeCategory = ref('players')

interface Command {
  command: string
  description: string
  usage: string
  tier: CommandTierLabel
}

interface Category {
  id: string
  label: string
  commands: Command[]
}

// Hytale 0.7 commands with the syntax the server accepts; the help page lists
// every command of the server.
const categories = computed<Category[]>(() =>
  HYTALE_COMMANDS.map((category) => ({
    id: category.id,
    label: t(`commands.categories.${category.id}`),
    commands: category.commands.map((cmd) => ({
      command: cmd.command,
      usage: cmd.usage,
      tier: cmd.tier,
      description: t(`help.commands.${cmd.key}`),
    })),
  })),
)

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
      class="fixed right-0 top-0 h-full w-96 bg-surface-raised border-l border-border/60 shadow-2xl z-50 flex flex-col"
    >
      <!-- Header -->
      <div class="flex items-center justify-between p-4 border-b border-border/60">
        <h2 class="text-lg font-semibold text-ink">{{ t('commands.title') }}</h2>
        <button @click="toggle" class="p-1 text-ink-muted hover:text-ink transition-colors">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Category Tabs -->
      <div class="flex border-b border-border/60 overflow-x-auto">
        <button
          v-for="cat in categories"
          :key="cat.id"
          @click="activeCategory = cat.id"
          :class="[
            'px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
            activeCategory === cat.id
              ? 'text-hytale-orange border-b-2 border-hytale-orange'
              : 'text-ink-muted hover:text-ink'
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
          class="bg-surface-overlay rounded-lg p-3 hover:bg-surface-overlay/50 transition-colors group"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <code class="text-hytale-orange font-mono text-sm">{{ cmd.command }}</code>
                <span
                  v-if="cmd.tier === 'admin'"
                  class="px-1.5 py-0.5 text-[10px] rounded bg-red-500/15 text-red-400"
                  :title="t('help.tierAdminHint')"
                >
                  {{ t('help.tierAdmin') }}
                </span>
              </div>
              <p class="text-ink-muted text-xs mt-1">{{ cmd.description }}</p>
            </div>
            <button
              @click="copyCommand(cmd.usage)"
              class="p-1.5 text-ink-subtle hover:text-ink opacity-0 group-hover:opacity-100 transition-all"
              :title="t('common.copy')"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
          <div class="mt-2 bg-surface-raised rounded px-2 py-1">
            <code class="text-xs text-ink-muted font-mono">{{ cmd.usage }}</code>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="p-3 border-t border-border/60 text-center space-y-1">
        <p class="text-xs text-ink-subtle">{{ t('commands.clickToCopy') }}</p>
        <p class="text-xs text-ink-subtle">{{ t('help.notInHytale') }}</p>
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
