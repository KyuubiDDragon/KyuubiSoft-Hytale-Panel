<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { EventActionWarning } from '@/api/eventActions'

defineProps<{
  warnings: EventActionWarning[]
}>()

const { t } = useI18n()

/** Text for a warning; the backend's English text is only the fallback for codes this panel does not know. */
function warningText(warning: EventActionWarning): string {
  if (warning.code === 'free_text_placeholder') {
    const names = (warning.placeholders ?? []).map((key) => `{${key}}`).join(', ')
    return t('eventActions.warnings.freeText', { placeholders: names })
  }
  if (warning.code === 'log_events_run_no_commands') {
    return t('eventActions.warnings.noPluginLog', { events: (warning.events ?? []).join(', ') })
  }
  return warning.message
}
</script>

<template>
  <ul v-if="warnings.length > 0" class="space-y-1.5" :aria-label="t('eventActions.warnings.heading')">
    <li
      v-for="warning in warnings"
      :key="warning.code"
      class="flex items-start gap-2 rounded-lg bg-status-warning/10 border border-status-warning/30 px-3 py-2 text-sm text-status-warning"
    >
      <svg class="mt-0.5 h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v4m0 4h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
      </svg>
      <span>{{ warningText(warning) }}</span>
    </li>
  </ul>
</template>
