<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { MIN_CPUS, MAX_CPUS, MIN_MEMORY_GIB } from '@/utils/serverLimits'

defineProps<{
  memoryGib: number | null
  cpus: number | null
  disabled?: boolean
}>()

defineEmits<{
  'update:memoryGib': [value: number | null]
  'update:cpus': [value: number | null]
}>()

const { t } = useI18n()

/** An empty input gives NaN; treat it as "no value". */
function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
</script>

<template>
  <div class="grid grid-cols-2 gap-2">
    <div>
      <label class="block text-xs font-semibold text-ink-muted mb-1">{{ t('servers.adm.limits.memory') }}</label>
      <input
        :value="memoryGib ?? ''"
        type="number"
        :min="MIN_MEMORY_GIB"
        step="0.5"
        :disabled="disabled"
        :placeholder="t('servers.adm.limits.inherit')"
        class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
        @input="$emit('update:memoryGib', toNumber(($event.target as HTMLInputElement).valueAsNumber))"
      />
    </div>
    <div>
      <label class="block text-xs font-semibold text-ink-muted mb-1">{{ t('servers.adm.limits.cpus') }}</label>
      <input
        :value="cpus ?? ''"
        type="number"
        :min="MIN_CPUS"
        :max="MAX_CPUS"
        step="0.5"
        :disabled="disabled"
        :placeholder="t('servers.adm.limits.inherit')"
        class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink"
        @input="$emit('update:cpus', toNumber(($event.target as HTMLInputElement).valueAsNumber))"
      />
    </div>
    <p class="col-span-2 text-[11px] text-ink-subtle">
      {{ t('servers.adm.limits.hint', { minMemory: MIN_MEMORY_GIB, minCpus: MIN_CPUS }) }}
    </p>
  </div>
</template>
