<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

const { t } = useI18n()

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
  const { data } = await api.post<{ secret: string; otpauthUrl: string; qrDataUrl: string }>('/auth/2fa/setup')
  setupQr.value = data.qrDataUrl
  setupSecret.value = data.secret
}

async function confirmSetup() {
  const { data } = await api.post<{ backupCodes: string[] }>('/auth/2fa/verify-enable', { code: code.value })
  backupCodes.value = data.backupCodes
  setupQr.value = null
  setupSecret.value = null
  code.value = ''
  await load2fa()
}

async function disable2fa() {
  await api.post('/auth/2fa/disable', { password: disablePassword.value, code: disableCode.value })
  disablePassword.value = ''
  disableCode.value = ''
  backupCodes.value = null
  await load2fa()
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
}
const apiKeys = ref<ApiKey[]>([])
const newKey = ref<{ name: string; scopes: string }>({ name: '', scopes: '' })
const justCreatedToken = ref<string | null>(null)

async function loadKeys() {
  const { data } = await api.get<{ keys: ApiKey[] }>('/auth/api-keys')
  apiKeys.value = data.keys
}

async function createKey() {
  const scopes = newKey.value.scopes.split(',').map(s => s.trim()).filter(Boolean)
  if (!newKey.value.name || scopes.length === 0) return
  const { data } = await api.post<{ key: ApiKey; token: string }>('/auth/api-keys', {
    name: newKey.value.name, scopes,
  })
  justCreatedToken.value = data.token
  newKey.value = { name: '', scopes: '' }
  await loadKeys()
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
  await api.delete(`/auth/api-keys/${revokeTargetId.value}`)
  revokeDialogOpen.value = false
  revokeTargetId.value = null
  await loadKeys()
}

onMounted(async () => {
  await load2fa()
  await loadKeys()
})
</script>

<template>
  <div class="space-y-6 max-w-3xl">
    <h1 class="text-2xl font-bold text-white">Security</h1>

    <!-- 2FA -->
    <section class="bg-dark-200 border border-dark-50/40 rounded-xl p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-lg font-semibold text-white">Two-factor authentication</h2>
          <p class="text-sm text-gray-400">{{ twoFAEnabled ? 'Active — your account is protected by a TOTP authenticator.' : 'Disabled. Enable to require a TOTP code at login.' }}</p>
        </div>
        <span class="text-xs px-2 py-1 rounded-full" :class="twoFAEnabled ? 'bg-status-success/20 text-status-success' : 'bg-dark-100 text-gray-400'">
          {{ twoFAEnabled ? 'ENABLED' : 'DISABLED' }}
        </span>
      </div>

      <div v-if="!twoFAEnabled && !setupQr">
        <button @click="startSetup" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-white text-sm">Enable 2FA</button>
      </div>

      <div v-if="setupQr" class="space-y-3">
        <p class="text-sm text-gray-300">Scan the QR with your authenticator (1Password, Bitwarden, Aegis, Google Authenticator), then enter the 6-digit code to confirm.</p>
        <img :src="setupQr" alt="2FA QR code" class="w-48 h-48 bg-white p-2 rounded" />
        <p class="text-xs text-gray-500 font-mono break-all">Secret: {{ setupSecret }}</p>
        <div class="flex gap-2">
          <input v-model="code" type="text" inputmode="numeric" maxlength="6" placeholder="123456" class="bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white font-mono w-32" />
          <button @click="confirmSetup" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-white text-sm">Confirm</button>
        </div>
      </div>

      <div v-if="backupCodes" class="mt-4 p-4 bg-status-warning/10 border border-status-warning/40 rounded-lg">
        <h3 class="font-semibold text-status-warning mb-2">Save these backup codes</h3>
        <p class="text-xs text-gray-300 mb-3">Each can be used once if you lose access to your authenticator. They will NOT be shown again.</p>
        <div class="grid grid-cols-2 gap-2 font-mono text-sm">
          <span v-for="c in backupCodes" :key="c" class="bg-dark-100 px-2 py-1 rounded">{{ c }}</span>
        </div>
      </div>

      <div v-if="twoFAEnabled && !backupCodes" class="mt-4 space-y-2">
        <h3 class="text-sm font-semibold text-white">Disable 2FA</h3>
        <div class="flex flex-wrap gap-2">
          <input v-model="disablePassword" type="password" placeholder="Current password" class="bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
          <input v-model="disableCode" placeholder="TOTP or backup code" class="bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white font-mono" />
          <button @click="disable2fa" :disabled="!disablePassword || !disableCode" class="px-3 py-1.5 rounded-lg bg-status-error/30 hover:bg-status-error/50 text-status-error text-sm disabled:opacity-50">Disable</button>
        </div>
      </div>
    </section>

    <!-- API Keys -->
    <section class="bg-dark-200 border border-dark-50/40 rounded-xl p-5">
      <h2 class="text-lg font-semibold text-white mb-1">REST API keys</h2>
      <p class="text-sm text-gray-400 mb-4">For CI pipelines, monitoring scripts, and external integrations. Each key carries an explicit scope set — never broader than your own permissions.</p>

      <div v-if="justCreatedToken" class="p-4 bg-status-success/10 border border-status-success/40 rounded-lg mb-4">
        <p class="text-xs text-gray-300 mb-2">Your new token (shown once — copy it now):</p>
        <code class="block font-mono text-sm bg-dark-300 p-2 rounded break-all text-status-success">{{ justCreatedToken }}</code>
        <button @click="justCreatedToken = null" class="mt-2 text-xs text-gray-400 hover:text-white">Dismiss</button>
      </div>

      <div class="space-y-2 mb-4">
        <div v-for="k in apiKeys" :key="k.id" class="flex items-center gap-3 p-3 bg-dark-100 border border-dark-50/40 rounded-lg">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium text-white">{{ k.name }}</span>
              <code class="text-xs font-mono text-gray-400">{{ k.prefix }}…</code>
            </div>
            <div class="text-xs text-gray-500 mt-0.5">{{ k.scopes.length }} scopes · created {{ new Date(k.createdAt).toLocaleDateString() }} · last used {{ k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'never' }}</div>
          </div>
          <button @click="askRevoke(k)" :aria-label="t('security.revokeApiKeyAria', { name: k.name })" class="px-2 py-1 text-xs rounded bg-status-error/20 hover:bg-status-error/40 text-status-error">{{ t('common.revoke') }}</button>
        </div>
        <div v-if="apiKeys.length === 0" class="text-center text-sm text-gray-400 py-4">No API keys yet.</div>
      </div>

      <div class="space-y-2">
        <input v-model="newKey.name" placeholder="Key name (e.g. 'CI deploy bot')" class="w-full bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
        <input v-model="newKey.scopes" placeholder="Comma-separated scopes (e.g. server.view_status, backups.create)" class="w-full bg-dark-100 border border-dark-50/40 rounded-lg px-3 py-2 text-sm text-white" />
        <button @click="createKey" :disabled="!newKey.name || !newKey.scopes" class="px-3 py-1.5 rounded-lg bg-hytale-orange hover:bg-hytale-orange-dark text-white text-sm disabled:opacity-50">Create key</button>
      </div>
    </section>

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
