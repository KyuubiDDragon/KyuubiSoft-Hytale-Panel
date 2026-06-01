<script setup lang="ts">
/**
 * Global mount point for useConfirm(). Sits once in App.vue and surfaces
 * any dialog requested through the `ask()` Promise API. Routing the
 * confirm/cancel events back into the composable resolves the promise
 * the caller is awaiting.
 */
import { useConfirm } from '@/composables/useConfirm'
import ConfirmDialog from './ConfirmDialog.vue'

const { confirm, cancel, pending } = useConfirm()
</script>

<template>
  <ConfirmDialog
    :show="!!pending"
    :title="pending?.title ?? ''"
    :message="pending?.message ?? ''"
    :variant="pending?.variant ?? 'primary'"
    :confirm-text="pending?.confirmText"
    :cancel-text="pending?.cancelText"
    @confirm="confirm"
    @cancel="cancel"
  />
</template>
