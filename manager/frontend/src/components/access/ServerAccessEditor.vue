<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useServersStore } from '@/stores/servers'

/**
 * Which servers an account or API key may use.
 *
 * `null` means every server, now and in the future (the backend stores no
 * list). An array limits the account to exactly those servers, and an empty
 * array means none at all.
 */
const props = defineProps<{
  modelValue: string[] | null
  disabled?: boolean
  /** Label of the "all servers" choice; the default fits an account. */
  allLabel?: string
  /** Shown under the "all servers" choice. */
  allHint?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string[] | null] }>()

const { t } = useI18n()
const serversStore = useServersStore()

const restricted = computed(() => props.modelValue !== null)

// With multiserver off the choice is moot: hide it, and show an existing list read-only.
const multiserverOff = computed(() => serversStore.canList && !serversStore.multiserverEnabled)
const visible = computed(() => !multiserverOff.value || restricted.value)
const locked = computed(() => props.disabled === true || multiserverOff.value)

/** Registered servers, plus ids on the list that this viewer cannot see. */
const options = computed(() => {
  const known = serversStore.servers.map((s) => ({ id: s.id, name: s.name }))
  const knownIds = new Set(known.map((s) => s.id))
  const extra = (props.modelValue ?? []).filter((id) => !knownIds.has(id)).map((id) => ({ id, name: id }))
  return [...known, ...extra]
})

function setMode(all: boolean) {
  if (all) emit('update:modelValue', null)
  else emit('update:modelValue', props.modelValue ?? [])
}

function toggle(id: string, on: boolean) {
  const current = props.modelValue ?? []
  emit('update:modelValue', on ? [...current, id] : current.filter((x) => x !== id))
}
</script>

<template>
  <fieldset v-if="visible" class="space-y-2" :disabled="locked">
    <legend class="block text-sm text-ink-muted mb-1">{{ t('serverAccess.title') }}</legend>
    <label class="flex items-start gap-2 text-sm text-ink">
      <input type="radio" class="mt-1" :checked="!restricted" @change="setMode(true)" />
      <span>
        {{ allLabel ?? t('serverAccess.all') }}
        <span class="block text-[11px] text-ink-subtle">{{ allHint ?? t('serverAccess.allHint') }}</span>
      </span>
    </label>
    <label class="flex items-start gap-2 text-sm text-ink">
      <input type="radio" class="mt-1" :checked="restricted" @change="setMode(false)" />
      <span>{{ t('serverAccess.only') }}</span>
    </label>
    <div v-if="restricted" class="ml-6 space-y-1 max-h-40 overflow-y-auto">
      <label v-for="s in options" :key="s.id" class="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          class="rounded"
          :checked="(modelValue ?? []).includes(s.id)"
          @change="toggle(s.id, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ s.name }}</span>
        <span v-if="s.name !== s.id" class="font-mono text-[11px] text-ink-subtle">{{ s.id }}</span>
      </label>
      <p v-if="options.length === 0" class="text-xs text-ink-subtle">{{ t('serverAccess.noServers') }}</p>
      <p v-if="(modelValue ?? []).length === 0" class="text-xs text-status-warning">
        {{ t('serverAccess.noneSelected') }}
      </p>
    </div>
    <p v-if="restricted" class="text-[11px] text-ink-subtle">{{ t('serverAccess.limitsRights') }}</p>
  </fieldset>
</template>
