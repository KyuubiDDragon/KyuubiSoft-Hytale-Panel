<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Button from './Button.vue'

withDefaults(defineProps<{
  title?: string
  message?: string
  /** When true, shows the retry button (use slot for custom button) */
  showRetry?: boolean
  size?: 'sm' | 'md' | 'lg'
}>(), {
  showRetry: true,
  size: 'md',
})

const emit = defineEmits<{
  retry: []
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center"
    :class="{
      'py-8 px-4': size === 'sm',
      'py-12 px-6': size === 'md',
      'py-20 px-8': size === 'lg',
    }"
    role="alert"
  >
    <div
      class="mb-4 flex items-center justify-center rounded-2xl bg-status-error/15 text-status-error"
      :class="{
        'w-12 h-12': size === 'sm',
        'w-16 h-16': size === 'md',
        'w-20 h-20': size === 'lg',
      }"
    >
      <slot name="icon">
        <svg class="w-1/2 h-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </slot>
    </div>
    <h3 class="font-semibold text-ink text-lg">
      <slot name="title">{{ title || t('common.errorOccurred') }}</slot>
    </h3>
    <p v-if="message || $slots.message" class="mt-1 max-w-md text-sm text-ink-muted">
      <slot name="message">{{ message }}</slot>
    </p>
    <div class="mt-5 flex flex-wrap items-center justify-center gap-2">
      <slot name="actions">
        <Button v-if="showRetry" variant="secondary" size="sm" @click="emit('retry')">
          {{ t('common.retry') }}
        </Button>
      </slot>
    </div>
  </div>
</template>
