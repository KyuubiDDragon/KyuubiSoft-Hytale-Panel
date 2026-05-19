<script setup lang="ts">
// Per-mod update dialog with version diff (current vs. latest) + changelog button.
//
// SCAFFOLDING: the parent currently performs in-place "update" actions via
// updateModFromSource() and surfaces changelogs by opening ChangelogModal.
// This component is intended to host a dedicated modal that previews the
// upcoming version, shows the size delta, and offers update / cancel /
// "show changelog" actions. The eventual extraction should consume the
// existing per-source update endpoints unchanged (modstore.update,
// curseforgeApi.install, modtaleApi.install, stackmartApi.install,
// modupdatesApi.install) so no endpoint URLs change.
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  visible: boolean
  modName: string
  installedVersion: string
  latestVersion: string
  /** Optional changelog HTML — passed through to ChangelogModal when the user requests it. */
  changelog?: string
  /** Update is in progress (parent owns the actual API call). */
  updating?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'confirm'): void
  (e: 'show-changelog'): void
}>()

function close(): void {
  emit('update:visible', false)
}
</script>

<template>
  <div
    v-if="visible"
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
    @click.self="close"
  >
    <div class="bg-dark-200 rounded-xl w-full max-w-md p-4 flex flex-col gap-3">
      <h2 class="text-lg font-bold text-white">{{ t('mods.confirmUpdate', { name: modName }) }}</h2>
      <div class="text-sm text-gray-300">
        <div>{{ t('mods.installedVersion') }}: <span class="font-mono">{{ installedVersion }}</span></div>
        <div>{{ t('mods.latestVersion') }}: <span class="font-mono">{{ latestVersion }}</span></div>
      </div>
      <div class="flex gap-2 justify-end">
        <button
          v-if="changelog"
          @click="emit('show-changelog')"
          class="px-3 py-1.5 bg-dark-100 hover:bg-dark-50 text-white rounded-lg text-sm"
        >
          {{ t('mods.viewChangelog') }}
        </button>
        <button
          @click="close"
          class="px-3 py-1.5 bg-dark-100 hover:bg-dark-50 text-white rounded-lg text-sm"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          :disabled="updating"
          @click="emit('confirm')"
          class="px-3 py-1.5 bg-primary-500 hover:bg-primary-400 disabled:opacity-50 text-white rounded-lg text-sm"
        >
          {{ t('mods.update') }}
        </button>
      </div>
    </div>
  </div>
</template>
