<script setup lang="ts">
withDefaults(defineProps<{
  label: string
  value: string | number
  /** Optional trend indicator (positive number = up, negative = down) */
  trend?: number | null
  /** Status accent for value coloring */
  status?: 'default' | 'success' | 'warning' | 'error' | 'info'
  /** Loading state — renders skeleton */
  loading?: boolean
}>(), {
  trend: null,
  status: 'default',
  loading: false,
})
</script>

<template>
  <div class="card card-hover">
    <div class="card-body p-4">
      <div class="flex items-center gap-3">
        <div
          v-if="$slots.icon"
          class="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-hytale-orange/10 text-hytale-orange"
        >
          <slot name="icon" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-xs uppercase tracking-wider text-ink-subtle mb-1">{{ label }}</p>
          <div v-if="loading" class="skeleton h-6 w-24 rounded" />
          <p
            v-else
            class="text-xl font-semibold truncate"
            :class="{
              'text-ink': status === 'default',
              'text-status-success': status === 'success',
              'text-status-warning': status === 'warning',
              'text-status-error': status === 'error',
              'text-status-info': status === 'info',
            }"
          >
            {{ value }}
          </p>
          <p
            v-if="trend !== null && !loading"
            class="text-xs mt-1 flex items-center gap-1"
            :class="trend >= 0 ? 'text-status-success' : 'text-status-error'"
          >
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path v-if="trend >= 0" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
              <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
            {{ Math.abs(trend).toFixed(1) }}%
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
