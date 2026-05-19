<script setup lang="ts">
withDefaults(defineProps<{
  title?: string
  description?: string
  /** Visual size variant */
  size?: 'sm' | 'md' | 'lg'
}>(), {
  size: 'md',
})
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center"
    :class="{
      'py-8 px-4': size === 'sm',
      'py-12 px-6': size === 'md',
      'py-20 px-8': size === 'lg',
    }"
    role="status"
  >
    <div
      v-if="$slots.icon"
      class="mb-4 flex items-center justify-center rounded-2xl bg-surface-muted/60 text-ink-muted"
      :class="{
        'w-12 h-12': size === 'sm',
        'w-16 h-16': size === 'md',
        'w-20 h-20': size === 'lg',
      }"
    >
      <slot name="icon" />
    </div>
    <h3
      v-if="title || $slots.title"
      class="font-semibold text-ink"
      :class="{
        'text-base': size === 'sm',
        'text-lg': size === 'md',
        'text-xl': size === 'lg',
      }"
    >
      <slot name="title">{{ title }}</slot>
    </h3>
    <p
      v-if="description || $slots.description"
      class="mt-1 max-w-md text-sm text-ink-muted"
    >
      <slot name="description">{{ description }}</slot>
    </p>
    <div v-if="$slots.actions || $slots.default" class="mt-5 flex flex-wrap items-center justify-center gap-2">
      <slot name="actions" />
      <slot />
    </div>
  </div>
</template>
