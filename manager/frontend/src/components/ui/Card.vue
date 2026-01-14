<script setup lang="ts">
withDefaults(defineProps<{
  title?: string
  padding?: boolean
}>(), {
  padding: true
})
</script>

<template>
  <div class="card">
    <div v-if="title" class="card-header">
      <h3 class="text-lg font-semibold text-white">{{ title }}</h3>
      <slot name="header-actions" />
    </div>
    <div :class="padding ? 'card-body' : 'p-0'">
      <slot />
    </div>
  </div>
</template>
