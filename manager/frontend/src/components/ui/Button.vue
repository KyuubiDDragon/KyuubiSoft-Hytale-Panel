<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  disabled?: boolean
  /** Render as block-level (full width) */
  block?: boolean
  /** Make icon-only square button with min touch target */
  iconOnly?: boolean
  /** Accessible label, falls back to slot text */
  ariaLabel?: string
  /** Native button type */
  type?: 'button' | 'submit' | 'reset'
}>(), {
  variant: 'primary',
  size: 'md',
  loading: false,
  disabled: false,
  block: false,
  iconOnly: false,
  type: 'button',
})

const classes = computed(() => {
  const base = 'btn'
  const variantClass = `btn-${props.variant}`
  const sizeClass = props.size !== 'md' ? `btn-${props.size}` : ''
  const extras: string[] = []
  if (props.block) extras.push('w-full')
  if (props.iconOnly) {
    extras.push(props.size === 'sm' ? 'h-8 w-8 !px-0' : props.size === 'lg' ? 'h-12 w-12 !px-0' : 'h-10 w-10 !px-0')
  }
  return [base, variantClass, sizeClass, ...extras].filter(Boolean).join(' ')
})
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
    :aria-label="ariaLabel"
    :aria-busy="loading || undefined"
    class="disabled:opacity-50 disabled:cursor-not-allowed"
  >
    <svg
      v-if="loading"
      class="animate-spin h-4 w-4"
      :class="iconOnly ? '' : '-ml-1 mr-2'"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        class="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="4"
      />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
    <slot />
  </button>
</template>
