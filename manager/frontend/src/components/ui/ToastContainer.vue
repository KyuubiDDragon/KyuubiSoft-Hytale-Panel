<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts, removeToast } = useToast()

function iconPath(type: string) {
  switch (type) {
    case 'success': return 'M5 13l4 4L19 7'
    case 'error': return 'M6 18L18 6M6 6l12 12'
    case 'warning': return 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z'
    default: return 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
  }
}

function colorClass(type: string) {
  switch (type) {
    case 'success': return 'border-status-success/50 bg-status-success/10'
    case 'error': return 'border-status-error/50 bg-status-error/10'
    case 'warning': return 'border-status-warning/50 bg-status-warning/10'
    default: return 'border-status-info/50 bg-status-info/10'
  }
}

function iconColorClass(type: string) {
  switch (type) {
    case 'success': return 'text-status-success'
    case 'error': return 'text-status-error'
    case 'warning': return 'text-status-warning'
    default: return 'text-status-info'
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      <TransitionGroup
        enter-active-class="transition ease-out duration-200"
        enter-from-class="transform translate-x-full opacity-0"
        enter-to-class="transform translate-x-0 opacity-100"
        leave-active-class="transition ease-in duration-150"
        leave-from-class="transform translate-x-0 opacity-100"
        leave-to-class="transform translate-x-full opacity-0"
      >
        <div
          v-for="toast in toasts"
          :key="toast.id"
          :class="['flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm', colorClass(toast.type)]"
        >
          <svg :class="['w-5 h-5 flex-shrink-0 mt-0.5', iconColorClass(toast.type)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="iconPath(toast.type)" />
          </svg>
          <p class="text-sm text-white flex-1">{{ toast.message }}</p>
          <button
            @click="removeToast(toast.id)"
            class="text-ink-muted hover:text-ink flex-shrink-0"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
