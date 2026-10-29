<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '@/components/ui/Modal.vue'
import Button from '@/components/ui/Button.vue'
import type { ModPanelAction, ModPanelParam, ModPanelValue } from '@/api/modPanel'

/**
 * Asks before a mod action runs: shows its description and the mod's
 * confirmation question and collects its parameters. The plugin checks the
 * values again; the checks here only spare a round trip.
 */
const props = defineProps<{
  open: boolean
  action: ModPanelAction | null
  running?: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [params: Record<string, ModPanelValue>]
}>()

const { t } = useI18n()
const values = reactive<Record<string, ModPanelValue>>({})

watch(
  () => [props.open, props.action] as const,
  ([open, action]) => {
    if (!open || !action) return
    for (const key of Object.keys(values)) delete values[key]
    for (const param of action.params) {
      values[param.id] = param.defaultValue ?? (param.type === 'boolean' ? false : '')
    }
  },
  { immediate: true },
)

function missing(param: ModPanelParam): boolean {
  const value = values[param.id]
  return param.required && param.type !== 'boolean' && (value === '' || value === null || value === undefined)
}

const canSubmit = computed(() => !!props.action && !props.action.params.some(missing))

function submit(): void {
  if (!props.action || !canSubmit.value) return
  const params: Record<string, ModPanelValue> = {}
  for (const param of props.action.params) {
    const value = values[param.id]
    if (value === '' || value === undefined) continue
    params[param.id] = param.type === 'number' && typeof value === 'string' ? Number(value) : value
  }
  emit('submit', params)
}
</script>

<template>
  <Modal :open="open" :title="action?.label" @close="emit('close')">
    <form v-if="action" class="space-y-4" @submit.prevent="submit">
      <p v-if="action.description" class="text-sm text-ink-muted">{{ action.description }}</p>

      <div
        v-if="action.requiresConfirmation"
        class="rounded-lg border px-3 py-2 text-sm"
        :class="action.dangerous
          ? 'border-status-error/40 bg-status-error/10 text-status-error'
          : 'border-status-warning/40 bg-status-warning/10 text-status-warning'"
        role="alert"
      >
        {{ action.confirmation || t('modPanel.confirmDefault') }}
      </div>

      <div v-for="param in action.params" :key="param.id">
        <label v-if="param.type !== 'boolean'" class="label" :for="`mod-param-${param.id}`">
          {{ param.label }}<span v-if="param.required" class="text-status-error"> *</span>
        </label>

        <select
          v-if="param.type === 'choice'"
          :id="`mod-param-${param.id}`"
          v-model="values[param.id]"
          class="input"
        >
          <option v-if="!param.required" value="">–</option>
          <option v-for="choice in param.choices ?? []" :key="choice" :value="choice">{{ choice }}</option>
        </select>

        <label v-else-if="param.type === 'boolean'" class="flex items-center gap-2 text-sm text-ink">
          <input :id="`mod-param-${param.id}`" v-model="values[param.id]" type="checkbox" class="rounded" />
          {{ param.label }}
        </label>

        <input
          v-else-if="param.type === 'number'"
          :id="`mod-param-${param.id}`"
          v-model="values[param.id]"
          type="number"
          class="input"
          :min="param.min ?? undefined"
          :max="param.max ?? undefined"
          :step="param.integer ? 1 : 'any'"
          :required="param.required"
        />

        <input
          v-else
          :id="`mod-param-${param.id}`"
          v-model="values[param.id]"
          type="text"
          class="input"
          :maxlength="param.maxLength ?? 200"
          :required="param.required"
        />

        <p v-if="param.hint" class="text-xs text-ink-subtle mt-1">{{ param.hint }}</p>
      </div>
    </form>

    <template #footer>
      <Button variant="secondary" :disabled="running" @click="emit('close')">{{ t('common.cancel') }}</Button>
      <Button
        :variant="action?.dangerous ? 'danger' : 'primary'"
        :loading="running"
        :disabled="!canSubmit"
        @click="submit"
      >
        {{ t('modPanel.run') }}
      </Button>
    </template>
  </Modal>
</template>
