<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import WarningList from './WarningList.vue'
import type { EventAction, EventActionWarning } from '@/api/eventActions'
import { isManagedRule } from './eventActionForm'

const props = defineProps<{
  rule: EventAction
  /** Name of the rule's server, or the wording for "every server" */
  serverLabel: string
  warnings: EventActionWarning[]
  canEdit: boolean
  canApprove: boolean
  /** May the account run command rules? */
  canUseCommand: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  toggle: []
  edit: []
  delete: []
  approve: []
}>()

const { t } = useI18n()

const managed = computed(() => isManagedRule(props.rule))
/** The editing buttons; hidden for rules the scheduler manages. */
const editable = computed(() => props.canEdit && !managed.value)
/** Turning a command rule on needs the console right; turning it off never does. */
const canToggle = computed(
  () => props.rule.enabled || props.rule.actionType !== 'command' || props.canUseCommand,
)

const actionText = computed(() => {
  const { actionType, actionPayload } = props.rule
  if (actionType === 'command') return actionPayload.command ?? ''
  if (actionType === 'announce') return actionPayload.message ?? ''
  return t('eventActions.actionSummary.backup')
})

const blockedText = computed(() => {
  const reason = props.rule.blockedReason
  return reason ? t(`eventActions.blocked.${reason}`) : ''
})
</script>

<template>
  <li class="card-list-item space-y-3" :class="{ 'opacity-60': !rule.enabled }">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-medium text-ink break-words">{{ rule.name }}</h3>
          <Badge :variant="rule.enabled ? 'success' : 'info'">
            {{ rule.enabled ? t('common.enabled') : t('common.disabled') }}
          </Badge>
          <Badge v-if="rule.blockedReason" variant="warning">{{ t('eventActions.blocked.badge') }}</Badge>
          <Badge v-if="managed" variant="info">{{ t('eventActions.managed.badge') }}</Badge>
        </div>
        <p class="text-sm text-ink-muted">
          {{ t('eventActions.rule.when') }}
          <code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-ink">{{ rule.eventPattern }}</code>
          <span class="mx-1.5" aria-hidden="true">›</span>
          {{ t(`eventActions.actionTypes.${rule.actionType}`) }}
        </p>
        <p
          v-if="rule.actionType !== 'backup'"
          class="text-sm text-ink break-words"
          :class="{ 'font-mono text-xs': rule.actionType === 'command' }"
        >
          {{ actionText }}
        </p>
        <p class="text-xs text-ink-subtle">
          {{ t('eventActions.rule.server') }}: {{ serverLabel }}
          <span class="mx-1" aria-hidden="true">·</span>
          {{ t('eventActions.rule.createdBy', { user: rule.createdBy || '-' }) }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button v-if="canApprove && rule.blockedReason" size="sm" variant="primary" :loading="busy" @click="emit('approve')">
          {{ t('eventActions.blocked.approve') }}
        </Button>
        <template v-if="editable">
          <Button v-if="canToggle" size="sm" variant="secondary" :disabled="busy" @click="emit('toggle')">
            {{ rule.enabled ? t('eventActions.rule.disable') : t('eventActions.rule.enable') }}
          </Button>
          <Button size="sm" variant="secondary" :disabled="busy" @click="emit('edit')">{{ t('common.edit') }}</Button>
          <Button size="sm" variant="danger" :disabled="busy" @click="emit('delete')">{{ t('common.delete') }}</Button>
        </template>
      </div>
    </div>

    <p v-if="rule.blockedReason" class="text-sm text-status-warning">
      {{ blockedText }}
      <template v-if="!canApprove">{{ t('eventActions.blocked.needsApprover') }}</template>
    </p>
    <p v-if="managed" class="text-sm text-ink-muted">{{ t('eventActions.managed.hint') }}</p>

    <WarningList :warnings="warnings" />
  </li>
</template>
