<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  title?: string
  /**
   * Padding: boolean (true = default p-5, false = p-0)
   * or string ('none' | 'sm' | 'md' | 'lg')
   */
  padding?: boolean | 'none' | 'sm' | 'md' | 'lg'
  /** Add hover effect (lift + accent border) */
  hoverable?: boolean
}>(), {
  padding: true,
  hoverable: false,
})

const bodyClass = computed(() => {
  if (props.padding === false || props.padding === 'none') return 'p-0'
  if (props.padding === 'sm') return 'p-3'
  if (props.padding === 'lg') return 'p-6'
  // 'md' or true (default)
  return 'card-body'
})
</script>

<template>
  <div class="card" :class="{ 'card-hover': hoverable }">
    <div v-if="title || $slots.header" class="card-header">
      <h3 v-if="title" class="text-lg font-semibold text-ink">{{ title }}</h3>
      <slot name="header" />
      <slot name="header-actions" />
    </div>
    <div :class="bodyClass">
      <slot />
    </div>
    <div v-if="$slots.footer" class="px-5 py-3 border-t border-border/60">
      <slot name="footer" />
    </div>
  </div>
</template>
