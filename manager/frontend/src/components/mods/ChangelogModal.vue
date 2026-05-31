<script setup lang="ts">
// Self-contained modal that renders a mod's changelog HTML.
// Extracted from views/Mods.vue as part of the components/mods/* split.
// Open/close state is owned by the parent via v-model:visible.
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  visible: boolean
  title: string
  // The changelog is rendered with v-html and is assumed to be sanitized
  // by the caller (the mod registries already return HTML/markdown).
  content: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

function close(): void {
  emit('update:visible', false)
}
</script>

<template>
  <div
    v-if="visible"
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
    @click.self="close"
  >
    <div class="bg-surface-raised rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
      <!-- Modal Header -->
      <div class="p-4 border-b border-border/50 flex items-center justify-between shrink-0">
        <h2 class="text-xl font-bold text-white">{{ t('mods.changelog') }}: {{ title }}</h2>
        <button @click="close" class="text-gray-400 hover:text-white">
          <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Modal Content -->
      <div class="flex-1 overflow-y-auto p-4">
        <div
          class="prose prose-invert prose-sm max-w-none text-gray-300"
          v-html="content"
        />
      </div>

      <!-- Modal Footer -->
      <div class="p-4 border-t border-border/50 shrink-0">
        <button
          @click="close"
          class="w-full px-4 py-2 bg-surface-overlay hover:bg-surface-overlay text-white rounded-lg transition-colors"
        >
          {{ t('common.close') }}
        </button>
      </div>
    </div>
  </div>
</template>
