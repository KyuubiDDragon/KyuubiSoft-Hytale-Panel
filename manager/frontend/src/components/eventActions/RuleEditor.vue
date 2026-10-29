<script setup lang="ts">
import { computed, reactive, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import WarningList from './WarningList.vue'
import type { EventActionInput, EventActionType, EventActionWarning } from '@/api/eventActions'
import {
  groupEvents,
  hasErrors,
  localWarnings,
  MAX_RULE_NAME_LENGTH,
  MAX_TEMPLATE_LENGTH,
  placeholdersFor,
  validateInput,
  type FormErrors,
} from './eventActionForm'

const props = defineProps<{
  /** Starting values (an existing rule or a template) */
  initial: EventActionInput
  /** True when an existing rule is edited */
  editing: boolean
  events: string[]
  servers: { id: string; name: string }[]
  /** False for accounts that may only use some servers */
  allowAllServers: boolean
  /** May the account create command rules? */
  canUseCommand: boolean
  saving: boolean
}>()

const emit = defineEmits<{
  save: [input: EventActionInput]
  cancel: []
}>()

const { t } = useI18n()
const uid = useId()
const ids = {
  server: `${uid}-server`,
  event: `${uid}-event`,
  action: `${uid}-action`,
  command: `${uid}-command`,
  message: `${uid}-message`,
}

const form = reactive<EventActionInput>({ ...props.initial })
const submitted = ref(false)

const groups = computed(() => groupEvents(props.events))
const errors = computed<FormErrors>(() => validateInput(form, props.events))
/** Errors are shown after the first save attempt, not while typing the first characters. */
const shownErrors = computed<FormErrors>(() => (submitted.value ? errors.value : {}))
const warnings = computed<EventActionWarning[]>(() => localWarnings(form))
const placeholders = computed(() => placeholdersFor(form.eventPattern))

// A command rule can only be kept by an account that may create them.
const actionTypes = computed<EventActionType[]>(() =>
  props.canUseCommand || form.actionType === 'command'
    ? ['announce', 'command', 'backup']
    : ['announce', 'backup'],
)

const textKey = computed<'command' | 'message' | null>(() =>
  form.actionType === 'command' ? 'command' : form.actionType === 'announce' ? 'message' : null,
)

function errorText(key: string | undefined): string | undefined {
  if (!key) return undefined
  return t(key, { max: key.endsWith('nameTooLong') ? MAX_RULE_NAME_LENGTH : MAX_TEMPLATE_LENGTH })
}

function placeholderLabel(key: string): string {
  return `{${key}}`
}

function insertPlaceholder(key: string) {
  const field = textKey.value
  if (!field) return
  form[field] = `${form[field]}{${key}}`
}

function submit() {
  submitted.value = true
  if (hasErrors(errors.value)) return
  emit('save', { ...form })
}
</script>

<template>
  <Card :title="editing ? t('eventActions.editor.titleEdit') : t('eventActions.editor.titleNew')">
    <form class="space-y-5" novalidate @submit.prevent="submit">
      <Input
        v-model="form.name"
        :label="t('eventActions.editor.name')"
        :placeholder="t('eventActions.editor.namePlaceholder')"
        :error="errorText(shownErrors.name)"
        required
      />

      <div class="grid gap-5 md:grid-cols-2">
        <div v-if="servers.length > 0">
          <label :for="ids.server" class="label">{{ t('eventActions.editor.server') }}</label>
          <select :id="ids.server" v-model="form.serverId" class="input">
            <option v-if="allowAllServers" value="">{{ t('eventActions.editor.allServers') }}</option>
            <option v-for="server in servers" :key="server.id" :value="server.id">{{ server.name }}</option>
          </select>
        </div>

        <div>
          <label :for="ids.event" class="label">
            {{ t('eventActions.editor.event') }}<span class="ml-0.5 text-status-error" aria-hidden="true">*</span>
          </label>
          <select
            :id="ids.event"
            v-model="form.eventPattern"
            class="input"
            :class="{ 'input-error': shownErrors.eventPattern }"
            :aria-invalid="shownErrors.eventPattern ? 'true' : undefined"
          >
            <option value="" disabled>{{ t('eventActions.editor.eventPlaceholder') }}</option>
            <option value="*">* ({{ t('eventActions.editor.everyEvent') }})</option>
            <optgroup v-for="group in groups" :key="group.category" :label="group.category">
              <option :value="group.wildcard">{{ group.wildcard }} ({{ t('eventActions.editor.everyInCategory') }})</option>
              <option v-for="name in group.events" :key="name" :value="name">{{ name }}</option>
            </optgroup>
          </select>
          <p v-if="shownErrors.eventPattern" class="mt-1 text-sm text-status-error" role="alert">
            {{ errorText(shownErrors.eventPattern) }}
          </p>
          <p v-else class="mt-1 text-xs text-ink-subtle">{{ t('eventActions.editor.eventHint') }}</p>
        </div>
      </div>

      <div>
        <label :for="ids.action" class="label">{{ t('eventActions.editor.action') }}</label>
        <select :id="ids.action" v-model="form.actionType" class="input md:max-w-xs">
          <option v-for="type in actionTypes" :key="type" :value="type">{{ t(`eventActions.actionTypes.${type}`) }}</option>
        </select>
        <p class="mt-1 text-xs text-ink-subtle">{{ t(`eventActions.actionHints.${form.actionType}`) }}</p>
        <p v-if="!canUseCommand" class="mt-1 text-xs text-ink-subtle">{{ t('eventActions.editor.noCommandRight') }}</p>
      </div>

      <div v-if="form.actionType === 'command'">
        <label :for="ids.command" class="label">
          {{ t('eventActions.editor.command') }}<span class="ml-0.5 text-status-error" aria-hidden="true">*</span>
        </label>
        <input
          :id="ids.command"
          v-model="form.command"
          type="text"
          autocomplete="off"
          class="input font-mono text-sm"
          :class="{ 'input-error': shownErrors.command }"
          :placeholder="t('eventActions.editor.commandPlaceholder')"
          :aria-invalid="shownErrors.command ? 'true' : undefined"
        />
        <p v-if="shownErrors.command" class="mt-1 text-sm text-status-error" role="alert">{{ errorText(shownErrors.command) }}</p>
      </div>

      <div v-else-if="form.actionType === 'announce'">
        <label :for="ids.message" class="label">
          {{ t('eventActions.editor.message') }}<span class="ml-0.5 text-status-error" aria-hidden="true">*</span>
        </label>
        <input
          :id="ids.message"
          v-model="form.message"
          type="text"
          autocomplete="off"
          class="input"
          :class="{ 'input-error': shownErrors.message }"
          :placeholder="t('eventActions.editor.messagePlaceholder')"
          :aria-invalid="shownErrors.message ? 'true' : undefined"
        />
        <p v-if="shownErrors.message" class="mt-1 text-sm text-status-error" role="alert">{{ errorText(shownErrors.message) }}</p>
      </div>

      <div v-if="textKey" class="space-y-2">
        <p class="text-xs text-ink-subtle">{{ t('eventActions.editor.placeholdersHint') }}</p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="key in placeholders"
            :key="key"
            type="button"
            class="rounded-md border border-border bg-surface-sunken px-2 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-hytale-orange hover:text-ink"
            @click="insertPlaceholder(key)"
          >
            {{ placeholderLabel(key) }}
          </button>
        </div>
      </div>

      <WarningList :warnings="warnings" />

      <label class="flex items-center gap-2 text-sm text-ink">
        <input
          v-model="form.enabled"
          type="checkbox"
          class="h-5 w-5 rounded border-border-strong bg-surface-sunken text-hytale-orange focus:ring-hytale-orange"
        />
        {{ t('eventActions.editor.enabled') }}
      </label>

      <div class="flex justify-end gap-3 border-t border-border pt-4">
        <Button variant="secondary" :disabled="saving" @click="emit('cancel')">{{ t('common.cancel') }}</Button>
        <Button type="submit" :loading="saving">{{ t('common.save') }}</Button>
      </div>
    </form>
  </Card>
</template>
