<script setup lang="ts">
// How a setting of a file the game server owns takes effect: "live" on the
// running server (by command), or "restart" (read when the server starts).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ mode: 'live' | 'restart' }>()
const { t } = useI18n()

const label = computed(() => t(`serverFiles.apply.${props.mode}`))
const hint = computed(() => t(`serverFiles.apply.${props.mode}Hint`))
</script>

<template>
  <span
    class="ml-2 inline-flex items-center rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide"
    :class="mode === 'live' ? 'bg-status-success/15 text-status-success' : 'bg-status-warning/15 text-status-warning'"
    :title="hint"
  >
    {{ label }}
  </span>
</template>
