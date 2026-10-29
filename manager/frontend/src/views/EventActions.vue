<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useServersStore } from '@/stores/servers'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import { getApiErrorMessage } from '@/utils/apiErrors'
import {
  eventActionsApi,
  inputFromRule,
  type EventAction,
  type EventActionInput,
  type EventActionWarning,
} from '@/api/eventActions'
import PageHeader from '@/components/ui/PageHeader.vue'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import ErrorState from '@/components/ui/ErrorState.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import RuleCard from '@/components/eventActions/RuleCard.vue'
import RuleEditor from '@/components/eventActions/RuleEditor.vue'
import TemplatePicker from '@/components/eventActions/TemplatePicker.vue'
import {
  availableTemplates,
  emptyInput,
  inputFromTemplate,
  localWarnings,
  mergeWarnings,
  type RuleTemplate,
} from '@/components/eventActions/eventActionForm'

const { t } = useI18n()
const authStore = useAuthStore()
const serversStore = useServersStore()
const toast = useToast()
const { ask } = useConfirm()

const loading = ref(true)
const loadError = ref<string | null>(null)
const rules = ref<EventAction[]>([])
const events = ref<string[]>([])

// The editor: closed (null) or open with its starting values.
interface EditorState {
  /** The rule being edited; null for a new one */
  rule: EventAction | null
  initial: EventActionInput
}
const editor = ref<EditorState | null>(null)
const saving = ref(false)
/** Rule ids with a request in flight. */
const busyIds = ref<string[]>([])
/** Warnings the server returned when it saved a rule (kept until the next reload). */
const savedWarnings = reactive<Record<string, EventActionWarning[]>>({})

const canEdit = computed(() => authStore.hasPermission('scheduler.edit'))
const canUseCommand = computed(
  () => authStore.hasPermission('console.execute') || authStore.hasPermission('console.execute.admin'),
)
const canApprove = computed(() => canEdit.value && canUseCommand.value)

// An account limited to some servers (no server list, only its allowed ids) cannot
// create rules for every server: offer just its servers and start on the first.
const restrictedToServers = computed(() => !serversStore.canList && serversStore.allowedIds !== null)
const serverOptions = computed(() =>
  restrictedToServers.value
    ? (serversStore.allowedIds ?? []).map((id) => ({ id, name: id }))
    : serversStore.servers.map((s) => ({ id: s.id, name: s.name })),
)
const defaultServerId = computed(() => (restrictedToServers.value ? (serverOptions.value[0]?.id ?? '') : ''))
const templates = computed(() => availableTemplates(events.value))

function serverLabel(rule: EventAction): string {
  if (!rule.serverId) return t('eventActions.editor.allServers')
  return serversStore.servers.find((s) => s.id === rule.serverId)?.name ?? rule.serverId
}

function warningsFor(rule: EventAction): EventActionWarning[] {
  return mergeWarnings(
    localWarnings({ actionType: rule.actionType, command: rule.actionPayload.command ?? '' }),
    savedWarnings[rule.id] ?? [],
  )
}

function isBusy(id: string): boolean {
  return busyIds.value.includes(id)
}

async function runBusy(id: string, task: () => Promise<void>) {
  busyIds.value = [...busyIds.value, id]
  try {
    await task()
  } finally {
    busyIds.value = busyIds.value.filter((x) => x !== id)
  }
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const overview = await eventActionsApi.list()
    rules.value = overview.rules
    events.value = overview.events
  } catch (err) {
    loadError.value = getApiErrorMessage(err, t('eventActions.loadError'))
  } finally {
    loading.value = false
  }
}

/** Replace one rule in the list with the version the server returned. */
function replaceRule(updated: EventAction) {
  rules.value = rules.value.map((r) => (r.id === updated.id ? updated : r))
}

function openNew() {
  editor.value = { rule: null, initial: { ...emptyInput(), serverId: defaultServerId.value } }
}

function openTemplate(template: RuleTemplate) {
  editor.value = { rule: null, initial: inputFromTemplate(template, (key) => t(key), defaultServerId.value) }
}

function openEdit(rule: EventAction) {
  editor.value = { rule, initial: inputFromRule(rule) }
}

function closeEditor() {
  editor.value = null
}

async function save(input: EventActionInput) {
  const current = editor.value
  if (!current) return
  saving.value = true
  try {
    const saved = current.rule
      ? await eventActionsApi.update(current.rule.id, input)
      : await eventActionsApi.create(input)
    savedWarnings[saved.rule.id] = saved.warnings
    // Remember the new id, so saving again edits the rule instead of creating a second one.
    editor.value = { ...current, rule: saved.rule }
    if (current.rule) {
      replaceRule(saved.rule)
    } else {
      rules.value = [saved.rule, ...rules.value]
    }
    toast.success(t(current.rule ? 'eventActions.toasts.updated' : 'eventActions.toasts.created'))
    // The list carries the derived "needs approval" state; refresh it.
    await load()
    editor.value = null
  } catch (err) {
    toast.error(getApiErrorMessage(err, t('eventActions.toasts.saveFailed')))
  } finally {
    saving.value = false
  }
}

async function toggle(rule: EventAction) {
  await runBusy(rule.id, async () => {
    try {
      const saved = await eventActionsApi.setEnabled(rule.id, !rule.enabled)
      savedWarnings[rule.id] = saved.warnings
      toast.success(t(saved.rule.enabled ? 'eventActions.toasts.enabled' : 'eventActions.toasts.disabled'))
      await load()
    } catch (err) {
      toast.error(getApiErrorMessage(err, t('eventActions.toasts.saveFailed')))
    }
  })
}

async function remove(rule: EventAction) {
  const confirmed = await ask({
    title: t('eventActions.confirmDelete.title'),
    message: t('eventActions.confirmDelete.message', { name: rule.name }),
    variant: 'danger',
    confirmText: t('common.delete'),
  })
  if (!confirmed) return
  await runBusy(rule.id, async () => {
    try {
      await eventActionsApi.remove(rule.id)
      delete savedWarnings[rule.id]
      rules.value = rules.value.filter((r) => r.id !== rule.id)
      if (editor.value?.rule?.id === rule.id) editor.value = null
      toast.success(t('eventActions.toasts.deleted'))
    } catch (err) {
      toast.error(getApiErrorMessage(err, t('eventActions.toasts.deleteFailed')))
    }
  })
}

async function approve(rule: EventAction) {
  await runBusy(rule.id, async () => {
    try {
      replaceRule({ ...(await eventActionsApi.approve(rule.id)), blockedReason: null })
      toast.success(t('eventActions.toasts.approved'))
    } catch (err) {
      toast.error(getApiErrorMessage(err, t('eventActions.toasts.approveFailed')))
    }
  })
}

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('eventActions.title')" :subtitle="t('eventActions.subtitle')">
      <template #actions>
        <Button v-if="canEdit && !editor" @click="openNew">{{ t('eventActions.newRule') }}</Button>
      </template>
    </PageHeader>

    <p v-if="!canEdit" class="rounded-lg border border-border bg-surface-raised px-4 py-3 text-sm text-ink-muted">
      {{ t('eventActions.viewOnly') }}
    </p>

    <RuleEditor
      v-if="editor"
      :key="editor.rule?.id ?? 'new'"
      :initial="editor.initial"
      :editing="!!editor.rule"
      :events="events"
      :servers="serverOptions"
      :allow-all-servers="!restrictedToServers"
      :can-use-command="canUseCommand"
      :saving="saving"
      @save="save"
      @cancel="closeEditor"
    />

    <div v-if="loading && rules.length === 0" class="space-y-3" role="status" :aria-label="t('common.loading')">
      <Skeleton v-for="n in 3" :key="n" class="h-20 w-full" />
    </div>

    <ErrorState v-else-if="loadError" :message="loadError" @retry="load" />

    <template v-else>
      <Card :title="t('eventActions.listTitle')" padding="none">
        <EmptyState
          v-if="rules.length === 0"
          :title="t('eventActions.empty.title')"
          :description="canEdit ? t('eventActions.empty.hint') : t('eventActions.empty.hintViewOnly')"
        />
        <ul v-else>
          <RuleCard
            v-for="rule in rules"
            :key="rule.id"
            :rule="rule"
            :server-label="serverLabel(rule)"
            :warnings="warningsFor(rule)"
            :can-edit="canEdit"
            :can-approve="canApprove"
            :can-use-command="canUseCommand"
            :busy="isBusy(rule.id)"
            @toggle="toggle(rule)"
            @edit="openEdit(rule)"
            @delete="remove(rule)"
            @approve="approve(rule)"
          />
        </ul>
        <template #footer>
          <p class="text-xs text-ink-subtle">{{ t('eventActions.rateNote') }}</p>
        </template>
      </Card>

      <TemplatePicker v-if="canEdit && !editor && templates.length > 0" :templates="templates" @pick="openTemplate" />
    </template>
  </div>
</template>
