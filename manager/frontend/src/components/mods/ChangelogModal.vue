<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Button from '@/components/ui/Button.vue'

defineProps<{
  show: boolean
  title: string
  content: string
}>()

defineEmits<{
  close: []
}>()

const { t } = useI18n()
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition ease-out duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition ease-in duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="show"
        class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        @click.self="$emit('close')"
      >
        <div
          class="bg-surface-raised border border-border rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
          role="dialog"
          aria-modal="true"
        >
          <div class="p-4 border-b border-border/60 flex items-center justify-between shrink-0">
            <h2 class="text-xl font-bold text-ink truncate">
              {{ t('mods.changelog') }}<span class="text-ink-muted font-normal">: {{ title }}</span>
            </h2>
            <button
              @click="$emit('close')"
              class="h-10 w-10 inline-flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface-muted transition-colors"
              :aria-label="t('common.close')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-4">
            <div
              class="prose prose-invert prose-sm max-w-none text-ink-muted"
              v-html="content"
            />
          </div>

          <div class="p-4 border-t border-border/60 shrink-0">
            <Button variant="secondary" block @click="$emit('close')">
              {{ t('common.close') }}
            </Button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
