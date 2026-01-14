<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  variant?: 'success' | 'warning' | 'error' | 'info'
}>(), {
  variant: 'info',
})

const classes = computed(() => `badge badge-${props.variant}`)
</script>

<template>
  <span :class="classes">
    <slot />
  </span>
</template>
