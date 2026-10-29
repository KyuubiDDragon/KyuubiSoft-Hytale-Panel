<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import type { RuleTemplate } from './eventActionForm'

defineProps<{
  templates: RuleTemplate[]
}>()

const emit = defineEmits<{
  pick: [template: RuleTemplate]
}>()

const { t } = useI18n()
</script>

<template>
  <Card :title="t('eventActions.templates.title')">
    <p class="mb-4 text-sm text-ink-muted">{{ t('eventActions.templates.hint') }}</p>
    <ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <li v-for="template in templates" :key="template.id">
        <button
          type="button"
          class="h-full w-full rounded-lg border border-border bg-surface-sunken p-4 text-left transition-colors hover:border-hytale-orange focus-visible:border-hytale-orange"
          @click="emit('pick', template)"
        >
          <span class="block font-medium text-ink">{{ t(`eventActions.templates.${template.id}.name`) }}</span>
          <span class="mt-1 block text-sm text-ink-muted">{{ t(`eventActions.templates.${template.id}.description`) }}</span>
          <code class="mt-2 inline-block rounded bg-surface-muted px-1.5 py-0.5 text-xs text-ink-muted">{{ template.eventPattern }}</code>
        </button>
      </li>
    </ul>
  </Card>
</template>
