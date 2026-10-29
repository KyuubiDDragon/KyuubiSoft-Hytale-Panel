<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CommandReply } from '@/stores/console'

const props = defineProps<{ reply: CommandReply }>()
const { t } = useI18n()

const failed = computed(() => !props.reply.pending && props.reply.success === false)

// The plugin's error text is usually the first output line already.
const showError = computed(
  () => failed.value && !!props.reply.error && !props.reply.lines.includes(props.reply.error),
)

const note = computed(() => {
  const { reply } = props
  if (reply.pending || failed.value) return null
  if (reply.via === 'stdin') return t('console.reply.sentOnly')
  if (reply.status === 'RUNNING') return t('console.reply.running')
  if (reply.lines.length === 0) return t('console.reply.noOutput')
  return null
})
</script>

<template>
  <div
    class="ml-4 mt-1 mb-1 pl-3 border-l-2 text-sm"
    :class="failed ? 'border-status-error/60' : 'border-hytale-orange/40'"
  >
    <div v-if="reply.pending" class="text-ink-subtle italic">{{ t('console.reply.pending') }}</div>
    <template v-else>
      <div
        v-for="(line, index) in reply.lines"
        :key="index"
        class="whitespace-pre-wrap break-words"
        :class="failed ? 'text-status-error' : 'text-ink'"
      >{{ line }}</div>
      <div v-if="showError" class="text-status-error font-medium">{{ reply.error }}</div>
      <div v-if="reply.errorKey" class="text-status-error">{{ t(reply.errorKey) }}</div>
      <div v-if="note" class="text-ink-subtle text-xs italic">{{ note }}</div>
    </template>
  </div>
</template>
