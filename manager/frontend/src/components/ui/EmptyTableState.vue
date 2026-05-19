<script setup lang="ts">
import Icon from './Icon.vue'

/**
 * EmptyTableState — atom for empty table/list views.
 *
 * Light wrapper around the shared "centered illustration + copy" pattern. Use
 * the default slot for a CTA button. Reads design tokens (surface/ink/border)
 * so it adapts to both themes without overrides.
 */
withDefaults(defineProps<{
  /** Icon name from the Icon component */
  icon?: string
  title: string
  subtitle?: string
  /** Visual scale */
  size?: 'sm' | 'md' | 'lg'
  /** Render inside a bordered "card" frame */
  framed?: boolean
}>(), {
  icon: 'players',
  size: 'md',
  framed: true,
})
</script>

<template>
  <div
    role="status"
    class="flex flex-col items-center justify-center text-center"
    :class="[
      framed ? 'rounded-xl border border-border/60 bg-surface-raised' : '',
      size === 'sm' ? 'py-8 px-4' : '',
      size === 'md' ? 'py-12 px-6' : '',
      size === 'lg' ? 'py-16 px-8' : '',
    ]"
  >
    <div
      class="mb-3 flex items-center justify-center rounded-2xl bg-surface-muted/60 text-ink-muted"
      :class="{
        'w-12 h-12': size === 'sm',
        'w-16 h-16': size === 'md',
        'w-20 h-20': size === 'lg',
      }"
    >
      <slot name="icon">
        <Icon :name="icon" class="w-1/2 h-1/2" />
      </slot>
    </div>
    <h3
      class="font-semibold text-ink"
      :class="{
        'text-base': size === 'sm',
        'text-lg': size === 'md',
        'text-xl': size === 'lg',
      }"
    >
      {{ title }}
    </h3>
    <p v-if="subtitle" class="mt-1 max-w-md text-sm text-ink-muted">
      {{ subtitle }}
    </p>
    <div v-if="$slots.default" class="mt-5 flex flex-wrap items-center justify-center gap-2">
      <slot />
    </div>
  </div>
</template>
