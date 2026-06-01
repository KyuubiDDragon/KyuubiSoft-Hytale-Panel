<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale, getLocale } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import Card from '@/components/ui/Card.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { serverApi, type ConfigFile, type PatchlineResponse, type AcceptEarlyPluginsResponse, type DisableSentryResponse, type AllowOpResponse, type JvmSettings } from '@/api/server'
import { authApi, type HytaleAuthStatus, type HytaleDeviceCodeResponse } from '@/api/auth'
import { settingsApi, type IntegrationsStatus, type IntegrationsUpdate, type AutoModConfig, type DiscordStatus, type OffsiteBackupStatus } from '@/api/settings'
import { useToast } from '@/composables/useToast'
import { pushApi, type WebPushSettings } from '@/api/push'
import { usePush } from '@/composables/usePush'

const { t } = useI18n()
const authStore = useAuthStore()
const toast = useToast()

const currentLocale = ref(getLocale())
const configFiles = ref<ConfigFile[]>([])
const selectedFile = ref<string | null>(null)
const fileContent = ref('')
const originalContent = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

// Hytale Auth
const hytaleAuthStatus = ref<HytaleAuthStatus>({ authenticated: false })
const hytaleAuthLoading = ref(false)
const hytaleAuthError = ref<string | null>(null)
const hytaleAuthSuccess = ref<string | null>(null)
const deviceCodeData = ref<HytaleDeviceCodeResponse | null>(null)
const checkingInterval = ref<number | null>(null)
const showResetAuthConfirm = ref(false)

// Patchline Settings
const patchlineData = ref<PatchlineResponse | null>(null)
const patchlineLoading = ref(false)
const patchlineError = ref<string | null>(null)
const patchlineSuccess = ref<string | null>(null)
const patchlineNeedsRestart = ref(false)

// Accept Early Plugins Settings
const acceptEarlyPluginsData = ref<AcceptEarlyPluginsResponse | null>(null)
const acceptEarlyPluginsLoading = ref(false)
const acceptEarlyPluginsError = ref<string | null>(null)
const acceptEarlyPluginsSuccess = ref<string | null>(null)
const acceptEarlyPluginsNeedsRestart = ref(false)

// Disable Sentry Settings
const disableSentryData = ref<DisableSentryResponse | null>(null)
const disableSentryLoading = ref(false)
const disableSentryError = ref<string | null>(null)
const disableSentrySuccess = ref<string | null>(null)
const disableSentryNeedsRestart = ref(false)

// Allow OP Settings
const allowOpData = ref<AllowOpResponse | null>(null)
const allowOpLoading = ref(false)
const allowOpError = ref<string | null>(null)
const allowOpSuccess = ref<string | null>(null)
const allowOpNeedsRestart = ref(false)

// JVM / startup tuning (RAM + extra args)
const jvmData = ref<JvmSettings | null>(null)
const jvmLoading = ref(false)
const jvmSaving = ref(false)
const jvmNeedsRestart = ref(false)
const jvmForm = ref({ javaMinRam: '', javaMaxRam: '', extraJavaArgs: '', extraServerArgs: '' })

// Integration API keys (CurseForge / Modtale / StackMart)
const canEditIntegrations = computed(() => authStore.hasPermission('settings.edit'))
const integrations = ref<IntegrationsStatus | null>(null)
const integrationsLoading = ref(false)
const integrationsSaving = ref(false)
const integrationsError = ref<string | null>(null)
const integrationsSuccess = ref<string | null>(null)
// Form holds NEW values the user types. Empty string = leave unchanged.
const integrationsForm = ref({
  curseforgeApiKey: '',
  curseforgeGameId: '' as number | '',
  modtaleApiKey: '',
  stackmartApiKey: '',
})

// Auto-moderation (chat filter)
const automod = ref<AutoModConfig | null>(null)
const automodLoading = ref(false)
const automodSaving = ref(false)
const automodBannedWordsText = ref('')

// Discord bot (chat bridge)
const discord = ref<DiscordStatus | null>(null)
const discordLoading = ref(false)
const discordSaving = ref(false)
const discordForm = ref({ enabled: false, token: '', channelId: '', guildId: '' })

// Web Push (PWA notifications)
const webpush = ref<WebPushSettings | null>(null)
const webpushLoading = ref(false)
const webpushSaving = ref(false)
const webpushForm = ref({ enabled: false, subject: 'mailto:admin@example.com' })
const push = usePush()

// Off-site backup (S3-compatible)
const offsite = ref<OffsiteBackupStatus | null>(null)
const offsiteLoading = ref(false)
const offsiteSaving = ref(false)
const offsiteTesting = ref(false)
const offsiteForm = ref({
  enabled: false, endpoint: '', region: 'us-east-1', bucket: '', prefix: 'hytale-backups/',
  accessKeyId: '', secretAccessKey: '', uploadOnBackup: true,
})

function changeLocale(locale: 'de' | 'en' | 'pt_br') {
  setLocale(locale)
  currentLocale.value = locale
}

async function loadIntegrations() {
  try {
    integrationsLoading.value = true
    integrationsError.value = null
    integrations.value = await settingsApi.getIntegrations()
    // Pre-fill the (non-secret) game id so the user sees the current value.
    integrationsForm.value.curseforgeGameId = integrations.value.curseforge.gameId
  } catch (e) {
    integrationsError.value = t('settings.integrations.loadFailed')
  } finally {
    integrationsLoading.value = false
  }
}

async function saveIntegrations() {
  try {
    integrationsSaving.value = true
    integrationsError.value = null
    integrationsSuccess.value = null

    // Only send fields the user actually changed. Empty secret inputs are
    // omitted so we never overwrite an existing key with a blank.
    const payload: IntegrationsUpdate = {}
    if (integrationsForm.value.curseforgeApiKey.trim()) payload.curseforgeApiKey = integrationsForm.value.curseforgeApiKey.trim()
    if (integrationsForm.value.modtaleApiKey.trim()) payload.modtaleApiKey = integrationsForm.value.modtaleApiKey.trim()
    if (integrationsForm.value.stackmartApiKey.trim()) payload.stackmartApiKey = integrationsForm.value.stackmartApiKey.trim()
    const gameId = integrationsForm.value.curseforgeGameId
    if (typeof gameId === 'number' && gameId > 0 && gameId !== integrations.value?.curseforge.gameId) {
      payload.curseforgeGameId = gameId
    }

    if (Object.keys(payload).length === 0) {
      integrationsError.value = t('settings.integrations.nothingToSave')
      return
    }

    const result = await settingsApi.saveIntegrations(payload)
    integrations.value = result.data
    // Clear secret inputs after a successful save; keep the game id visible.
    integrationsForm.value.curseforgeApiKey = ''
    integrationsForm.value.modtaleApiKey = ''
    integrationsForm.value.stackmartApiKey = ''
    integrationsForm.value.curseforgeGameId = result.data.curseforge.gameId
    integrationsSuccess.value = t('settings.integrations.saved')
    setTimeout(() => { integrationsSuccess.value = null }, 3000)
  } catch (e) {
    integrationsError.value = t('settings.integrations.saveFailed')
  } finally {
    integrationsSaving.value = false
  }
}

// Clear a stored secret (reverts to the env var fallback if one is set).
async function clearIntegration(field: 'curseforgeApiKey' | 'modtaleApiKey' | 'stackmartApiKey') {
  try {
    integrationsSaving.value = true
    integrationsError.value = null
    integrationsSuccess.value = null
    const result = await settingsApi.saveIntegrations({ [field]: '' })
    integrations.value = result.data
    integrationsSuccess.value = t('settings.integrations.saved')
    setTimeout(() => { integrationsSuccess.value = null }, 3000)
  } catch (e) {
    integrationsError.value = t('settings.integrations.saveFailed')
  } finally {
    integrationsSaving.value = false
  }
}

async function loadAutoMod() {
  try {
    automodLoading.value = true
    automod.value = await settingsApi.getAutoMod()
    automodBannedWordsText.value = (automod.value.bannedWords || []).join(', ')
  } catch {
    // automod settings unavailable (permission / older backend)
  } finally {
    automodLoading.value = false
  }
}

async function saveAutoMod() {
  if (!automod.value) return
  try {
    automodSaving.value = true
    const payload: AutoModConfig = {
      ...automod.value,
      bannedWords: automodBannedWordsText.value
        .split(',')
        .map(w => w.trim().toLowerCase())
        .filter(w => w.length > 0),
    }
    const result = await settingsApi.saveAutoMod(payload)
    automod.value = result.data
    automodBannedWordsText.value = result.data.bannedWords.join(', ')
    toast.success(t('settings.automod.saved'))
  } catch {
    toast.error(t('settings.automod.saveFailed'))
  } finally {
    automodSaving.value = false
  }
}

async function loadDiscord() {
  try {
    discordLoading.value = true
    discord.value = await settingsApi.getDiscord()
    discordForm.value.enabled = discord.value.enabled
    discordForm.value.channelId = discord.value.channelId
    discordForm.value.guildId = discord.value.guildId
    discordForm.value.token = ''
  } catch {
    // discord settings unavailable (permission / older backend)
  } finally {
    discordLoading.value = false
  }
}

async function saveDiscord() {
  try {
    discordSaving.value = true
    const payload: { enabled: boolean; channelId: string; guildId: string; token?: string } = {
      enabled: discordForm.value.enabled,
      channelId: discordForm.value.channelId.trim(),
      guildId: discordForm.value.guildId.trim(),
    }
    // Only send the token when the user typed a new one (empty = keep current).
    if (discordForm.value.token.trim()) payload.token = discordForm.value.token.trim()
    const result = await settingsApi.saveDiscord(payload)
    discord.value = result.data
    discordForm.value.token = ''
    discordForm.value.channelId = result.data.channelId
    discordForm.value.guildId = result.data.guildId
    toast.success(t('settings.discord.saved'))
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
    toast.error(msg || t('settings.discord.saveFailed'))
  } finally {
    discordSaving.value = false
  }
}

async function loadWebPush() {
  try {
    webpushLoading.value = true
    webpush.value = await pushApi.getSettings()
    webpushForm.value.enabled = webpush.value.enabled
    webpushForm.value.subject = webpush.value.subject
    await push.refresh()
  } catch {
    // web-push settings unavailable
  } finally {
    webpushLoading.value = false
  }
}

async function saveWebPush() {
  try {
    webpushSaving.value = true
    const result = await pushApi.saveSettings({
      enabled: webpushForm.value.enabled,
      subject: webpushForm.value.subject.trim(),
    })
    webpush.value = result.data
    webpushForm.value.enabled = result.data.enabled
    await push.refresh()
    toast.success(t('settings.webpush.saved'))
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
    toast.error(msg || t('settings.webpush.saveFailed'))
  } finally {
    webpushSaving.value = false
  }
}

async function subscribeThisDevice() {
  const res = await push.enable()
  if (res.ok) {
    toast.success(t('settings.webpush.subscribed'))
  } else if (res.error === 'denied') {
    toast.error(t('settings.webpush.permissionDenied'))
  } else {
    toast.error(t('settings.webpush.subscribeFailed'))
  }
}

async function unsubscribeThisDevice() {
  await push.disable()
  toast.success(t('settings.webpush.unsubscribed'))
}

async function testWebPush() {
  const ok = await push.test()
  if (ok) toast.success(t('settings.webpush.testSent'))
  else toast.error(t('settings.webpush.testFailed'))
}

async function loadOffsite() {
  try {
    offsiteLoading.value = true
    offsite.value = await settingsApi.getOffsiteBackup()
    offsiteForm.value.enabled = offsite.value.enabled
    offsiteForm.value.endpoint = offsite.value.endpoint
    offsiteForm.value.region = offsite.value.region
    offsiteForm.value.bucket = offsite.value.bucket
    offsiteForm.value.prefix = offsite.value.prefix
    offsiteForm.value.accessKeyId = offsite.value.accessKeyId
    offsiteForm.value.uploadOnBackup = offsite.value.uploadOnBackup
    offsiteForm.value.secretAccessKey = ''
  } catch {
    // off-site settings unavailable (permission / older backend)
  } finally {
    offsiteLoading.value = false
  }
}

async function saveOffsite() {
  try {
    offsiteSaving.value = true
    const payload: Record<string, unknown> = {
      enabled: offsiteForm.value.enabled,
      endpoint: offsiteForm.value.endpoint.trim(),
      region: offsiteForm.value.region.trim(),
      bucket: offsiteForm.value.bucket.trim(),
      prefix: offsiteForm.value.prefix.trim(),
      accessKeyId: offsiteForm.value.accessKeyId.trim(),
      uploadOnBackup: offsiteForm.value.uploadOnBackup,
    }
    if (offsiteForm.value.secretAccessKey.trim()) payload.secretAccessKey = offsiteForm.value.secretAccessKey.trim()
    await settingsApi.saveOffsiteBackup(payload)
    await loadOffsite()
    toast.success(t('settings.offsite.saved'))
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
    toast.error(msg || t('settings.offsite.saveFailed'))
  } finally {
    offsiteSaving.value = false
  }
}

async function testOffsite() {
  try {
    offsiteTesting.value = true
    const result = await settingsApi.testOffsiteBackup()
    if (result.success) toast.success(t('settings.offsite.testOk'))
    else toast.error(result.error || t('settings.offsite.testFailed'))
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
    toast.error(msg || t('settings.offsite.testFailed'))
  } finally {
    offsiteTesting.value = false
  }
}

function integrationStatusLabel(s: { configured: boolean; source: string; masked: string | null } | undefined): string {
  if (!s || !s.configured) return t('settings.integrations.statusUnset')
  if (s.source === 'env') return t('settings.integrations.statusEnv', { hint: s.masked })
  return t('settings.integrations.statusConfig', { hint: s.masked })
}

async function loadConfigFiles() {
  try {
    loading.value = true
    error.value = null
    const response = await serverApi.getConfigFiles()
    configFiles.value = response.files
  } catch (e) {
    error.value = t('settings.errors.loadConfigFailed')
    configFiles.value = []
  } finally {
    loading.value = false
  }
}

async function selectFile(filename: string) {
  try {
    loading.value = true
    error.value = null
    successMessage.value = null
    const response = await serverApi.getConfigContent(filename)
    selectedFile.value = filename
    fileContent.value = response.content
    originalContent.value = response.content
  } catch (e) {
    error.value = t('settings.errors.loadFileFailed', { filename })
  } finally {
    loading.value = false
  }
}

async function saveFile() {
  if (!selectedFile.value) return

  try {
    saving.value = true
    error.value = null
    successMessage.value = null
    await serverApi.saveConfigContent(selectedFile.value, fileContent.value)
    originalContent.value = fileContent.value
    successMessage.value = t('settings.configSaved')
    setTimeout(() => { successMessage.value = null }, 3000)
  } catch (e) {
    error.value = t('settings.errors.saveConfigFailed')
  } finally {
    saving.value = false
  }
}

function closeEditor() {
  selectedFile.value = null
  fileContent.value = ''
  originalContent.value = ''
}

const hasChanges = computed(() => fileContent.value !== originalContent.value)

// Patchline Functions
async function loadPatchline() {
  try {
    patchlineLoading.value = true
    patchlineError.value = null
    const response = await serverApi.getPatchline()
    patchlineData.value = response
  } catch (e) {
    patchlineError.value = t('settings.errors.loadSettingFailed')
  } finally {
    patchlineLoading.value = false
  }
}

async function setPatchline(patchline: string) {
  try {
    patchlineLoading.value = true
    patchlineError.value = null
    patchlineSuccess.value = null

    const response = await serverApi.setPatchline(patchline)

    if (response.success) {
      patchlineData.value = { ...patchlineData.value!, patchline: response.patchline }
      patchlineSuccess.value = response.message

      // If patchline was changed, show restart button
      if (response.changed) {
        patchlineNeedsRestart.value = true
      }
    }
  } catch (e) {
    patchlineError.value = t('settings.errors.updateSettingFailed')
  } finally {
    patchlineLoading.value = false
  }
}

async function restartForPatchline() {
  try {
    patchlineLoading.value = true
    await serverApi.restart()
    patchlineNeedsRestart.value = false
    patchlineSuccess.value = t('settings.patchlineRestarting')
  } catch (e) {
    patchlineError.value = t('settings.errors.restartFailed')
  } finally {
    patchlineLoading.value = false
  }
}

// Accept Early Plugins Functions
async function loadAcceptEarlyPlugins() {
  try {
    acceptEarlyPluginsLoading.value = true
    acceptEarlyPluginsError.value = null
    const response = await serverApi.getAcceptEarlyPlugins()
    acceptEarlyPluginsData.value = response
  } catch (e) {
    acceptEarlyPluginsError.value = t('settings.errors.loadSettingFailed')
  } finally {
    acceptEarlyPluginsLoading.value = false
  }
}

async function setAcceptEarlyPlugins(enabled: boolean) {
  try {
    acceptEarlyPluginsLoading.value = true
    acceptEarlyPluginsError.value = null
    acceptEarlyPluginsSuccess.value = null

    const response = await serverApi.setAcceptEarlyPlugins(enabled)

    if (response.success) {
      acceptEarlyPluginsData.value = { acceptEarlyPlugins: response.acceptEarlyPlugins }
      acceptEarlyPluginsSuccess.value = response.message

      // If setting was changed, show restart button
      if (response.changed) {
        acceptEarlyPluginsNeedsRestart.value = true
      }
    }
  } catch (e) {
    acceptEarlyPluginsError.value = t('settings.errors.updateSettingFailed')
  } finally {
    acceptEarlyPluginsLoading.value = false
  }
}

async function restartForAcceptEarlyPlugins() {
  try {
    acceptEarlyPluginsLoading.value = true
    await serverApi.restart()
    acceptEarlyPluginsNeedsRestart.value = false
    acceptEarlyPluginsSuccess.value = t('settings.acceptEarlyPluginsRestarting')
  } catch (e) {
    acceptEarlyPluginsError.value = t('settings.errors.restartFailed')
  } finally {
    acceptEarlyPluginsLoading.value = false
  }
}

// Disable Sentry Functions
async function loadDisableSentry() {
  try {
    disableSentryLoading.value = true
    disableSentryError.value = null
    const response = await serverApi.getDisableSentry()
    disableSentryData.value = response
  } catch (e) {
    disableSentryError.value = t('settings.errors.loadSettingFailed')
  } finally {
    disableSentryLoading.value = false
  }
}

async function setDisableSentry(enabled: boolean) {
  try {
    disableSentryLoading.value = true
    disableSentryError.value = null
    disableSentrySuccess.value = null

    const response = await serverApi.setDisableSentry(enabled)

    if (response.success) {
      disableSentryData.value = { disableSentry: response.disableSentry }
      disableSentrySuccess.value = response.message

      if (response.changed) {
        disableSentryNeedsRestart.value = true
      }
    }
  } catch (e) {
    disableSentryError.value = t('settings.errors.updateSettingFailed')
  } finally {
    disableSentryLoading.value = false
  }
}

async function restartForDisableSentry() {
  try {
    disableSentryLoading.value = true
    await serverApi.restart()
    disableSentryNeedsRestart.value = false
    disableSentrySuccess.value = t('settings.disableSentryRestarting')
  } catch (e) {
    disableSentryError.value = t('settings.errors.restartFailed')
  } finally {
    disableSentryLoading.value = false
  }
}

// Allow OP Functions
async function loadAllowOp() {
  try {
    allowOpLoading.value = true
    allowOpError.value = null
    const response = await serverApi.getAllowOp()
    allowOpData.value = response
  } catch (e) {
    allowOpError.value = t('settings.errors.loadSettingFailed')
  } finally {
    allowOpLoading.value = false
  }
}

async function setAllowOp(enabled: boolean) {
  try {
    allowOpLoading.value = true
    allowOpError.value = null
    allowOpSuccess.value = null

    const response = await serverApi.setAllowOp(enabled)

    if (response.success) {
      allowOpData.value = { allowOp: response.allowOp }
      allowOpSuccess.value = response.message

      if (response.changed) {
        allowOpNeedsRestart.value = true
      }
    }
  } catch (e) {
    allowOpError.value = t('settings.errors.updateSettingFailed')
  } finally {
    allowOpLoading.value = false
  }
}

async function restartForAllowOp() {
  try {
    allowOpLoading.value = true
    await serverApi.restart()
    allowOpNeedsRestart.value = false
    allowOpSuccess.value = t('settings.allowOpRestarting')
  } catch (e) {
    allowOpError.value = t('settings.errors.restartFailed')
  } finally {
    allowOpLoading.value = false
  }
}

async function loadJvm() {
  try {
    jvmLoading.value = true
    const data = await serverApi.getJvmSettings()
    jvmData.value = data
    jvmForm.value.javaMinRam = data.javaMinRam
    jvmForm.value.javaMaxRam = data.javaMaxRam
    jvmForm.value.extraJavaArgs = data.extraJavaArgs
    jvmForm.value.extraServerArgs = data.extraServerArgs
  } catch {
    // settings unavailable
  } finally {
    jvmLoading.value = false
  }
}

async function saveJvm() {
  try {
    jvmSaving.value = true
    const result = await serverApi.saveJvmSettings({
      javaMinRam: jvmForm.value.javaMinRam.trim(),
      javaMaxRam: jvmForm.value.javaMaxRam.trim(),
      extraJavaArgs: jvmForm.value.extraJavaArgs.trim(),
      extraServerArgs: jvmForm.value.extraServerArgs.trim(),
    })
    if (result.changed) jvmNeedsRestart.value = true
    toast.success(result.message || t('settings.jvm.saved'))
    await loadJvm()
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
    toast.error(msg || t('settings.jvm.saveFailed'))
  } finally {
    jvmSaving.value = false
  }
}

async function restartForJvm() {
  try {
    jvmSaving.value = true
    await serverApi.restart()
    jvmNeedsRestart.value = false
    toast.success(t('settings.jvm.restarting'))
  } catch {
    toast.error(t('settings.errors.restartFailed'))
  } finally {
    jvmSaving.value = false
  }
}

// Hytale Auth Functions
async function loadHytaleAuthStatus() {
  try {
    // First verify auth status with the backend (this updates the stored status)
    await authApi.checkHytaleAuthCompletion()

    // Then get the updated status
    const status = await authApi.getHytaleAuthStatus()
    hytaleAuthStatus.value = status
  } catch (e) {
    console.error('Failed to load Hytale auth status:', e)
  }
}

async function initiateHytaleAuth() {
  try {
    hytaleAuthLoading.value = true
    hytaleAuthError.value = null
    hytaleAuthSuccess.value = null

    const result = await authApi.initiateHytaleLogin()

    if (!result.success) {
      hytaleAuthError.value = result.error || t('settings.errors.initAuthFailed')
      return
    }

    deviceCodeData.value = result

    // Start polling for completion
    startAuthPolling()
  } catch (e) {
    hytaleAuthError.value = t('settings.errors.authError')
  } finally {
    hytaleAuthLoading.value = false
  }
}

function startAuthPolling() {
  // Poll every 5 seconds
  checkingInterval.value = window.setInterval(async () => {
    try {
      const result = await authApi.checkHytaleAuthCompletion()

      if (result.success) {
        // Authentication completed!
        stopAuthPolling()
        hytaleAuthSuccess.value = result.message || t('settings.authSuccess')
        deviceCodeData.value = null
        await loadHytaleAuthStatus()

        // Clear success message after 5 seconds
        setTimeout(() => {
          hytaleAuthSuccess.value = null
        }, 5000)
      }
    } catch (e) {
      console.error('Error checking auth completion:', e)
    }
  }, 5000)
}

function stopAuthPolling() {
  if (checkingInterval.value) {
    window.clearInterval(checkingInterval.value)
    checkingInterval.value = null
  }
}

async function verifyAuth() {
  try {
    hytaleAuthLoading.value = true
    hytaleAuthError.value = null

    const result = await authApi.checkHytaleAuthCompletion()

    if (result.success) {
      hytaleAuthSuccess.value = result.message || t('settings.authSuccess')
      deviceCodeData.value = null
      stopAuthPolling()
      await loadHytaleAuthStatus()
    } else {
      hytaleAuthError.value = result.error || t('settings.authPending')
    }
  } catch (e) {
    hytaleAuthError.value = t('settings.errors.verifyAuthFailed')
  } finally {
    hytaleAuthLoading.value = false
  }
}

async function resetHytaleAuth() {
  try {
    hytaleAuthLoading.value = true
    hytaleAuthError.value = null
    hytaleAuthSuccess.value = null

    await authApi.resetHytaleAuth()
    deviceCodeData.value = null
    stopAuthPolling()
    await loadHytaleAuthStatus()
  } catch (e) {
    hytaleAuthError.value = t('settings.errors.resetAuthFailed')
  } finally {
    hytaleAuthLoading.value = false
  }
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
  toast.success(t('common.copied'))
}

function openAuthUrl() {
  if (deviceCodeData.value?.verificationUrl) {
    window.open(deviceCodeData.value.verificationUrl, '_blank')
  }
}

onMounted(() => {
  // Only load config files if user has permission
  if (authStore.canManageConfig) {
    loadConfigFiles()
  }

  // Integration API keys are admin/config-manager territory.
  if (authStore.hasPermission('settings.view') || authStore.canManageConfig) {
    loadIntegrations()
    loadAutoMod()
    loadDiscord()
    loadOffsite()
    loadWebPush()
  }

  // Load Hytale auth status if user can manage server
  if (authStore.canManageServer) {
    loadHytaleAuthStatus()
    loadPatchline()
    loadAcceptEarlyPlugins()
    loadDisableSentry()
    loadAllowOp()
    loadJvm()
  }
})

onUnmounted(() => {
  stopAuthPolling()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <h1 class="text-2xl font-bold text-ink">{{ t('settings.title') }}</h1>

    <!-- Language Settings -->
    <Card :title="t('settings.language')">
      <div class="flex gap-4">
        <button
          @click="changeLocale('de')"
          :class="[
            'flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
            currentLocale === 'de'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-border hover:border-gray-600'
          ]"
        >
          <span class="text-2xl">🇩🇪</span>
          <div class="text-left">
            <p class="font-medium text-ink">{{ t('settings.german') }}</p>
            <p class="text-sm text-ink-muted">Deutsch</p>
          </div>
          <svg
            v-if="currentLocale === 'de'"
            class="w-5 h-5 text-hytale-orange ml-auto"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
        </button>

        <button
          @click="changeLocale('en')"
          :class="[
            'flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
            currentLocale === 'en'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-border hover:border-gray-600'
          ]"
        >
          <span class="text-2xl">🇬🇧</span>
          <div class="text-left">
            <p class="font-medium text-ink">{{ t('settings.english') }}</p>
            <p class="text-sm text-ink-muted">English</p>
          </div>
          <svg
            v-if="currentLocale === 'en'"
            class="w-5 h-5 text-hytale-orange ml-auto"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
        </button>

        <button
          @click="changeLocale('pt_br')"
          :class="[
            'flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
            currentLocale === 'pt_br'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-border hover:border-gray-600'
          ]"
        >
          <span class="text-2xl">🇧🇷</span>
          <div class="text-left">
            <p class="font-medium text-ink">Português (Brasil)</p>
            <p class="text-sm text-ink-muted">Portuguese (Brazil)</p>
          </div>
          <svg
            v-if="currentLocale === 'pt_br'"
            class="w-5 h-5 text-hytale-orange ml-auto"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
        </button>
      </div>
    </Card>

    <!-- Hytale Server Authentication (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.hytaleAuth')">
      <p class="text-ink-muted text-sm mb-4">{{ t('settings.hytaleAuthDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="hytaleAuthError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ hytaleAuthError }}
      </div>
      <div v-if="hytaleAuthSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ hytaleAuthSuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Status -->
        <div class="flex items-center justify-between p-4 bg-surface-muted rounded-lg">
          <div>
            <p class="text-sm text-ink-muted">{{ t('settings.authStatus') }}</p>
            <p class="text-ink font-medium mt-1">
              <span v-if="hytaleAuthStatus.authenticated" class="flex items-center gap-2">
                <svg class="w-5 h-5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ t('settings.authenticated') }}
              </span>
              <span v-else class="flex items-center gap-2">
                <svg class="w-5 h-5 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ t('settings.notAuthenticated') }}
              </span>
            </p>
            <!-- Persistence Type Warning -->
            <p v-if="hytaleAuthStatus.authenticated && hytaleAuthStatus.persistenceType === 'memory'" class="text-xs text-status-warning mt-1 flex items-center gap-1">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              {{ t('dashboard.authMemoryOnlyShort') }}
            </p>
          </div>

          <div class="flex gap-2">
            <button
              v-if="!hytaleAuthStatus.authenticated && !deviceCodeData && authStore.hasPermission('hytale_auth.manage')"
              @click="initiateHytaleAuth"
              :disabled="hytaleAuthLoading"
              class="btn btn-primary"
            >
              <svg v-if="hytaleAuthLoading" class="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ t('settings.initiateAuth') }}
            </button>

            <button
              v-if="hytaleAuthStatus.authenticated && authStore.hasPermission('hytale_auth.manage')"
              @click="showResetAuthConfirm = true"
              :disabled="hytaleAuthLoading"
              class="btn btn-secondary"
            >
              {{ t('settings.resetAuth') }}
            </button>
          </div>
        </div>

        <!-- Authentication in Progress -->
        <div v-if="deviceCodeData" class="p-4 bg-surface-muted rounded-lg border-2 border-hytale-orange">
          <div class="flex items-start gap-3">
            <svg class="w-6 h-6 text-hytale-orange mt-1 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div class="flex-1">
              <h3 class="text-ink font-medium mb-2">{{ t('settings.authInProgress') }}</h3>
              <p class="text-ink-muted text-sm mb-4">{{ t('settings.completeAuth') }}</p>

              <!-- Auth Code Display -->
              <div class="bg-surface p-4 rounded-lg mb-4">
                <p class="text-xs text-ink-subtle uppercase mb-2">{{ t('settings.authCode') }}</p>
                <div class="flex items-center justify-between">
                  <p class="text-2xl font-mono text-hytale-orange font-bold">{{ deviceCodeData.userCode }}</p>
                  <button
                    @click="copyToClipboard(deviceCodeData.userCode || '')"
                    class="btn btn-sm btn-secondary"
                  >
                    <svg class="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    {{ t('settings.copyCode') }}
                  </button>
                </div>
              </div>

              <!-- Actions -->
              <div class="flex gap-2">
                <button
                  @click="openAuthUrl"
                  class="btn btn-primary flex-1"
                >
                  <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  {{ t('settings.openAuthUrl') }}
                </button>

                <button
                  @click="verifyAuth"
                  :disabled="hytaleAuthLoading"
                  class="btn btn-secondary"
                >
                  <svg v-if="hytaleAuthLoading" class="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {{ t('settings.verifyAuth') }}
                </button>

                <button
                  v-if="authStore.hasPermission('hytale_auth.manage')"
                  @click="showResetAuthConfirm = true"
                  class="btn btn-secondary"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>

    <!-- Patchline Settings (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.patchlineTitle')">
      <p class="text-ink-muted text-sm mb-4">{{ t('settings.patchlineDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="patchlineError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ patchlineError }}
      </div>
      <div v-if="patchlineSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ patchlineSuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Setting -->
        <div class="flex items-center justify-between p-4 bg-surface-muted rounded-lg">
          <div>
            <p class="text-sm text-ink-muted">{{ t('settings.currentPatchline') }}</p>
            <p class="text-ink font-medium mt-1 font-mono">
              {{ patchlineData?.patchline || '-' }}
            </p>
          </div>
        </div>

        <!-- Patchline Selection -->
        <div v-if="!patchlineLoading && authStore.hasPermission('settings.edit')" class="flex gap-4">
          <button
            @click="setPatchline('release')"
            :disabled="patchlineLoading"
            :class="[
              'flex-1 flex items-center justify-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
              patchlineData?.patchline === 'release'
                ? 'border-status-success bg-status-success/10'
                : 'border-border hover:border-gray-600'
            ]"
          >
            <div class="text-center">
              <p class="font-medium text-ink">{{ t('config.release') }}</p>
              <p class="text-xs text-ink-muted">{{ t('settings.patchlineReleaseDesc') }}</p>
            </div>
            <svg
              v-if="patchlineData?.patchline === 'release'"
              class="w-5 h-5 text-status-success"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
          </button>

          <button
            @click="setPatchline('pre-release')"
            :disabled="patchlineLoading"
            :class="[
              'flex-1 flex items-center justify-center gap-3 px-4 py-3 rounded-lg border-2 transition-all',
              patchlineData?.patchline === 'pre-release'
                ? 'border-status-warning bg-status-warning/10'
                : 'border-border hover:border-gray-600'
            ]"
          >
            <div class="text-center">
              <p class="font-medium text-ink">{{ t('config.preRelease') }}</p>
              <p class="text-xs text-ink-muted">{{ t('settings.patchlinePreReleaseDesc') }}</p>
            </div>
            <svg
              v-if="patchlineData?.patchline === 'pre-release'"
              class="w-5 h-5 text-status-warning"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
          </button>
        </div>

        <div v-else class="text-center py-4 text-ink-muted">
          {{ t('common.loading') }}...
        </div>

        <!-- Restart Required Banner -->
        <div v-if="patchlineNeedsRestart" class="p-4 bg-status-warning/20 border border-status-warning/30 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-status-warning font-medium">{{ t('settings.patchlineRestartRequired') }}</p>
              <p class="text-sm text-ink-muted mt-1">{{ t('settings.patchlineRestartRequiredDesc') }}</p>
            </div>
            <button
              v-if="authStore.hasPermission('server.restart')"
              @click="restartForPatchline"
              :disabled="patchlineLoading"
              class="px-4 py-2 bg-status-warning text-dark-400 font-medium rounded-lg hover:bg-status-warning/90 transition-colors disabled:opacity-50"
            >
              {{ patchlineLoading ? t('common.loading') : t('dashboard.restart') }}
            </button>
          </div>
        </div>

        <p v-if="!patchlineNeedsRestart" class="text-xs text-ink-subtle">
          {{ t('settings.patchlineRestartNote') }}
        </p>
      </div>
    </Card>

    <!-- Accept Early Plugins Settings (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.acceptEarlyPluginsTitle')">
      <p class="text-ink-muted text-sm mb-4">{{ t('settings.acceptEarlyPluginsDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="acceptEarlyPluginsError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ acceptEarlyPluginsError }}
      </div>
      <div v-if="acceptEarlyPluginsSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ acceptEarlyPluginsSuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Setting -->
        <div class="flex items-center justify-between p-4 bg-surface-muted rounded-lg">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="acceptEarlyPluginsData?.acceptEarlyPlugins ?? false"
                :disabled="acceptEarlyPluginsLoading || !authStore.hasPermission('settings.edit')"
                @change="setAcceptEarlyPlugins(($event.target as HTMLInputElement).checked)"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-surface-overlay peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-hytale-orange peer-disabled:opacity-50 peer-disabled:cursor-not-allowed"></div>
            </label>
            <div>
              <p class="text-ink font-medium">{{ t('settings.acceptEarlyPluginsLabel') }}</p>
              <p class="text-sm text-ink-muted">{{ t('settings.acceptEarlyPluginsHint') }}</p>
            </div>
          </div>
          <div class="text-sm text-ink-muted">
            <span v-if="acceptEarlyPluginsLoading">{{ t('common.loading') }}...</span>
            <span v-else-if="acceptEarlyPluginsData?.acceptEarlyPlugins" class="text-status-success">{{ t('settings.enabled') }}</span>
            <span v-else class="text-ink-subtle">{{ t('settings.disabled') }}</span>
          </div>
        </div>

        <!-- Restart Required Banner -->
        <div v-if="acceptEarlyPluginsNeedsRestart" class="p-4 bg-status-warning/20 border border-status-warning/30 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-status-warning font-medium">{{ t('settings.acceptEarlyPluginsRestartRequired') }}</p>
              <p class="text-sm text-ink-muted mt-1">{{ t('settings.acceptEarlyPluginsRestartRequiredDesc') }}</p>
            </div>
            <button
              v-if="authStore.hasPermission('server.restart')"
              @click="restartForAcceptEarlyPlugins"
              :disabled="acceptEarlyPluginsLoading"
              class="px-4 py-2 bg-status-warning text-dark-400 font-medium rounded-lg hover:bg-status-warning/90 transition-colors disabled:opacity-50"
            >
              {{ acceptEarlyPluginsLoading ? t('common.loading') : t('dashboard.restart') }}
            </button>
          </div>
        </div>

        <p v-if="!acceptEarlyPluginsNeedsRestart" class="text-xs text-ink-subtle">
          {{ t('settings.acceptEarlyPluginsRestartNote') }}
        </p>
      </div>
    </Card>

    <!-- Disable Sentry Settings (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.disableSentryTitle')">
      <p class="text-ink-muted text-sm mb-4">{{ t('settings.disableSentryDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="disableSentryError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ disableSentryError }}
      </div>
      <div v-if="disableSentrySuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ disableSentrySuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Setting -->
        <div class="flex items-center justify-between p-4 bg-surface-muted rounded-lg">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="disableSentryData?.disableSentry ?? false"
                :disabled="disableSentryLoading || !authStore.hasPermission('settings.edit')"
                @change="setDisableSentry(($event.target as HTMLInputElement).checked)"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-surface-overlay peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-hytale-orange peer-disabled:opacity-50 peer-disabled:cursor-not-allowed"></div>
            </label>
            <div>
              <p class="text-ink font-medium">{{ t('settings.disableSentryLabel') }}</p>
              <p class="text-sm text-ink-muted">{{ t('settings.disableSentryHint') }}</p>
            </div>
          </div>
          <div class="text-sm text-ink-muted">
            <span v-if="disableSentryLoading">{{ t('common.loading') }}...</span>
            <span v-else-if="disableSentryData?.disableSentry" class="text-status-warning">{{ t('settings.disabled') }}</span>
            <span v-else class="text-status-success">{{ t('settings.enabled') }}</span>
          </div>
        </div>

        <!-- Restart Required Banner -->
        <div v-if="disableSentryNeedsRestart" class="p-4 bg-status-warning/20 border border-status-warning/30 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-status-warning font-medium">{{ t('settings.disableSentryRestartRequired') }}</p>
              <p class="text-sm text-ink-muted mt-1">{{ t('settings.disableSentryRestartRequiredDesc') }}</p>
            </div>
            <button
              v-if="authStore.hasPermission('server.restart')"
              @click="restartForDisableSentry"
              :disabled="disableSentryLoading"
              class="px-4 py-2 bg-status-warning text-dark-400 font-medium rounded-lg hover:bg-status-warning/90 transition-colors disabled:opacity-50"
            >
              {{ disableSentryLoading ? t('common.loading') : t('dashboard.restart') }}
            </button>
          </div>
        </div>

        <p v-if="!disableSentryNeedsRestart" class="text-xs text-ink-subtle">
          {{ t('settings.disableSentryRestartNote') }}
        </p>
      </div>
    </Card>

    <!-- Allow OP Settings (admins and moderators only) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.allowOpTitle')">
      <p class="text-ink-muted text-sm mb-4">{{ t('settings.allowOpDesc') }}</p>

      <!-- Error/Success Messages -->
      <div v-if="allowOpError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ allowOpError }}
      </div>
      <div v-if="allowOpSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ allowOpSuccess }}
      </div>

      <div class="space-y-4">
        <!-- Current Setting -->
        <div class="flex items-center justify-between p-4 bg-surface-muted rounded-lg">
          <div class="flex items-center gap-3">
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="allowOpData?.allowOp ?? false"
                :disabled="allowOpLoading || !authStore.hasPermission('settings.edit')"
                @change="setAllowOp(($event.target as HTMLInputElement).checked)"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-surface-overlay peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-hytale-orange peer-disabled:opacity-50 peer-disabled:cursor-not-allowed"></div>
            </label>
            <div>
              <p class="text-ink font-medium">{{ t('settings.allowOpLabel') }}</p>
              <p class="text-sm text-ink-muted">{{ t('settings.allowOpHint') }}</p>
            </div>
          </div>
          <div class="text-sm text-ink-muted">
            <span v-if="allowOpLoading">{{ t('common.loading') }}...</span>
            <span v-else-if="allowOpData?.allowOp" class="text-status-success">{{ t('settings.enabled') }}</span>
            <span v-else class="text-ink-subtle">{{ t('settings.disabled') }}</span>
          </div>
        </div>

        <!-- Restart Required Banner -->
        <div v-if="allowOpNeedsRestart" class="p-4 bg-status-warning/20 border border-status-warning/30 rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-status-warning font-medium">{{ t('settings.allowOpRestartRequired') }}</p>
              <p class="text-sm text-ink-muted mt-1">{{ t('settings.allowOpRestartRequiredDesc') }}</p>
            </div>
            <button
              v-if="authStore.hasPermission('server.restart')"
              @click="restartForAllowOp"
              :disabled="allowOpLoading"
              class="px-4 py-2 bg-status-warning text-dark-400 font-medium rounded-lg hover:bg-status-warning/90 transition-colors disabled:opacity-50"
            >
              {{ allowOpLoading ? t('common.loading') : t('dashboard.restart') }}
            </button>
          </div>
        </div>

        <p v-if="!allowOpNeedsRestart" class="text-xs text-ink-subtle">
          {{ t('settings.allowOpRestartNote') }}
        </p>
      </div>
    </Card>

    <!-- JVM / startup tuning (RAM + extra args) -->
    <Card v-if="authStore.canManageServer" :title="t('settings.jvm.title')">
      <div v-if="jvmLoading" class="py-6 text-center text-sm text-ink-muted">{{ t('common.loading') }}</div>
      <div v-else-if="jvmData" class="space-y-5">
        <p class="text-sm text-ink-muted">{{ t('settings.jvm.description') }}</p>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.jvm.minRam') }}</label>
            <input v-model="jvmForm.javaMinRam" type="text" placeholder="3G"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink font-mono" />
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.jvm.maxRam') }}</label>
            <input v-model="jvmForm.javaMaxRam" type="text" placeholder="4G"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink font-mono" />
          </div>
        </div>
        <p class="text-xs text-ink-subtle">{{ t('settings.jvm.ramHint', { min: jvmData.envDefaults.javaMinRam, max: jvmData.envDefaults.javaMaxRam }) }}</p>

        <div class="space-y-1.5">
          <label class="text-sm font-medium text-ink">{{ t('settings.jvm.extraJavaArgs') }}</label>
          <input v-model="jvmForm.extraJavaArgs" type="text" placeholder="-XX:+UseZGC"
                 class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink font-mono" />
          <p class="text-xs text-ink-subtle">{{ t('settings.jvm.extraJavaArgsHint') }}</p>
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium text-ink">{{ t('settings.jvm.extraServerArgs') }}</label>
          <input v-model="jvmForm.extraServerArgs" type="text" placeholder="--some-flag"
                 class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink font-mono" />
          <p class="text-xs text-ink-subtle">{{ t('settings.jvm.extraServerArgsHint') }}</p>
        </div>

        <div v-if="jvmNeedsRestart" class="flex items-center justify-between gap-3 p-3 rounded-lg bg-status-warning/10 border border-status-warning/20">
          <span class="text-sm text-status-warning">{{ t('settings.jvm.restartNote') }}</span>
          <button @click="restartForJvm" :disabled="jvmSaving"
                  class="px-3 py-1.5 bg-status-warning/20 hover:bg-status-warning/30 disabled:opacity-50 text-status-warning text-xs font-medium rounded-lg transition-colors">
            {{ t('settings.jvm.restartNow') }}
          </button>
        </div>

        <div class="flex justify-end">
          <button @click="saveJvm" :disabled="jvmSaving"
                  class="px-4 py-2 bg-hytale-orange hover:bg-hytale-orange/90 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {{ jvmSaving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </Card>

    <!-- Recommended Plugins Info -->
    <Card v-if="authStore.canManageServer" :title="t('settings.recommendedPluginsTitle')">
      <p class="text-ink-muted text-sm mb-4">{{ t('settings.recommendedPluginsDesc') }}</p>

      <div class="space-y-3">
        <div class="p-3 bg-surface-muted rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-ink font-medium">Nitrado:WebServer</p>
              <p class="text-sm text-ink-muted">{{ t('settings.pluginWebServerDesc') }}</p>
            </div>
            <span class="text-xs text-ink-subtle bg-surface px-2 py-1 rounded">Nitrado</span>
          </div>
        </div>

        <div class="p-3 bg-surface-muted rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-ink font-medium">Nitrado:Query</p>
              <p class="text-sm text-ink-muted">{{ t('settings.pluginQueryDesc') }}</p>
            </div>
            <span class="text-xs text-ink-subtle bg-surface px-2 py-1 rounded">Nitrado</span>
          </div>
        </div>

        <div class="p-3 bg-surface-muted rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-ink font-medium">Nitrado:PerformanceSaver</p>
              <p class="text-sm text-ink-muted">{{ t('settings.pluginPerformanceSaverDesc') }}</p>
            </div>
            <span class="text-xs text-ink-subtle bg-surface px-2 py-1 rounded">Nitrado</span>
          </div>
        </div>

        <div class="p-3 bg-surface-muted rounded-lg">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-ink font-medium">ApexHosting:PrometheusExporter</p>
              <p class="text-sm text-ink-muted">{{ t('settings.pluginPrometheusDesc') }}</p>
            </div>
            <span class="text-xs text-ink-subtle bg-surface px-2 py-1 rounded">Apex Hosting</span>
          </div>
        </div>
      </div>

      <p class="text-xs text-ink-subtle mt-4">
        {{ t('settings.recommendedPluginsNote') }}
      </p>
    </Card>

    <!-- Integration API Keys (CurseForge / Modtale / StackMart) -->
    <Card v-if="authStore.hasPermission('settings.view') || authStore.canManageConfig" :title="t('settings.integrations.title')">
      <p class="text-ink-muted text-sm mb-4">{{ t('settings.integrations.desc') }}</p>

      <div v-if="integrationsError" class="mb-4 p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
        {{ integrationsError }}
      </div>
      <div v-if="integrationsSuccess" class="mb-4 p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
        {{ integrationsSuccess }}
      </div>

      <div v-if="integrationsLoading" class="text-center py-6 text-ink-muted">{{ t('common.loading') }}...</div>

      <div v-else class="space-y-6">
        <!-- CurseForge -->
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <label class="text-sm font-medium text-ink">{{ t('settings.integrations.curseforgeKey') }}</label>
            <span class="text-xs" :class="integrations?.curseforge.configured ? 'text-status-success' : 'text-ink-subtle'">
              {{ integrationStatusLabel(integrations?.curseforge) }}
            </span>
          </div>
          <div class="flex gap-2">
            <input
              v-model="integrationsForm.curseforgeApiKey"
              type="password"
              autocomplete="off"
              :disabled="!canEditIntegrations"
              :placeholder="integrations?.curseforge.configured ? t('settings.integrations.placeholderSet') : t('settings.integrations.placeholderEmpty')"
              class="input flex-1"
            />
            <button
              v-if="integrations?.curseforge.source === 'config' && canEditIntegrations"
              @click="clearIntegration('curseforgeApiKey')"
              :disabled="integrationsSaving"
              class="btn btn-secondary btn-sm whitespace-nowrap"
            >
              {{ t('settings.integrations.clear') }}
            </button>
          </div>
          <a href="https://console.curseforge.com/#/api-keys" target="_blank" rel="noopener noreferrer" class="text-xs text-hytale-orange hover:underline inline-block">
            {{ t('settings.integrations.curseforgeGetKey') }} →
          </a>
        </div>

        <!-- CurseForge Game ID -->
        <div class="space-y-2">
          <label class="text-sm font-medium text-ink">{{ t('settings.integrations.curseforgeGameId') }}</label>
          <input
            v-model.number="integrationsForm.curseforgeGameId"
            type="number"
            min="1"
            :disabled="!canEditIntegrations"
            class="input w-40"
          />
          <p class="text-xs text-ink-subtle">{{ t('settings.integrations.curseforgeGameIdHint') }}</p>
        </div>

        <div class="border-t border-border/60"></div>

        <!-- Modtale -->
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <label class="text-sm font-medium text-ink">{{ t('settings.integrations.modtaleKey') }}</label>
            <span class="text-xs" :class="integrations?.modtale.configured ? 'text-status-success' : 'text-ink-subtle'">
              {{ integrationStatusLabel(integrations?.modtale) }}
            </span>
          </div>
          <div class="flex gap-2">
            <input
              v-model="integrationsForm.modtaleApiKey"
              type="password"
              autocomplete="off"
              :disabled="!canEditIntegrations"
              :placeholder="integrations?.modtale.configured ? t('settings.integrations.placeholderSet') : t('settings.integrations.placeholderEmpty')"
              class="input flex-1"
            />
            <button
              v-if="integrations?.modtale.source === 'config' && canEditIntegrations"
              @click="clearIntegration('modtaleApiKey')"
              :disabled="integrationsSaving"
              class="btn btn-secondary btn-sm whitespace-nowrap"
            >
              {{ t('settings.integrations.clear') }}
            </button>
          </div>
        </div>

        <div class="border-t border-border/60"></div>

        <!-- StackMart -->
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <label class="text-sm font-medium text-ink">{{ t('settings.integrations.stackmartKey') }}</label>
            <span class="text-xs" :class="integrations?.stackmart.configured ? 'text-status-success' : 'text-ink-subtle'">
              {{ integrationStatusLabel(integrations?.stackmart) }}
            </span>
          </div>
          <div class="flex gap-2">
            <input
              v-model="integrationsForm.stackmartApiKey"
              type="password"
              autocomplete="off"
              :disabled="!canEditIntegrations"
              :placeholder="integrations?.stackmart.configured ? t('settings.integrations.placeholderSet') : t('settings.integrations.placeholderEmpty')"
              class="input flex-1"
            />
            <button
              v-if="integrations?.stackmart.source === 'config' && canEditIntegrations"
              @click="clearIntegration('stackmartApiKey')"
              :disabled="integrationsSaving"
              class="btn btn-secondary btn-sm whitespace-nowrap"
            >
              {{ t('settings.integrations.clear') }}
            </button>
          </div>
        </div>

        <!-- Save -->
        <div class="flex items-center justify-between pt-2 border-t border-border/60">
          <p class="text-xs text-ink-subtle max-w-md">{{ t('settings.integrations.envNote') }}</p>
          <button
            v-if="canEditIntegrations"
            @click="saveIntegrations"
            :disabled="integrationsSaving"
            class="btn btn-primary"
          >
            <svg v-if="integrationsSaving" class="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </Card>

    <!-- Auto-Moderation (chat filter) -->
    <Card v-if="authStore.hasPermission('settings.view') || authStore.canManageConfig" :title="t('settings.automod.title')">
      <div v-if="automodLoading" class="py-6 text-center text-sm text-ink-muted">{{ t('common.loading') }}</div>
      <div v-else-if="automod" class="space-y-5">
        <p class="text-sm text-ink-muted">{{ t('settings.automod.description') }}</p>

        <!-- Master toggle -->
        <label class="flex items-center justify-between gap-4 cursor-pointer">
          <span class="text-sm font-medium text-ink">{{ t('settings.automod.enabled') }}</span>
          <input type="checkbox" v-model="automod.enabled" :disabled="!canEditIntegrations"
                 class="h-5 w-5 rounded accent-hytale-orange" />
        </label>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5" :class="{ 'opacity-50 pointer-events-none': !automod.enabled }">
          <!-- Action on violation -->
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.automod.action') }}</label>
            <select v-model="automod.action" :disabled="!canEditIntegrations"
                    class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink">
              <option value="warn">{{ t('settings.automod.actionWarn') }}</option>
              <option value="mute">{{ t('settings.automod.actionMute') }}</option>
              <option value="kick">{{ t('settings.automod.actionKick') }}</option>
            </select>
          </div>

          <!-- Mute duration (only relevant for mute) -->
          <div class="space-y-1.5" v-if="automod.action === 'mute'">
            <label class="text-sm font-medium text-ink">{{ t('settings.automod.muteDuration') }}</label>
            <input type="number" min="0" max="86400" v-model.number="automod.muteDurationSec" :disabled="!canEditIntegrations"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
            <p class="text-xs text-ink-subtle">{{ t('settings.automod.muteDurationHint') }}</p>
          </div>
        </div>

        <!-- Banned words -->
        <div class="space-y-1.5" :class="{ 'opacity-50 pointer-events-none': !automod.enabled }">
          <label class="text-sm font-medium text-ink">{{ t('settings.automod.bannedWords') }}</label>
          <textarea v-model="automodBannedWordsText" :disabled="!canEditIntegrations" rows="2"
                    :placeholder="t('settings.automod.bannedWordsPlaceholder')"
                    class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink"></textarea>
          <p class="text-xs text-ink-subtle">{{ t('settings.automod.bannedWordsHint') }}</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5" :class="{ 'opacity-50 pointer-events-none': !automod.enabled }">
          <!-- Block links -->
          <label class="flex items-center justify-between gap-4 cursor-pointer">
            <span class="text-sm font-medium text-ink">{{ t('settings.automod.blockLinks') }}</span>
            <input type="checkbox" v-model="automod.blockLinks" :disabled="!canEditIntegrations"
                   class="h-5 w-5 rounded accent-hytale-orange" />
          </label>

          <!-- Max caps % -->
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.automod.maxCaps') }}</label>
            <input type="number" min="0" max="100" v-model.number="automod.maxCapsPercent" :disabled="!canEditIntegrations"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
            <p class="text-xs text-ink-subtle">{{ t('settings.automod.maxCapsHint') }}</p>
          </div>

          <!-- Max message length -->
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.automod.maxLength') }}</label>
            <input type="number" min="0" max="1000" v-model.number="automod.maxMessageLength" :disabled="!canEditIntegrations"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
            <p class="text-xs text-ink-subtle">{{ t('settings.automod.maxLengthHint') }}</p>
          </div>

          <!-- Flood -->
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.automod.flood') }}</label>
            <div class="flex items-center gap-2">
              <input type="number" min="0" max="50" v-model.number="automod.floodCount" :disabled="!canEditIntegrations"
                     class="w-20 px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
              <span class="text-xs text-ink-subtle">{{ t('settings.automod.floodIn') }}</span>
              <input type="number" min="1" max="300" v-model.number="automod.floodWindowSec" :disabled="!canEditIntegrations"
                     class="w-20 px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
              <span class="text-xs text-ink-subtle">{{ t('settings.automod.floodSeconds') }}</span>
            </div>
            <p class="text-xs text-ink-subtle">{{ t('settings.automod.floodHint') }}</p>
          </div>
        </div>

        <div class="flex justify-end pt-2">
          <button v-if="canEditIntegrations" @click="saveAutoMod" :disabled="automodSaving"
                  class="px-4 py-2 bg-hytale-orange hover:bg-hytale-orange/90 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {{ automodSaving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </Card>

    <!-- Discord Bot (chat bridge) -->
    <Card v-if="authStore.hasPermission('settings.view') || authStore.canManageConfig" :title="t('settings.discord.title')">
      <div v-if="discordLoading" class="py-6 text-center text-sm text-ink-muted">{{ t('common.loading') }}</div>
      <div v-else-if="discord" class="space-y-5">
        <div class="flex items-start justify-between gap-4">
          <p class="text-sm text-ink-muted">{{ t('settings.discord.description') }}</p>
          <span v-if="discord.running" class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-status-success/15 text-status-success text-xs font-medium">
            <span class="w-1.5 h-1.5 rounded-full bg-status-success"></span>{{ t('settings.discord.statusRunning') }}
          </span>
          <span v-else class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-overlay text-ink-muted text-xs font-medium">
            <span class="w-1.5 h-1.5 rounded-full bg-gray-500"></span>{{ t('settings.discord.statusStopped') }}
          </span>
        </div>

        <label class="flex items-center justify-between gap-4 cursor-pointer">
          <span class="text-sm font-medium text-ink">{{ t('settings.discord.enabled') }}</span>
          <input type="checkbox" v-model="discordForm.enabled" :disabled="!canEditIntegrations"
                 class="h-5 w-5 rounded accent-hytale-orange" />
        </label>

        <div class="space-y-1.5">
          <label class="text-sm font-medium text-ink">{{ t('settings.discord.token') }}</label>
          <input type="password" v-model="discordForm.token" :disabled="!canEditIntegrations" autocomplete="off"
                 :placeholder="discord.tokenConfigured ? t('settings.discord.tokenSetPlaceholder', { hint: discord.tokenMasked }) : t('settings.discord.tokenPlaceholder')"
                 class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
          <p class="text-xs text-ink-subtle">{{ t('settings.discord.tokenHint') }}</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.discord.channelId') }}</label>
            <input type="text" v-model="discordForm.channelId" :disabled="!canEditIntegrations" inputmode="numeric"
                   placeholder="123456789012345678"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
            <p class="text-xs text-ink-subtle">{{ t('settings.discord.channelIdHint') }}</p>
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.discord.guildId') }}</label>
            <input type="text" v-model="discordForm.guildId" :disabled="!canEditIntegrations" inputmode="numeric"
                   placeholder="123456789012345678"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
            <p class="text-xs text-ink-subtle">{{ t('settings.discord.guildIdHint') }}</p>
          </div>
        </div>

        <div class="flex justify-end pt-2">
          <button v-if="canEditIntegrations" @click="saveDiscord" :disabled="discordSaving"
                  class="px-4 py-2 bg-hytale-orange hover:bg-hytale-orange/90 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {{ discordSaving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </Card>

    <!-- Off-site Backups (S3-compatible) -->
    <Card v-if="authStore.hasPermission('settings.view') || authStore.canManageConfig" :title="t('settings.offsite.title')">
      <div v-if="offsiteLoading" class="py-6 text-center text-sm text-ink-muted">{{ t('common.loading') }}</div>
      <div v-else-if="offsite" class="space-y-5">
        <p class="text-sm text-ink-muted">{{ t('settings.offsite.description') }}</p>

        <label class="flex items-center justify-between gap-4 cursor-pointer">
          <span class="text-sm font-medium text-ink">{{ t('settings.offsite.enabled') }}</span>
          <input type="checkbox" v-model="offsiteForm.enabled" :disabled="!canEditIntegrations"
                 class="h-5 w-5 rounded accent-hytale-orange" />
        </label>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5" :class="{ 'opacity-50 pointer-events-none': !offsiteForm.enabled }">
          <div class="space-y-1.5 md:col-span-2">
            <label class="text-sm font-medium text-ink">{{ t('settings.offsite.endpoint') }}</label>
            <input type="text" v-model="offsiteForm.endpoint" :disabled="!canEditIntegrations"
                   placeholder="https://s3.us-west-002.backblazeb2.com"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
            <p class="text-xs text-ink-subtle">{{ t('settings.offsite.endpointHint') }}</p>
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.offsite.bucket') }}</label>
            <input type="text" v-model="offsiteForm.bucket" :disabled="!canEditIntegrations" placeholder="my-backups"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.offsite.region') }}</label>
            <input type="text" v-model="offsiteForm.region" :disabled="!canEditIntegrations" placeholder="us-east-1"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
          </div>
          <div class="space-y-1.5 md:col-span-2">
            <label class="text-sm font-medium text-ink">{{ t('settings.offsite.prefix') }}</label>
            <input type="text" v-model="offsiteForm.prefix" :disabled="!canEditIntegrations" placeholder="hytale-backups/"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
            <p class="text-xs text-ink-subtle">{{ t('settings.offsite.prefixHint') }}</p>
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.offsite.accessKeyId') }}</label>
            <input type="text" v-model="offsiteForm.accessKeyId" :disabled="!canEditIntegrations" autocomplete="off"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium text-ink">{{ t('settings.offsite.secretAccessKey') }}</label>
            <input type="password" v-model="offsiteForm.secretAccessKey" :disabled="!canEditIntegrations" autocomplete="off"
                   :placeholder="offsite.secretConfigured ? t('settings.offsite.secretSetPlaceholder', { hint: offsite.secretMasked }) : t('settings.offsite.secretPlaceholder')"
                   class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
          </div>
          <label class="flex items-center justify-between gap-4 cursor-pointer md:col-span-2">
            <span class="text-sm font-medium text-ink">{{ t('settings.offsite.uploadOnBackup') }}</span>
            <input type="checkbox" v-model="offsiteForm.uploadOnBackup" :disabled="!canEditIntegrations"
                   class="h-5 w-5 rounded accent-hytale-orange" />
          </label>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button v-if="canEditIntegrations" @click="testOffsite" :disabled="offsiteTesting || offsiteSaving"
                  class="px-4 py-2 bg-surface-overlay hover:bg-surface-overlay/80 disabled:opacity-50 text-ink text-sm font-medium rounded-lg border border-edge transition-colors">
            {{ offsiteTesting ? t('settings.offsite.testing') : t('settings.offsite.test') }}
          </button>
          <button v-if="canEditIntegrations" @click="saveOffsite" :disabled="offsiteSaving"
                  class="px-4 py-2 bg-hytale-orange hover:bg-hytale-orange/90 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {{ offsiteSaving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </Card>

    <!-- Web Push (PWA notifications) -->
    <Card v-if="authStore.hasPermission('settings.view') || authStore.canManageConfig" :title="t('settings.webpush.title')">
      <div v-if="webpushLoading" class="py-6 text-center text-sm text-ink-muted">{{ t('common.loading') }}</div>
      <div v-else-if="webpush" class="space-y-5">
        <p class="text-sm text-ink-muted">{{ t('settings.webpush.description') }}</p>

        <label class="flex items-center justify-between gap-4 cursor-pointer">
          <span class="text-sm font-medium text-ink">{{ t('settings.webpush.enabled') }}</span>
          <input type="checkbox" v-model="webpushForm.enabled" :disabled="!canEditIntegrations"
                 class="h-5 w-5 rounded accent-hytale-orange" />
        </label>

        <div class="space-y-1.5" :class="{ 'opacity-50 pointer-events-none': !webpushForm.enabled }">
          <label class="text-sm font-medium text-ink">{{ t('settings.webpush.subject') }}</label>
          <input type="text" v-model="webpushForm.subject" :disabled="!canEditIntegrations" placeholder="mailto:admin@example.com"
                 class="w-full px-3 py-2 bg-surface-overlay border border-edge rounded-lg text-sm text-ink" />
          <p class="text-xs text-ink-subtle">{{ t('settings.webpush.subjectHint') }}</p>
        </div>

        <div class="flex justify-end">
          <button v-if="canEditIntegrations" @click="saveWebPush" :disabled="webpushSaving"
                  class="px-4 py-2 bg-hytale-orange hover:bg-hytale-orange/90 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            {{ webpushSaving ? t('common.saving') : t('common.save') }}
          </button>
        </div>

        <!-- This-device subscription -->
        <div class="pt-4 border-t border-edge space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-ink">{{ t('settings.webpush.thisDevice') }}</p>
              <p class="text-xs text-ink-subtle">
                <span v-if="!push.supported.value">{{ t('settings.webpush.unsupported') }}</span>
                <span v-else-if="!webpush.enabled">{{ t('settings.webpush.enableFirst') }}</span>
                <span v-else-if="push.subscribed.value">{{ t('settings.webpush.deviceOn') }}</span>
                <span v-else>{{ t('settings.webpush.deviceOff') }}</span>
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button v-if="webpush.enabled && push.supported.value && !push.subscribed.value"
                      @click="subscribeThisDevice" :disabled="push.busy.value"
                      class="px-3 py-1.5 bg-hytale-orange hover:bg-hytale-orange/90 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
                {{ t('settings.webpush.subscribe') }}
              </button>
              <template v-if="push.subscribed.value">
                <button @click="testWebPush" :disabled="push.busy.value"
                        class="px-3 py-1.5 bg-surface-overlay hover:bg-surface-overlay/80 disabled:opacity-50 text-ink text-xs font-medium rounded-lg border border-edge transition-colors">
                  {{ t('settings.webpush.test') }}
                </button>
                <button @click="unsubscribeThisDevice" :disabled="push.busy.value"
                        class="px-3 py-1.5 bg-status-error/15 hover:bg-status-error/25 disabled:opacity-50 text-status-error text-xs font-medium rounded-lg transition-colors">
                  {{ t('settings.webpush.unsubscribe') }}
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </Card>

    <!-- Server Configuration (only for users with permission) -->
    <Card v-if="authStore.canManageConfig" :title="t('settings.serverConfig')">
      <div class="space-y-4">
        <!-- Error/Success Messages -->
        <div v-if="error" class="p-3 bg-status-error/20 border border-status-error/30 rounded-lg text-status-error text-sm">
          {{ error }}
        </div>
        <div v-if="successMessage" class="p-3 bg-status-success/20 border border-status-success/30 rounded-lg text-status-success text-sm">
          {{ successMessage }}
        </div>

        <!-- File List -->
        <div v-if="!selectedFile">
          <p class="text-ink-muted text-sm mb-3">{{ t('settings.selectConfigFile') }}</p>

          <div v-if="loading" class="text-center py-4 text-ink-muted">
            {{ t('common.loading') }}...
          </div>

          <div v-else-if="configFiles.length === 0" class="text-center py-4 text-ink-subtle">
            {{ t('settings.noConfigFiles') }}
          </div>

          <div v-else class="space-y-2">
            <button
              v-for="file in configFiles"
              :key="file.name"
              @click="selectFile(file.name)"
              class="w-full flex items-center justify-between p-3 bg-surface-muted hover:bg-surface-overlay rounded-lg transition-colors"
            >
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span class="text-ink font-mono text-sm">{{ file.name }}</span>
              </div>
              <span class="text-ink-subtle text-xs">{{ Math.round(file.size / 1024) }} KB</span>
            </button>
          </div>

          <button
            @click="loadConfigFiles"
            class="mt-4 text-sm text-ink-muted hover:text-ink flex items-center gap-1"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {{ t('common.refresh') }}
          </button>
        </div>

        <!-- File Editor -->
        <div v-else>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <button
                @click="closeEditor"
                class="text-ink-muted hover:text-ink"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </button>
              <span class="text-ink font-mono">{{ selectedFile }}</span>
              <span v-if="hasChanges" class="text-status-warning text-xs">({{ t('settings.unsavedChanges') }})</span>
            </div>
            <button
              v-if="authStore.hasPermission('settings.edit')"
              @click="saveFile"
              :disabled="saving || !hasChanges"
              :class="[
                'btn btn-sm',
                hasChanges ? 'btn-primary' : 'btn-secondary opacity-50 cursor-not-allowed'
              ]"
            >
              <svg v-if="saving" class="w-4 h-4 mr-1 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ t('common.save') }}
            </button>
          </div>

          <textarea
            v-model="fileContent"
            class="w-full h-96 bg-surface text-ink-muted font-mono text-sm p-4 rounded-lg border border-border focus:border-hytale-orange focus:outline-none resize-y"
            spellcheck="false"
          ></textarea>

          <p class="text-ink-subtle text-xs mt-2">
            {{ t('settings.configWarning') }}
          </p>
        </div>
      </div>
    </Card>

    <!-- About -->
    <Card :title="t('settings.about')">
      <div class="space-y-4">
        <div class="flex items-center gap-4">
          <div class="w-16 h-16 bg-gradient-to-br from-hytale-orange to-hytale-yellow rounded-2xl flex items-center justify-center">
            <span class="text-dark font-bold text-3xl">H</span>
          </div>
          <div>
            <h3 class="text-xl font-bold text-ink">Hytale Server Manager</h3>
            <p class="text-ink-muted">{{ t('settings.version') }}: 2.1.0</p>
          </div>
        </div>

        <div class="pt-4 border-t border-border">
          <p class="text-ink-muted text-sm">
            {{ t('settings.aboutDescription') }}
          </p>
        </div>

        <div class="pt-4 border-t border-border">
          <div class="flex gap-4">
            <div class="flex-1">
              <p class="text-sm text-ink-subtle mb-1">Backend</p>
              <p class="text-ink">Node.js + Express</p>
            </div>
            <div class="flex-1">
              <p class="text-sm text-ink-subtle mb-1">Frontend</p>
              <p class="text-ink">Vue.js 3 + Tailwind CSS</p>
            </div>
          </div>
        </div>
      </div>
    </Card>

    <!-- Confirm Reset Auth -->
    <ConfirmDialog
      :show="showResetAuthConfirm"
      :title="t('settings.resetAuthTitle')"
      :message="t('settings.confirmResetAuth')"
      :confirm-text="t('settings.resetAuth')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="resetHytaleAuth(); showResetAuthConfirm = false"
      @cancel="showResetAuthConfirm = false"
    />
  </div>
</template>
