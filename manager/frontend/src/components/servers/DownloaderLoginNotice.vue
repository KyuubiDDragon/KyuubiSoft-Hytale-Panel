<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import { apiErrorMessage } from '@/utils/apiErrors'
import { loginExpiry, type PendingLogin } from '@/utils/deviceLogin'
import Button from '@/components/ui/Button.vue'
import DeviceLoginCode from './DeviceLoginCode.vue'

/**
 * Downloader login of one server whose game files are still missing. Shows
 * the login its container is waiting for, or lets the user request one.
 * Addresses the server by id, so it works for any listed server.
 */
const props = defineProps<{ serverId: string; canRestart: boolean }>()

const { t, te } = useI18n()

interface AuthStatus {
  authenticated: boolean
  authRequired: boolean
  pendingLogin?: PendingLogin | null
}

const POLL_MS = 5000

const status = ref<AuthStatus | null>(null)
const requested = ref<{ verificationUrl: string; userCode?: string | null; expiresAt: number } | null>(null)
const firstSeen = ref<number | null>(null)
const busy = ref(false)
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const base = computed(() => `/servers/${encodeURIComponent(props.serverId)}/server/downloader`)

async function load() {
  try {
    const { data } = await api.get<AuthStatus>(`${base.value}/auth-status`)
    status.value = data
    if (data.pendingLogin && firstSeen.value === null) firstSeen.value = Date.now()
    if (!data.pendingLogin) firstSeen.value = null
    if (data.authenticated) requested.value = null
  } catch {
    // No right to read it, or the container is not running: nothing to show.
    status.value = null
  }
}

const shown = computed(() => {
  const pending = status.value?.pendingLogin
  if (pending) {
    return {
      verificationUrl: pending.verificationUrl,
      userCode: pending.userCode,
      expiresAt: loginExpiry(pending, firstSeen.value ?? Date.now()),
    }
  }
  return requested.value
})

async function requestLogin() {
  busy.value = true
  error.value = ''
  try {
    const { data } = await api.post<{
      success: boolean
      alreadyAuthenticated?: boolean
      verificationUrl?: string
      userCode?: string | null
      expiresIn?: number
    }>(`${base.value}/initiate-auth`)
    if (data.verificationUrl) {
      requested.value = {
        verificationUrl: data.verificationUrl,
        userCode: data.userCode,
        expiresAt: Date.now() + (data.expiresIn ?? 900) * 1000,
      }
    }
    await load()
  } catch (err) {
    error.value = apiErrorMessage(err, t, te, t('servers.adm.login.requestFailed'))
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void load()
  timer = setInterval(load, POLL_MS)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div v-if="status" class="mt-2 space-y-2">
    <DeviceLoginCode
      v-if="shown"
      :verification-url="shown.verificationUrl"
      :user-code="shown.userCode"
      :expires-at="shown.expiresAt"
    />
    <p v-else-if="status.authenticated" class="text-xs text-status-success">
      {{ t('servers.adm.login.downloading') }}
    </p>
    <div v-else-if="status.authRequired && canRestart" class="flex items-center gap-2">
      <Button variant="secondary" size="sm" :loading="busy" @click="requestLogin">
        {{ t('servers.adm.login.request') }}
      </Button>
      <span class="text-xs text-ink-subtle">{{ t('servers.adm.login.requestHint') }}</span>
    </div>
    <p v-if="error" class="text-xs text-status-error" role="alert">{{ error }}</p>
  </div>
</template>
