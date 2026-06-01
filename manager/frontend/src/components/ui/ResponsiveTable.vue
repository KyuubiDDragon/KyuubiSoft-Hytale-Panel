<script setup lang="ts" generic="T extends Record<string, any>">
/**
 * ResponsiveTable
 *
 * A generic table that renders a real <table> on >=sm viewports and stacked
 * "cards" on smaller screens. Each card uses a two-column label/value grid so
 * data stays scannable on narrow phones without horizontal scroll.
 *
 * Usage:
 *   <ResponsiveTable :columns="columns" :rows="rows" row-key="id">
 *     <template #cell:status="{ row }">
 *       <Badge ... />
 *     </template>
 *     <template #actions="{ row }">    <!-- desktop trailing actions -->
 *       <Button ... />
 *     </template>
 *     <template #mobile-actions="{ row }"> <!-- mobile card footer -->
 *       <Button ... />
 *     </template>
 *   </ResponsiveTable>
 */
export interface TableColumn {
  /** Property key on the row, or arbitrary identifier for slot-only cells */
  key: string
  /** Header label (also used as mobile label fallback) */
  label: string
  /** Optional override label for mobile cards */
  mobileLabel?: string
  /** Hide this column entirely on mobile cards */
  hideOnMobile?: boolean
  /** Hide this column on the desktop table (e.g. used only on mobile) */
  hideOnDesktop?: boolean
  /** Optional alignment for desktop cells */
  align?: 'left' | 'center' | 'right'
  /** Optional desktop width (CSS value, e.g. '12rem' or '20%') */
  width?: string
  /** Whether to suppress whitespace wrap on desktop cell */
  nowrap?: boolean
}

const props = withDefaults(defineProps<{
  columns: TableColumn[]
  rows: T[]
  /** Unique key per row, defaults to 'id' */
  rowKey?: keyof T | ((row: T) => string | number)
  /** Optional ARIA label for the table */
  ariaLabel?: string
  /** Optional label resolver for the mobile card aria-label */
  mobileCardLabel?: (row: T) => string
  /** Striped table */
  striped?: boolean
  /** Disable the hover row highlight */
  noHover?: boolean
}>(), {
  rowKey: 'id' as never,
  striped: false,
  noHover: false,
})

function getRowKey(row: T, index: number): string | number {
  const k = props.rowKey
  if (typeof k === 'function') return k(row)
  const v = row[k as keyof T]
  return (v as unknown as string | number) ?? index
}

function valueOf(row: T, col: TableColumn): unknown {
  return (row as Record<string, unknown>)[col.key]
}
</script>

<template>
  <div class="responsive-table">
    <!-- Desktop / tablet table -->
    <div class="hidden sm:block overflow-x-auto rounded-xl border border-border/60 bg-surface-raised">
      <table class="w-full text-sm" role="table" :aria-label="ariaLabel">
        <thead class="bg-surface-sunken text-ink-muted">
          <tr>
            <th
              v-for="col in columns.filter(c => !c.hideOnDesktop)"
              :key="col.key"
              scope="col"
              class="px-4 py-3 text-xs font-medium uppercase tracking-wider"
              :class="{
                'text-left': col.align !== 'center' && col.align !== 'right',
                'text-center': col.align === 'center',
                'text-right': col.align === 'right',
              }"
              :style="col.width ? { width: col.width } : undefined"
            >
              {{ col.label }}
            </th>
            <th v-if="$slots.actions" scope="col" class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider">
              <span class="sr-only">{{ $slots['actions-label'] ? '' : 'Actions' }}</span>
              <slot name="actions-label" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in rows"
            :key="getRowKey(row, index)"
            class="border-t border-border/40 transition-colors"
            :class="{
              'hover:bg-surface-muted/40': !noHover,
              'even:bg-surface-sunken/40': striped,
            }"
          >
            <td
              v-for="col in columns.filter(c => !c.hideOnDesktop)"
              :key="col.key"
              class="px-4 py-3 align-middle text-ink"
              :class="{
                'text-left': col.align !== 'center' && col.align !== 'right',
                'text-center': col.align === 'center',
                'text-right': col.align === 'right',
                'whitespace-nowrap': col.nowrap,
              }"
            >
              <slot :name="`cell:${col.key}`" :row="row" :value="valueOf(row, col)" :column="col">
                <span class="text-ink">{{ valueOf(row, col) ?? '—' }}</span>
              </slot>
            </td>
            <td v-if="$slots.actions" class="px-4 py-3 align-middle text-right whitespace-nowrap">
              <div class="inline-flex items-center justify-end gap-1">
                <slot name="actions" :row="row" :index="index" />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Mobile stacked cards (<sm) -->
    <ul class="sm:hidden space-y-3 list-none p-0 m-0">
      <li
        v-for="(row, index) in rows"
        :key="getRowKey(row, index)"
      >
        <article
          class="rounded-xl border border-border/60 bg-surface-raised p-4"
          :aria-label="mobileCardLabel ? mobileCardLabel(row) : ariaLabel"
        >
          <!-- Optional summary slot rendered at the top of the card -->
          <div v-if="$slots['mobile-header']" class="mb-3">
            <slot name="mobile-header" :row="row" :index="index" />
          </div>

          <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-sm">
            <template
              v-for="col in columns.filter(c => !c.hideOnMobile)"
              :key="col.key"
            >
              <dt class="text-xs font-medium uppercase tracking-wider text-ink-muted self-center">
                {{ col.mobileLabel ?? col.label }}
              </dt>
              <dd class="m-0 text-ink min-w-0 break-words">
                <slot :name="`cell:${col.key}`" :row="row" :value="valueOf(row, col)" :column="col">
                  <span>{{ valueOf(row, col) ?? '—' }}</span>
                </slot>
              </dd>
            </template>
          </dl>

          <!-- Actions footer (mobile-actions preferred, otherwise re-uses actions slot) -->
          <div
            v-if="$slots['mobile-actions'] || $slots.actions"
            class="mt-4 pt-3 border-t border-border/40 flex flex-wrap items-center gap-2"
          >
            <slot v-if="$slots['mobile-actions']" name="mobile-actions" :row="row" :index="index" />
            <slot v-else name="actions" :row="row" :index="index" />
          </div>
        </article>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Ensure interactive elements rendered inside actions / cells respect a 44px
   touch target on mobile, in line with WCAG 2.5.5. */
@media (max-width: 639.98px) {
  .responsive-table :deep(button),
  .responsive-table :deep(a.btn),
  .responsive-table :deep([role='button']) {
    min-height: 44px;
  }
  .responsive-table :deep(.btn-sm) {
    min-height: 40px;
  }
}
</style>
