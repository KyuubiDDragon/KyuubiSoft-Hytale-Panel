<script setup lang="ts">
// Installed mods + plugins list panel.
//
// SCAFFOLDING: this component is the target landing zone for the "installed
// mods" tab and the "installed plugins" tab UI currently rendered inline by
// views/Mods.vue. The props + emits below mirror the surface area that the
// parent currently passes to the inline templates: a list of items, a path
// label, and callback handlers for enable/disable/uninstall/configure.
//
// The actual list-template extraction is deferred to a follow-up PR so the
// big Mods.vue stays behavior-identical for now. When that extraction
// happens, move the corresponding `<div class="space-y-2">` block from
// views/Mods.vue into this component verbatim and rewire the handlers via
// the existing emits.
import type { ModInfo } from '@/api/management'

defineProps<{
  /** Whether this list shows mods (true) or plugins (false). Drives label + permission keys. */
  kind: 'mod' | 'plugin'
  /** The items to render. */
  items: ModInfo[]
  /** Directory path label shown above the list. */
  path: string
  /** Disable interactive controls (e.g., while parent reloads). */
  loading?: boolean
}>()

defineEmits<{
  (e: 'toggle', filename: string): void
  (e: 'uninstall', filename: string): void
  (e: 'configure', item: ModInfo): void
  (e: 'update', item: ModInfo): void
}>()
</script>

<template>
  <!--
    Placeholder template. See script-block comment: the inline list block from
    views/Mods.vue should be moved here verbatim during the next pass and its
    handlers rewired to call the emits declared above.
  -->
  <div :data-component="`mods-list-${kind}`" />
</template>
