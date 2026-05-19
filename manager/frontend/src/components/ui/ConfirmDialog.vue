<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from './Button.vue'

const props = defineProps<{
  show: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: 'danger' | 'primary'
  loading?: boolean
}>()

defineEmits<{
  confirm: []
  cancel: []
}>()

const { t } = useI18n()

const resolvedConfirmText = computed(() => props.confirmText || t('common.confirm'))
const resolvedCancelText = computed(() => props.cancelText || t('common.cancel'))
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition ease-out duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition ease-in duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="show" class="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="$emit('cancel')" />

        <!-- Dialog -->
        <Transition
          enter-active-class="transition ease-out duration-200"
          enter-from-class="transform scale-95 opacity-0"
          enter-to-class="transform scale-100 opacity-100"
          leave-active-class="transition ease-in duration-150"
          leave-from-class="transform scale-100 opacity-100"
          leave-to-class="transform scale-95 opacity-0"
        >
          <div v-if="show" role="dialog" aria-modal="true" class="relative bg-surface-overlay border border-border rounded-xl shadow-2xl w-full max-w-md p-6">
            <!-- Icon -->
            <div class="flex items-center gap-3 mb-4">
              <div
                :class="[
                  'w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0',
                  variant === 'danger' ? 'bg-status-error/20' : 'bg-hytale-orange/20'
                ]"
              >
                <svg
                  :class="['w-5 h-5', variant === 'danger' ? 'text-status-error' : 'text-hytale-orange']"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  aria-hidden="true"
                >
                  <path v-if="variant === 'danger'" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 class="text-lg font-semibold text-ink">{{ title }}</h3>
            </div>

            <!-- Message -->
            <p class="text-ink-muted text-sm mb-6 ml-[52px]">{{ message }}</p>

            <!-- Actions -->
            <div class="flex justify-end gap-3">
              <Button variant="secondary" size="sm" @click="$emit('cancel')" :disabled="loading">
                {{ resolvedCancelText }}
              </Button>
              <Button :variant="variant === 'danger' ? 'danger' : 'primary'" size="sm" @click="$emit('confirm')" :loading="loading">
                {{ resolvedConfirmText }}
              </Button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
