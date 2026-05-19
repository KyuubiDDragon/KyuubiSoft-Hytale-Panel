<script setup lang="ts">
withDefaults(defineProps<{
  /** Width as Tailwind class or raw CSS value */
  width?: string
  /** Height as Tailwind class or raw CSS value */
  height?: string
  /** Border radius: 'sm' | 'md' | 'lg' | 'full' */
  rounded?: 'sm' | 'md' | 'lg' | 'full'
  /** Render as a circle (avatar/icon placeholder) */
  circle?: boolean
}>(), {
  rounded: 'md',
})
</script>

<template>
  <div
    class="skeleton"
    :class="[
      circle ? 'rounded-full' : `rounded-${rounded}`,
    ]"
    :style="{
      width: width || (circle ? '2.5rem' : '100%'),
      height: height || (circle ? '2.5rem' : '1rem'),
    }"
    aria-hidden="true"
  />
</template>
