<script setup lang="ts">
import { computed, useId } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string | number
  type?: string
  placeholder?: string
  error?: string
  hint?: string
  label?: string
  disabled?: boolean
  required?: boolean
  autocomplete?: string
  name?: string
  id?: string
}>(), {
  type: 'text',
  disabled: false,
  required: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const fallbackId = useId ? useId() : `input-${Math.random().toString(36).slice(2, 10)}`
const inputId = computed(() => props.id || fallbackId)
const errorId = computed(() => `${inputId.value}-error`)
const hintId = computed(() => `${inputId.value}-hint`)

const inputClass = computed(() =>
  props.error ? 'input input-error' : 'input'
)

const describedBy = computed(() => {
  const ids: string[] = []
  if (props.error) ids.push(errorId.value)
  if (props.hint && !props.error) ids.push(hintId.value)
  return ids.length > 0 ? ids.join(' ') : undefined
})
</script>

<template>
  <div>
    <label v-if="label || $slots.label" :for="inputId" class="label">
      <slot name="label">{{ label }}</slot>
      <span v-if="required" class="text-status-error ml-0.5" aria-hidden="true">*</span>
    </label>
    <input
      :id="inputId"
      :name="name"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      :autocomplete="autocomplete"
      :class="inputClass"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="describedBy"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <p
      v-if="error"
      :id="errorId"
      class="mt-1 text-sm text-status-error"
      role="alert"
    >
      <slot name="error">{{ error }}</slot>
    </p>
    <p
      v-else-if="hint || $slots.hint"
      :id="hintId"
      class="mt-1 text-xs text-ink-subtle"
    >
      <slot name="hint">{{ hint }}</slot>
    </p>
  </div>
</template>
