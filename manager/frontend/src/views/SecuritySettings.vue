<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import { useServersStore } from '@/stores/servers'
import { useToast } from '@/composables/useToast'
import { getApiErrorMessage } from '@/utils/apiErrors'
import { formatDate } from '@/utils/formatDate'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Modal from '@/components/ui/Modal.vue'
import Button from '@/components/ui/Button.vue'
import ServerAccessEditor from '@/components/access/ServerAccessEditor.vue'

const { t } = useI18n()
const serversStore = useServersStore()
const toast = useToast()

// ---------- 2FA ----------
const twoFAEnabled = ref(false)
const setupQr = ref<string | null>(null)
const setupSecret = ref<string | null>(null)
const code = ref('')
const backupCodes = ref<string[] | null>(null)
const disablePassword = ref('')
const disableCode = ref('')

async function load2fa() {
  const { data } = await api.get<{ enabled: boolean }>('/auth/2fa/status')
  twoFAEnabled.value = data.enabled
}

async function startSetup() {
  try {
    const { data } = await api.post<{ secret: string; otpauthUrl: string; qrDataUrl: string }>('/auth/2fa/setup')
    setupQr.value = data.qrDataUrl
    setupSecret.value = data.secret
  } catch (err) {
    toast.error(getApiErrorMessage(err, t('security.twoFactor.setupFailed')))
  }
}

async function confirmSetup() {
  try {
    const { data } = await api.post<{ backupCodes: string[] }>('/auth/2fa/verify-enable', { code: code.value })
    backupCodes.value = data.backupCodes
    setupQr.value = null
    setupSecret.value = null
    code.value = ''
    await load2fa()
  } catch (err) {
    toast.error(getApiErrorMessage(err, t('security.twoFactor.confirmFailed')))
  }
}

async function disable2fa() {
  try {
    await api.post('/auth/2fa/disable', { password: disablePassword.value, code: disableCode.value })
    disablePassword.value = ''
    disableCode.value = ''
    backupCodes.value = null
    await load2fa()
  } catch (err) {
    toast.error(getApiErrorMessage(err, t('security.twoFactor.disableFailed')))
  }
}

// ---------- API Keys ----------
interface ApiKey {
  id: string
  name: string
  scopes: string[]
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  /** Servers the key may use; null = the same as its owner. */
  serverIds?: string[] | null
}
const apiKeys = ref<ApiKey[]>([])
const newKey = ref<{ name: string; scopes: string }>({ name: '', scopes: '' })
const justCreatedToken = ref<string | null>(null)
// null = the key follows its owner's servers
const newKeyServers = ref<string[] | null>(null)
const keyError = ref('')
const serversTarget = ref<ApiKey | null>(null)
const serversDraft = ref<string[] | null>(null)
const savingServers = ref(false)

async function loadKeys() {
  const { data } = await api.get<{ keys: ApiKey[] }>('/auth/api-keys')
  apiKeys.value = data.keys
}

async function createKey() {
  const scopes = newKey.value.scopes.split(',').map(s => s.trim()).filter(Boolean)
  if (!newKey.value.name || scopes.length === 0) return
  keyError.value = ''
  try {
    // The server list is part of the same request: the key never exists
    // wider than chosen, and a refused list creates no key at all.
    const { data } = await api.post<{ key: ApiKey; token: string }>('/auth/api-keys', {
      name: newKey.value.name,
      scopes,
      ...(newKeyServers.value !== null ? { serverIds: newKeyServers.value } : {}),
    })
    justCreatedToken.value = data.token
    newKey.value = { name: '', scopes: '' }
    newKeyServers.value = null
  } catch (err) {
    keyError.value = getApiErrorMessage(err, t('errors.serverError'))
  }
  await loadKeys()
}

function serversLabel(k: ApiKey): string {
  if (!k.serverIds) return t('serverAccess.keyFollowsOwner')
  if (k.serverIds.length === 0) return t('serverAccess.noneShort')
  return t('serverAccess.count', { count: k.serverIds.length })
}

function serverTitle(k: ApiKey): string {
  return (k.serverIds ?? [])
    .map((id) => serversStore.servers.find((s) => s.id === id)?.name ?? id)
    .join(', ')
}

/** "3 scopes · created … · last used …" */
function keyMeta(k: ApiKey): string {
  return t('security.apiKeys.meta', {
    scopes: t('security.apiKeys.scopeCount', { count: k.scopes.length }, k.scopes.length),
    created: formatDate(k.createdAt),
    lastUsed: k.lastUsedAt ? formatDate(k.lastUsedAt) : t('security.apiKeys.never'),
  })
}

function editServers(k: ApiKey) {
  serversTarget.value = k
  serversDraft.value = k.serverIds ? [...k.serverIds] : null
  keyError.value = ''
}

async function saveServers() {
  const target = serversTarget.value
  if (!target) return
  savingServers.value = true
  try {
    await api.put(`/auth/api-keys/${target.id}/servers`, { serverIds: serversDraft.value })
    serversTarget.value = null
    await loadKeys()
  } catch (err) {
    keyError.value = getApiErrorMessage(err, t('errors.serverError'))
  } finally {
    savingServers.value = false
  }
}

// Revoke flow via ConfirmDialog instead of window.confirm so it matches
// the rest of the panel's modal style and is keyboard/focus-trap correct.
const revokeDialogOpen = ref(false)
const revokeTargetId = ref<string | null>(null)
const revokeTargetName = ref('')

function askRevoke(key: ApiKey) {
  revokeTargetId.value = key.id
  revokeTargetName.value = key.name
  revokeDialogOpen.value = true
}

async function confirmRevoke() {
  if (!revokeTargetId.value) return
  try {
    await api.delete(`/auth/api-keys/${revokeTargetId.value}`)
  } catch (err) {
    toast.error(getApiErrorMessage(err, t('security.apiKeys.revokeFailed')))
  }
  revokeDialogOpen.value = false
  revokeTargetId.value = null
  await loadKeys()
}

onMounted(async () => {
  void serversStore.init()
  await load2fa()
  await loadKeys()
})
</script>

<template>
  <div class="space-y-6 max-w-3xl">
    <h1 class="text-2xl font-bold text-ink">{{ t('security.title') }}</h1>

    <!-- 2FA -->
    <section class="bg-surface-raised border border-border/40 rounded-xl p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-lg font-semibold text-ink">{{ t('security.twoFactor.title') }}</h2>
          <p class="text-sm text-ink-muted">{{ twoFAEnabled ? t('security.twoFactor.activeDesc') : t('security.twoFactor.disabledDesc') }}</p>
        </div>
        <span class="text-xs px-2 py-1 rounded-full" :class="twoFAEnabled ? 'bg-status-success/20 text-status-success' : 'bg-surface-overlay text-ink-muted'">
          {{ twoFAEnabled ? t('security.twoFactor.badgeEnabled') : t('security.twoFactor.badgeDisabled') }}
        </span>
      </div>

      <div v-if="!twoFAEnabled && !setupQr">
        <button @click="startSetup" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-white text-sm">{{ t('security.twoFactor.enable') }}</button>
      </div>

      <div v-if="setupQr" class="space-y-3">
        <p class="text-sm text-ink-muted">{{ t('security.twoFactor.scanHint') }}</p>
        <img :src="setupQr" :alt="t('security.twoFactor.qrAlt')" class="w-48 h-48 bg-white p-2 rounded" />
        <p class="text-xs text-ink-subtle font-mono break-all">{{ t('security.twoFactor.secret', { secret: setupSecret }) }}</p>
        <div class="flex gap-2">
          <input v-model="code" type="text" inputmode="numeric" maxlength="6" placeholder="123456" :aria-label="t('security.twoFactor.codeLabel')" class="bg-surface-overlay border border-border/40 rounded-lg px-3 py-2 text-sm text-ink font-mono w-32" />
          <button @click="confirmSetup" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-white text-sm">{{ t('security.twoFactor.confirm') }}</button>
        </div>
      </div>

      <div v-if="backupCodes" class="mt-4 p-4 bg-status-warning/10 border border-status-warning/40 rounded-lg">
        <h3 class="font-semibold text-status-warning mb-2">{{ t('security.twoFactor.backupTitle') }}</h3>
        <p class="text-xs text-ink-muted mb-3">{{ t('security.twoFactor.backupHint') }}</p>
        <div class="grid grid-cols-2 gap-2 font-mono text-sm">
          <span v-for="c in backupCodes" :key="c" class="bg-surface-overlay px-2 py-1 rounded">{{ c }}</span>
        </div>
      </div>

      <div v-if="twoFAEnabled && !backupCodes" class="mt-4 space-y-2">
        <h3 class="text-sm font-semibold text-ink">{{ t('security.twoFactor.disableTitle') }}</h3>
        <div class="flex flex-wrap gap-2">
          <input v-model="disablePassword" type="password" autocomplete="current-password" :placeholder="t('security.twoFactor.currentPassword')" :aria-label="t('security.twoFactor.currentPassword')" class="bg-surface-overlay border border-border/40 rounded-lg px-3 py-2 text-sm text-ink" />
          <input v-model="disableCode" :placeholder="t('security.twoFactor.disableCodePlaceholder')" :aria-label="t('security.twoFactor.disableCodePlaceholder')" class="bg-surface-overlay border border-border/40 rounded-lg px-3 py-2 text-sm text-ink font-mono" />
          <button @click="disable2fa" :disabled="!disablePassword || !disableCode" class="px-3 py-1.5 rounded-lg bg-status-error/30 hover:bg-status-error/50 text-status-error text-sm disabled:opacity-50">{{ t('security.twoFactor.disable') }}</button>
        </div>
      </div>
    </section>

    <!-- API Keys -->
    <section class="bg-surface-raised border border-border/40 rounded-xl p-5">
      <h2 class="text-lg font-semibold text-ink mb-1">{{ t('security.apiKeys.title') }}</h2>
      <p class="text-sm text-ink-muted mb-4">{{ t('security.apiKeys.intro') }}</p>

      <div v-if="justCreatedToken" class="p-4 bg-status-success/10 border border-status-success/40 rounded-lg mb-4">
        <p class="text-xs text-ink-muted mb-2">{{ t('security.apiKeys.newTokenHint') }}</p>
        <code class="block font-mono text-sm bg-surface-sunken p-2 rounded break-all text-status-success">{{ justCreatedToken }}</code>
        <button @click="justCreatedToken = null" class="mt-2 text-xs text-ink-muted hover:text-ink">{{ t('common.dismiss') }}</button>
      </div>

      <div class="space-y-2 mb-4">
        <div v-for="k in apiKeys" :key="k.id" class="flex items-center gap-3 p-3 bg-surface-overlay border border-border/40 rounded-lg">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium text-ink">{{ k.name }}</span>
              <code class="text-xs font-mono text-ink-muted">{{ k.prefix }}…</code>
            </div>
            <div class="text-xs text-ink-subtle mt-0.5">{{ keyMeta(k) }}</div>
            <div class="text-xs text-ink-muted mt-0.5" :title="serverTitle(k)">{{ t('serverAccess.servers') }}: {{ serversLabel(k) }}</div>
          </div>
          <button v-if="!k.revokedAt" @click="editServers(k)" :aria-label="t('serverAccess.editKeyAria', { name: k.name })" class="px-2 py-1 text-xs rounded bg-surface-raised hover:bg-surface-sunken text-ink-muted hover:text-ink">{{ t('serverAccess.servers') }}</button>
          <button @click="askRevoke(k)" :aria-label="t('security.revokeApiKeyAria', { name: k.name })" class="px-2 py-1 text-xs rounded bg-status-error/20 hover:bg-status-error/40 text-status-error">{{ t('common.revoke') }}</button>
        </div>
        <div v-if="apiKeys.length === 0" class="text-center text-sm text-ink-muted py-4">{{ t('security.apiKeys.empty') }}</div>
      </div>

      <div class="space-y-2">
        <input v-model="newKey.name" :placeholder="t('security.apiKeys.namePlaceholder')" :aria-label="t('security.apiKeys.namePlaceholder')" class="w-full bg-surface-overlay border border-border/40 rounded-lg px-3 py-2 text-sm text-ink" />
        <input v-model="newKey.scopes" :placeholder="t('security.apiKeys.scopesPlaceholder')" :aria-label="t('security.apiKeys.scopesPlaceholder')" class="w-full bg-surface-overlay border border-border/40 rounded-lg px-3 py-2 text-sm text-ink" />
        <ServerAccessEditor
          v-model="newKeyServers"
          :all-label="t('serverAccess.keyAll')"
          :all-hint="t('serverAccess.keyAllHint')"
        />
        <p v-if="keyError" class="text-sm text-status-error" role="alert">{{ keyError }}</p>
        <button @click="createKey" :disabled="!newKey.name || !newKey.scopes" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-white text-sm disabled:opacity-50">{{ t('security.apiKeys.create') }}</button>
      </div>
    </section>

    <Modal :open="!!serversTarget" :title="t('serverAccess.keyServersTitle', { name: serversTarget?.name ?? '' })" @close="serversTarget = null">
      <div class="space-y-3">
        <ServerAccessEditor
          v-model="serversDraft"
          :all-label="t('serverAccess.keyAll')"
          :all-hint="t('serverAccess.keyAllHint')"
        />
        <p v-if="keyError" class="text-sm text-status-error" role="alert">{{ keyError }}</p>
      </div>
      <template #footer>
        <Button variant="secondary" size="sm" :disabled="savingServers" @click="serversTarget = null">{{ t('common.cancel') }}</Button>
        <Button variant="primary" size="sm" :loading="savingServers" @click="saveServers">{{ t('common.save') }}</Button>
      </template>
    </Modal>

    <!-- Revoke confirm dialog (replaces window.confirm) -->
    <ConfirmDialog
      :show="revokeDialogOpen"
      :title="t('security.confirmRevokeTitle')"
      :message="t('security.confirmRevokeMessage', { name: revokeTargetName })"
      :confirm-text="t('common.revoke')"
      variant="danger"
      @confirm="confirmRevoke"
      @cancel="revokeDialogOpen = false"
    />
  </div>
</template>
