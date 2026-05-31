<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

const props = defineProps<{
  open: boolean
  title?: string
}>()

const emit = defineEmits<{
  close: []
}>()

// Stable, unique id per modal instance so aria-labelledby links the heading.
let uidCounter = 0
const titleId = `modal-title-${++uidCounter}`

const dialogRef = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null

function focusable(): HTMLElement[] {
  if (!dialogRef.value) return []
  return Array.from(
    dialogRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
    ),
  )
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  // Trap Tab focus inside the dialog.
  if (e.key !== 'Tab') return
  const items = focusable()
  if (items.length === 0) {
    e.preventDefault()
    dialogRef.value?.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

// IMPORTANT: register/clean up via the watcher's onCleanup argument. The old
// code returned a cleanup function from the callback, which Vue does NOT treat
// as cleanup — so each open leaked another keydown listener.
watch(
  () => props.open,
  async (isOpen, _prev, onCleanup) => {
    if (!isOpen) return
    previouslyFocused = (document.activeElement as HTMLElement) ?? null
    document.addEventListener('keydown', onKeydown)
    await nextTick()
    const items = focusable()
    ;(items[0] ?? dialogRef.value)?.focus()
    onCleanup(() => {
      document.removeEventListener('keydown', onKeydown)
      // Restore focus to whatever had it before the modal opened.
      previouslyFocused?.focus?.()
    })
  },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-black/70 backdrop-blur-sm"
          @click="emit('close')"
        />

        <!-- Modal -->
        <div
          ref="dialogRef"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          tabindex="-1"
          class="relative bg-surface-raised rounded-xl border border-border shadow-2xl w-full max-w-md outline-none"
        >
          <!-- Header -->
          <div v-if="title" class="flex items-center justify-between px-6 py-4 border-b border-border">
            <h3 :id="titleId" class="text-lg font-semibold text-ink">{{ title }}</h3>
            <button
              @click="emit('close')"
              aria-label="Close"
              class="text-ink-muted hover:text-ink transition-colors"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Content -->
          <div class="p-6">
            <slot />
          </div>

          <!-- Footer -->
          <div v-if="$slots.footer" class="px-6 py-4 border-t border-border flex justify-end gap-3">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .relative,
.modal-leave-active .relative {
  transition: transform 0.2s ease;
}

.modal-enter-from .relative,
.modal-leave-to .relative {
  transform: scale(0.95);
}
</style>
