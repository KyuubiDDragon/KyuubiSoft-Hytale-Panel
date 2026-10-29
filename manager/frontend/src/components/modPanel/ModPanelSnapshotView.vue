<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Stat from '@/components/ui/Stat.vue'
import type { ModPanelSnapshot, ModPanelTone, ModPanelValue } from '@/api/modPanel'

/**
 * Generic rendering of a mod's snapshot: notices, then per section metric
 * tiles and tables. Every value is mod-provided text and is only ever
 * interpolated ({{ }}), never rendered as HTML.
 */
defineProps<{ snapshot: ModPanelSnapshot }>()

const { t, locale } = useI18n()

const STAT_STATUS: Record<ModPanelTone, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  neutral: 'default',
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
}

const NOTICE_CLASS: Record<ModPanelTone, string> = {
  neutral: 'border-border bg-surface-muted/40 text-ink',
  info: 'border-status-info/40 bg-status-info/10 text-status-info',
  success: 'border-status-success/40 bg-status-success/10 text-status-success',
  warning: 'border-status-warning/40 bg-status-warning/10 text-status-warning',
  error: 'border-status-error/40 bg-status-error/10 text-status-error',
}

function numberLocale(): string {
  return locale.value === 'pt_br' ? 'pt-BR' : locale.value
}

function format(value: ModPanelValue): string {
  if (value === null) return '–'
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no')
  if (typeof value === 'number') return value.toLocaleString(numberLocale())
  return value
}

function metricText(value: ModPanelValue, unit?: string | null): string {
  return unit ? `${format(value)} ${unit}` : format(value)
}
</script>

<template>
  <div class="space-y-6">
    <div v-if="snapshot.notices.length" class="space-y-2">
      <div
        v-for="(notice, i) in snapshot.notices"
        :key="i"
        class="rounded-lg border px-4 py-3 text-sm"
        :class="NOTICE_CLASS[notice.tone]"
        role="status"
      >
        {{ notice.text }}
      </div>
    </div>

    <section v-for="(section, si) in snapshot.sections" :key="si" class="space-y-3">
      <div>
        <h3 class="text-base font-semibold text-ink">{{ section.title }}</h3>
        <p v-if="section.description" class="text-sm text-ink-muted mt-0.5">{{ section.description }}</p>
      </div>

      <div v-if="section.metrics.length" class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        <div v-for="(metric, mi) in section.metrics" :key="mi">
          <Stat
            :label="metric.label"
            :value="metricText(metric.value, metric.unit)"
            :status="STAT_STATUS[metric.tone]"
          />
          <p v-if="metric.hint" class="text-xs text-ink-subtle mt-1 px-1">{{ metric.hint }}</p>
        </div>
      </div>

      <div v-for="(table, ti) in section.tables" :key="ti" class="card overflow-hidden">
        <div v-if="table.title" class="card-header">
          <h4 class="text-sm font-semibold text-ink">{{ table.title }}</h4>
        </div>
        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th v-for="(column, ci) in table.columns" :key="ci">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="table.rows.length === 0">
                <td :colspan="table.columns.length" class="text-center text-ink-subtle py-6">
                  {{ table.emptyText || t('modPanel.noRows') }}
                </td>
              </tr>
              <tr v-for="(row, ri) in table.rows" :key="ri">
                <td v-for="(cell, ci) in row" :key="ci" :class="{ 'tabular-nums': typeof cell === 'number' }">
                  {{ format(cell) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-if="table.truncated || (table.totalRows ?? 0) > table.rows.length"
          class="px-4 py-2 text-xs text-ink-subtle border-t border-border/60"
        >
          {{ t('modPanel.rowsTruncated', { shown: table.rows.length, total: table.totalRows ?? table.rows.length }) }}
        </p>
      </div>
    </section>

    <p v-if="snapshot.truncated" class="text-xs text-ink-subtle">{{ t('modPanel.snapshotTruncated') }}</p>
  </div>
</template>
