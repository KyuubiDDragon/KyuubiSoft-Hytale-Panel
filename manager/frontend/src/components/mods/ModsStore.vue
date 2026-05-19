<script setup lang="ts">
// External mod store browser (CurseForge / Modtale / StackMart / Mod Store).
//
// SCAFFOLDING: this component will host the right-hand "store" tab UI
// currently rendered inline by views/Mods.vue. Each external source is
// driven by its own state slice in the parent today; the eventual
// extraction should accept the source as a prop and emit install / update
// / uninstall actions back to the parent so the registry-API calls in
// useMods can stay shared.
import type {
  ModStoreEntry,
  ModtaleProject,
  StackMartResource,
  CurseForgeMod,
} from '@/api/management'

defineProps<{
  /** Active source tab to render. */
  source: 'store' | 'modtale' | 'stackmart' | 'curseforge'
  /** Mod-store-format entries (the bundled GitHub registry). */
  storeMods?: ModStoreEntry[]
  /** Modtale search/list results. */
  modtaleMods?: ModtaleProject[]
  /** StackMart search/list results. */
  stackmartResources?: StackMartResource[]
  /** CurseForge search/list results. */
  curseforgeMods?: CurseForgeMod[]
  loading?: boolean
}>()

defineEmits<{
  (e: 'install', payload: { source: string; id: string | number }): void
  (e: 'uninstall', payload: { source: string; id: string | number }): void
  (e: 'update', payload: { source: string; id: string | number }): void
  (e: 'open-details', payload: { source: string; id: string | number }): void
}>()
</script>

<template>
  <div :data-component="`mods-store-${source}`" />
</template>
