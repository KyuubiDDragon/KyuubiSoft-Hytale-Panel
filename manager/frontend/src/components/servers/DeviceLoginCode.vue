<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * A Hytale device login that is waiting for the user: the link to open, the
 * code to enter and how long it stays valid.
 */
const props = defineProps<{
  verificationUrl: string
  userCode?: string | null
  /** Epoch milliseconds; omitted when the expiry is unknown. */
  expiresAt?: number | null
}>()

const { t } = useI18n()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const remaining = computed(() => {
  if (!props.expiresAt) return null
  const seconds = Math.max(0, Math.round((props.expiresAt - now.value) / 1000))
  const minutes = Math.floor(seconds / 60)
  return { seconds, text: `${minutes}:${String(seconds % 60).padStart(2, '0')}` }
})

// Only http(s) links are offered; the URL comes from the container's log.
const safeUrl = computed(() => (/^https?:\/\//i.test(props.verificationUrl) ? props.verificationUrl : ''))
</script>

<template>
  <div class="p-3 bg-surface-muted rounded-lg border border-border space-y-1" role="status">
    <p v-if="userCode" class="text-xs text-ink-muted">{{ t('servers.adm.login.enterCode') }}</p>
    <p v-if="userCode" class="text-xl font-mono text-ink tracking-wider select-all">{{ userCode }}</p>
    <a
      v-if="safeUrl"
      :href="safeUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="text-sm text-hytale-orange hover:underline inline-block"
    >
      {{ t('servers.adm.login.openPage') }} →
    </a>
    <p v-if="remaining" class="text-xs" :class="remaining.seconds === 0 ? 'text-status-error' : 'text-ink-subtle'">
      {{ remaining.seconds === 0 ? t('servers.adm.login.expired') : t('servers.adm.login.expiresIn', { time: remaining.text }) }}
    </p>
  </div>
</template>
