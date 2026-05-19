<script setup lang="ts">
// Search + sort + classification + tag filter bar shared by the store tabs.
//
// SCAFFOLDING: each external source currently has a slightly different
// filter row inline in views/Mods.vue (Modtale uses tags + classification,
// StackMart uses category + sort, CurseForge uses sortField). When the
// extraction pass runs, replace those filter rows with this component and
// drive them via v-model bindings — the parent will continue to own the
// search state and trigger reloads.
defineProps<{
  /** Source whose filter UI is being rendered. */
  source: 'modtale' | 'stackmart' | 'curseforge' | 'store'
  /** Free-text search query. */
  search: string
  /** Sort key (string union per source). */
  sort: string
  /** Optional category/classification filter. */
  category?: string
  /** Optional tag list (used by Modtale). */
  tags?: string[]
  /** Available tags (used by Modtale) for the dropdown. */
  availableTags?: string[]
  /** Status filter (enabled/disabled/has-update) — used on the installed tab. */
  status?: 'all' | 'enabled' | 'disabled' | 'has-update'
}>()

defineEmits<{
  (e: 'update:search', value: string): void
  (e: 'update:sort', value: string): void
  (e: 'update:category', value: string): void
  (e: 'update:tags', value: string[]): void
  (e: 'update:status', value: 'all' | 'enabled' | 'disabled' | 'has-update'): void
  (e: 'submit'): void
}>()
</script>

<template>
  <div :data-component="`mods-filter-${source}`" />
</template>
