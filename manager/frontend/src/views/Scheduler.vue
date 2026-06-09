<script setup lang="ts">
import { ref, onMounted, reactive, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import Modal from '@/components/ui/Modal.vue'
import { useAuthStore } from '@/stores/auth'
import { schedulerApi, type ScheduleConfig, type QuickCommand, type ScheduledCommand, type SchedulerStatus } from '@/api/scheduler'
import { useToast } from '@/composables/useToast'

const { t } = useI18n()
const authStore = useAuthStore()

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

const status = ref<SchedulerStatus | null>(null)
const config = reactive<ScheduleConfig>({
  backups: {
    enabled: false,
    schedule: '03:00',
    retentionDays: 7,
    beforeRestart: true,
  },
  announcements: {
    enabled: false,
    welcome: '',
    scheduled: [],
  },
  scheduledRestarts: {
    enabled: false,
    times: [],
    warningMinutes: [30, 15, 5, 1],
    warningMessage: 'Server restart in {minutes} minute(s)!',
    restartMessage: 'Server is restarting now!',
    createBackup: true,
  },
  quickCommands: [],
  scheduledCommands: [],
})

const { addToast: showToast } = useToast()

// New restart time input
const newRestartTime = ref('03:00')
const cancellingRestart = ref(false)

// Scheduled command form
const showScheduledForm = ref(false)
const editingScheduled = ref<ScheduledCommand | null>(null)
const scheduledForm = reactive<{ name: string; command: string; mode: 'daily' | 'interval'; times: string[]; intervalMinutes: number; enabled: boolean }>({
  name: '',
  command: '',
  mode: 'daily',
  times: ['03:00'],
  intervalMinutes: 60,
  enabled: true,
})
const scheduledTimeInput = ref('03:00')
const savingScheduled = ref(false)

// Quick command form
const showCommandForm = ref(false)
const editingCommand = ref<QuickCommand | null>(null)
const commandForm = reactive({
  name: '',
  command: '',
  icon: 'terminal',
  category: 'custom',
})

// Broadcast
const broadcastMessage = ref('')
const broadcasting = ref(false)

// New announcement form
const newAnnouncement = reactive({
  message: '',
  intervalMinutes: 30,
})

async function loadData() {
  try {
    loading.value = true
    error.value = null
    const [configData, statusData] = await Promise.all([
      schedulerApi.getConfig(),
      schedulerApi.getStatus(),
    ])
    Object.assign(config, configData)
    status.value = statusData
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function saveBackupConfig() {
  try {
    saving.value = true
    error.value = null
    await schedulerApi.saveConfig({ backups: config.backups })
    successMessage.value = t('scheduler.saved')
    setTimeout(() => { successMessage.value = null }, 3000)
    // Reload status
    status.value = await schedulerApi.getStatus()
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    saving.value = false
  }
}

async function saveAnnouncementsConfig() {
  try {
    saving.value = true
    error.value = null
    await schedulerApi.saveConfig({ announcements: config.announcements })
    successMessage.value = t('scheduler.saved')
    setTimeout(() => { successMessage.value = null }, 3000)
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    saving.value = false
  }
}

// Scheduled Restarts
function addRestartTime() {
  if (!newRestartTime.value || config.scheduledRestarts.times.includes(newRestartTime.value)) return
  config.scheduledRestarts.times.push(newRestartTime.value)
  config.scheduledRestarts.times.sort()
}

function removeRestartTime(time: string) {
  config.scheduledRestarts.times = config.scheduledRestarts.times.filter(entry => entry !== time)
}

async function saveRestartsConfig() {
  try {
    saving.value = true
    error.value = null
    await schedulerApi.saveConfig({ scheduledRestarts: config.scheduledRestarts })
    successMessage.value = t('scheduler.saved')
    setTimeout(() => { successMessage.value = null }, 3000)
    // Reload status
    status.value = await schedulerApi.getStatus()
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    saving.value = false
  }
}

async function cancelPendingRestart() {
  try {
    cancellingRestart.value = true
    error.value = null
    await schedulerApi.cancelRestart()
    successMessage.value = t('scheduler.restartCancelled')
    setTimeout(() => { successMessage.value = null }, 3000)
    // Reload status
    status.value = await schedulerApi.getStatus()
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    cancellingRestart.value = false
  }
}

function addAnnouncement() {
  if (!newAnnouncement.message) return

  config.announcements.scheduled.push({
    id: Date.now().toString(),
    message: newAnnouncement.message,
    intervalMinutes: newAnnouncement.intervalMinutes,
    enabled: true,
  })

  newAnnouncement.message = ''
  newAnnouncement.intervalMinutes = 30
}

function removeAnnouncement(id: string) {
  config.announcements.scheduled = config.announcements.scheduled.filter(a => a.id !== id)
}

async function sendBroadcast() {
  if (!broadcastMessage.value) return

  try {
    broadcasting.value = true
    await schedulerApi.broadcast(broadcastMessage.value)
    broadcastMessage.value = ''
    successMessage.value = t('scheduler.broadcastSent')
    setTimeout(() => { successMessage.value = null }, 3000)
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    broadcasting.value = false
  }
}

// Quick Commands
function openCommandForm(command?: QuickCommand) {
  if (command) {
    editingCommand.value = command
    commandForm.name = command.name
    commandForm.command = command.command
    commandForm.icon = command.icon
    commandForm.category = command.category
  } else {
    editingCommand.value = null
    commandForm.name = ''
    commandForm.command = ''
    commandForm.icon = 'terminal'
    commandForm.category = 'custom'
  }
  showCommandForm.value = true
}

async function saveCommand() {
  if (!commandForm.name || !commandForm.command) return

  try {
    saving.value = true
    if (editingCommand.value) {
      await schedulerApi.updateQuickCommand(editingCommand.value.id, commandForm)
    } else {
      const newCmd = await schedulerApi.addQuickCommand(commandForm)
      config.quickCommands.push(newCmd)
    }
    showCommandForm.value = false
    await loadData()
  } catch (e) {
    error.value = t('errors.serverError')
  } finally {
    saving.value = false
  }
}

async function deleteCommand(id: string) {
  try {
    await schedulerApi.deleteQuickCommand(id)
    config.quickCommands = config.quickCommands.filter(c => c.id !== id)
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function executeCommand(id: string) {
  try {
    const result = await schedulerApi.executeQuickCommand(id)
    if (result.success) {
      successMessage.value = t('scheduler.commandExecuted')
      setTimeout(() => { successMessage.value = null }, 3000)
    }
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

// Handler for quick command click - checks permission before executing
function handleCommandClick(id: string) {
  if (authStore.hasPermission('scheduler.edit')) {
    executeCommand(id)
  }
}

const commandsByCategory = computed(() => {
  const grouped: Record<string, QuickCommand[]> = {}
  for (const cmd of config.quickCommands) {
    if (!grouped[cmd.category]) {
      grouped[cmd.category] = []
    }
    grouped[cmd.category].push(cmd)
  }
  return grouped
})

// ===== Scheduled commands =====
function scheduledStatusFor(id: string) {
  return status.value?.scheduledCommands?.find(s => s.id === id) ?? null
}

function openScheduledForm(cmd?: ScheduledCommand) {
  if (cmd) {
    editingScheduled.value = cmd
    scheduledForm.name = cmd.name
    scheduledForm.command = cmd.command
    scheduledForm.mode = cmd.mode
    scheduledForm.times = [...(cmd.times ?? [])]
    scheduledForm.intervalMinutes = cmd.intervalMinutes || 60
    scheduledForm.enabled = cmd.enabled
  } else {
    editingScheduled.value = null
    scheduledForm.name = ''
    scheduledForm.command = ''
    scheduledForm.mode = 'daily'
    scheduledForm.times = ['03:00']
    scheduledForm.intervalMinutes = 60
    scheduledForm.enabled = true
  }
  scheduledTimeInput.value = '03:00'
  showScheduledForm.value = true
}

function addScheduledTime() {
  const v = scheduledTimeInput.value
  if (/^\d{2}:\d{2}$/.test(v) && !scheduledForm.times.includes(v)) {
    scheduledForm.times.push(v)
    scheduledForm.times.sort()
  }
}

function removeScheduledTime(time: string) {
  scheduledForm.times = scheduledForm.times.filter(t => t !== time)
}

async function persistScheduledCommands() {
  await schedulerApi.saveConfig({ scheduledCommands: config.scheduledCommands })
  await loadData()
}

async function saveScheduledCommand() {
  if (!scheduledForm.name.trim() || !scheduledForm.command.trim()) return
  if (!scheduledForm.command.trim().startsWith('/')) {
    showToast(t('scheduler.commandMustStartWithSlash'), 'error')
    return
  }
  if (scheduledForm.mode === 'daily' && scheduledForm.times.length === 0) {
    showToast(t('scheduler.needAtLeastOneTime'), 'error')
    return
  }
  try {
    savingScheduled.value = true
    const entry: ScheduledCommand = {
      id: editingScheduled.value?.id ?? `sc-${Date.now()}`,
      name: scheduledForm.name.trim(),
      command: scheduledForm.command.trim(),
      mode: scheduledForm.mode,
      times: scheduledForm.mode === 'daily' ? [...scheduledForm.times] : [],
      intervalMinutes: scheduledForm.mode === 'interval' ? Number(scheduledForm.intervalMinutes) : 0,
      enabled: scheduledForm.enabled,
    }
    if (editingScheduled.value) {
      const idx = config.scheduledCommands.findIndex(c => c.id === editingScheduled.value!.id)
      if (idx !== -1) config.scheduledCommands[idx] = entry
    } else {
      config.scheduledCommands.push(entry)
    }
    await persistScheduledCommands()
    showScheduledForm.value = false
    showToast(t('common.success'), 'success')
  } catch (e: any) {
    showToast(e?.response?.data?.error || t('errors.serverError'), 'error')
  } finally {
    savingScheduled.value = false
  }
}

async function toggleScheduledCommand(cmd: ScheduledCommand) {
  cmd.enabled = !cmd.enabled
  try {
    await persistScheduledCommands()
  } catch {
    cmd.enabled = !cmd.enabled
    showToast(t('errors.serverError'), 'error')
  }
}

async function deleteScheduledCommand(id: string) {
  config.scheduledCommands = config.scheduledCommands.filter(c => c.id !== id)
  try {
    await persistScheduledCommands()
  } catch {
    showToast(t('errors.serverError'), 'error')
  }
}

async function runScheduledCommandNow(id: string) {
  try {
    const r = await schedulerApi.runScheduledCommand(id)
    if (r.success) {
      showToast(t('scheduler.commandExecuted'), 'success')
      setTimeout(loadData, 500)
    } else {
      showToast(r.error || t('errors.serverError'), 'error')
    }
  } catch (e: any) {
    showToast(e?.response?.data?.error || t('errors.serverError'), 'error')
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso).getTime()
  const diff = d - Date.now()
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60000)
  if (mins < 60) return diff >= 0 ? t('scheduler.inMinutes', { n: mins }) : t('scheduler.minutesAgo', { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return diff >= 0 ? t('scheduler.inHours', { n: hours }) : t('scheduler.hoursAgo', { n: hours })
  return new Date(iso).toLocaleString()
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('scheduler.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('scheduler.subtitle') }}</p>
      </div>
    </div>

    <!-- Messages -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>
    <div v-if="successMessage" class="p-4 bg-status-success/10 border border-status-success/20 rounded-lg">
      <p class="text-status-success">{{ successMessage }}</p>
    </div>

    <div v-if="loading" class="text-center py-12 text-ink-muted">
      {{ t('common.loading') }}
    </div>

    <template v-else>
      <!-- Automatic Backups -->
      <Card :title="t('scheduler.autoBackups')">
        <div class="space-y-4">
          <!-- Enable Toggle -->
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-ink">{{ t('scheduler.enableAutoBackups') }}</p>
              <p class="text-sm text-ink-muted">{{ t('scheduler.autoBackupsDesc') }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="config.backups.enabled" class="sr-only peer">
              <div class="w-11 h-6 bg-surface-overlay rounded-full peer peer-checked:bg-hytale-orange peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
          </div>

          <div v-if="config.backups.enabled" class="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-border">
            <!-- Schedule Time -->
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.backupTime') }}</label>
              <input
                v-model="config.backups.schedule"
                type="time"
                class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
              />
            </div>

            <!-- Retention -->
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.retentionDays') }}</label>
              <input
                v-model.number="config.backups.retentionDays"
                type="number"
                min="1"
                max="365"
                class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
              />
            </div>

            <!-- Before Restart -->
            <div class="flex items-center">
              <label class="flex items-center cursor-pointer">
                <input type="checkbox" v-model="config.backups.beforeRestart" class="sr-only peer">
                <div class="w-5 h-5 bg-surface-overlay rounded peer peer-checked:bg-hytale-orange flex items-center justify-center">
                  <svg v-if="config.backups.beforeRestart" class="w-3 h-3 text-dark" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <span class="ml-2 text-sm text-ink-muted">{{ t('scheduler.beforeRestart') }}</span>
              </label>
            </div>
          </div>

          <!-- Status -->
          <div v-if="status?.backups" class="pt-4 border-t border-border text-sm text-ink-muted">
            <p v-if="status.backups.nextRun">{{ t('scheduler.nextBackup') }}: {{ new Date(status.backups.nextRun).toLocaleString() }}</p>
            <p v-if="status.backups.lastRun">{{ t('scheduler.lastBackup') }}: {{ new Date(status.backups.lastRun).toLocaleString() }}</p>
          </div>

          <!-- Save -->
          <div v-if="authStore.hasPermission('scheduler.edit')" class="pt-4 border-t border-border flex justify-end">
            <button
              @click="saveBackupConfig"
              :disabled="saving"
              class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50"
            >
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- Scheduled Restarts -->
      <Card :title="t('scheduler.scheduledRestarts')">
        <div class="space-y-4">
          <!-- Enable Toggle -->
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-ink">{{ t('scheduler.enableRestarts') }}</p>
              <p class="text-sm text-ink-muted">{{ t('scheduler.restartsDesc') }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="config.scheduledRestarts.enabled" class="sr-only peer">
              <div class="w-11 h-6 bg-surface-overlay rounded-full peer peer-checked:bg-hytale-orange peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
          </div>

          <div v-if="config.scheduledRestarts.enabled" class="space-y-4 pt-4 border-t border-border">
            <!-- Restart Times List -->
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.restartTimes') }}</label>
              <div v-if="config.scheduledRestarts.times.length > 0" class="flex flex-wrap gap-2 mb-3">
                <div
                  v-for="time in config.scheduledRestarts.times"
                  :key="time"
                  class="flex items-center gap-2 px-3 py-1.5 bg-surface rounded-lg"
                >
                  <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span class="text-ink font-mono">{{ time }}</span>
                  <button
                    v-if="authStore.hasPermission('scheduler.edit')"
                    @click="removeRestartTime(time)"
                    class="text-ink-muted hover:text-red-400 transition-colors"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <p v-else class="text-sm text-ink-subtle mb-3">{{ t('scheduler.noRestartTimes') }}</p>

              <!-- Add Time -->
              <div v-if="authStore.hasPermission('scheduler.edit')" class="flex gap-3">
                <input
                  v-model="newRestartTime"
                  type="time"
                  class="bg-surface text-ink px-4 py-2 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
                />
                <button
                  @click="addRestartTime"
                  class="px-4 py-2 bg-surface-overlay text-ink rounded-lg hover:bg-surface-overlay transition-colors"
                >
                  {{ t('common.add') }}
                </button>
              </div>
            </div>

            <!-- Warning Minutes -->
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.warningMinutes') }}</label>
              <input
                v-model="config.scheduledRestarts.warningMinutes"
                type="text"
                :placeholder="t('scheduler.warningMinutesPlaceholder')"
                class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none font-mono"
                @change="config.scheduledRestarts.warningMinutes = ($event.target as HTMLInputElement).value.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n))"
              />
              <p class="text-xs text-ink-subtle mt-1">{{ t('scheduler.warningMinutesHint') }}</p>
            </div>

            <!-- Warning Message -->
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.warningMessage') }}</label>
              <input
                v-model="config.scheduledRestarts.warningMessage"
                type="text"
                :placeholder="t('scheduler.warningMessagePlaceholder')"
                class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
              />
              <p class="text-xs text-ink-subtle mt-1">{{ t('scheduler.warningMessageHint') }}</p>
            </div>

            <!-- Restart Message -->
            <div>
              <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.restartMessage') }}</label>
              <input
                v-model="config.scheduledRestarts.restartMessage"
                type="text"
                :placeholder="t('scheduler.restartMessagePlaceholder')"
                class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
              />
            </div>

            <!-- Backup before Restart -->
            <div class="flex items-center">
              <label class="flex items-center cursor-pointer">
                <input type="checkbox" v-model="config.scheduledRestarts.createBackup" class="sr-only peer">
                <div class="w-5 h-5 bg-surface-overlay rounded peer peer-checked:bg-hytale-orange flex items-center justify-center">
                  <svg v-if="config.scheduledRestarts.createBackup" class="w-3 h-3 text-dark" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <span class="ml-2 text-sm text-ink-muted">{{ t('scheduler.backupBeforeRestart') }}</span>
              </label>
            </div>
          </div>

          <!-- Status -->
          <div v-if="status?.scheduledRestarts" class="pt-4 border-t border-border">
            <div class="text-sm text-ink-muted space-y-1">
              <p v-if="status.scheduledRestarts.nextRestart">
                {{ t('scheduler.nextRestart') }}: {{ new Date(status.scheduledRestarts.nextRestart).toLocaleString() }}
              </p>
              <div v-if="status.scheduledRestarts.pendingRestart" class="flex items-center gap-3 mt-2 p-3 bg-status-warning/10 border border-status-warning/20 rounded-lg">
                <svg class="w-5 h-5 text-status-warning flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div class="flex-1">
                  <p class="text-status-warning font-medium">{{ t('scheduler.pendingRestart') }}</p>
                  <p class="text-ink-muted text-xs">{{ new Date(status.scheduledRestarts.pendingRestart.scheduledAt).toLocaleString() }}</p>
                </div>
                <button
                  v-if="authStore.hasPermission('scheduler.edit')"
                  @click="cancelPendingRestart"
                  :disabled="cancellingRestart"
                  class="px-3 py-1.5 bg-status-error text-white rounded-lg text-sm font-medium hover:bg-status-error/80 transition-colors disabled:opacity-50"
                >
                  {{ t('scheduler.cancelRestart') }}
                </button>
              </div>
            </div>
          </div>

          <!-- Save -->
          <div v-if="authStore.hasPermission('scheduler.edit')" class="pt-4 border-t border-border flex justify-end">
            <button
              @click="saveRestartsConfig"
              :disabled="saving"
              class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50"
            >
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- Broadcast -->
      <Card v-if="authStore.hasPermission('scheduler.edit')" :title="t('scheduler.broadcast')">
        <div class="space-y-4">
          <p class="text-sm text-ink-muted">{{ t('scheduler.broadcastDesc') }}</p>
          <div class="flex gap-3">
            <input
              v-model="broadcastMessage"
              type="text"
              :placeholder="t('scheduler.broadcastPlaceholder')"
              class="flex-1 bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
              @keyup.enter="sendBroadcast"
            />
            <button
              @click="sendBroadcast"
              :disabled="!broadcastMessage || broadcasting"
              class="px-6 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50"
            >
              {{ t('scheduler.send') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- Scheduled Announcements -->
      <Card :title="t('scheduler.scheduledAnnouncements')">
        <div class="space-y-4">
          <!-- Enable Toggle -->
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-ink">{{ t('scheduler.enableAnnouncements') }}</p>
              <p class="text-sm text-ink-muted">{{ t('scheduler.announcementsDesc') }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="config.announcements.enabled" class="sr-only peer">
              <div class="w-11 h-6 bg-surface-overlay rounded-full peer peer-checked:bg-hytale-orange peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
          </div>

          <!-- Welcome Message -->
          <div v-if="config.announcements.enabled">
            <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.welcomeMessage') }}</label>
            <input
              v-model="config.announcements.welcome"
              type="text"
              :placeholder="t('scheduler.welcomePlaceholder')"
              class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
            />
            <p class="text-xs text-ink-subtle mt-1">{{ t('scheduler.welcomeHint') }}</p>
          </div>

          <!-- Scheduled List -->
          <div v-if="config.announcements.enabled && config.announcements.scheduled.length > 0" class="space-y-2">
            <div
              v-for="ann in config.announcements.scheduled"
              :key="ann.id"
              class="flex items-center gap-3 p-3 bg-surface rounded-lg"
            >
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="ann.enabled" class="sr-only peer">
                <div class="w-9 h-5 bg-surface-overlay rounded-full peer peer-checked:bg-hytale-orange peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
              </label>
              <div class="flex-1">
                <p class="text-ink text-sm">{{ ann.message }}</p>
                <p class="text-xs text-ink-subtle">{{ t('scheduler.every') }} {{ ann.intervalMinutes }} {{ t('scheduler.minutes') }}</p>
              </div>
              <button
                v-if="authStore.hasPermission('scheduler.edit')"
                @click="removeAnnouncement(ann.id)"
                class="p-1 text-ink-muted hover:text-red-400 transition-colors"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Add Announcement -->
          <div v-if="config.announcements.enabled && authStore.hasPermission('scheduler.edit')" class="flex gap-3 pt-4 border-t border-border">
            <input
              v-model="newAnnouncement.message"
              type="text"
              :placeholder="t('scheduler.announcementPlaceholder')"
              class="flex-1 bg-surface text-ink px-4 py-2 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
            />
            <input
              v-model.number="newAnnouncement.intervalMinutes"
              type="number"
              min="1"
              class="w-24 bg-surface text-ink px-3 py-2 rounded-lg border border-border focus:border-hytale-orange focus:outline-none text-center"
            />
            <button
              @click="addAnnouncement"
              class="px-4 py-2 bg-surface-overlay text-ink rounded-lg hover:bg-surface-overlay transition-colors"
            >
              {{ t('common.add') }}
            </button>
          </div>

          <!-- Save -->
          <div v-if="authStore.hasPermission('scheduler.edit')" class="pt-4 border-t border-border flex justify-end">
            <button
              @click="saveAnnouncementsConfig"
              :disabled="saving"
              class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50"
            >
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </Card>

      <!-- Quick Commands -->
      <Card :title="t('scheduler.quickCommands')">
        <template v-if="authStore.hasPermission('scheduler.edit')" #actions>
          <button
            @click="openCommandForm()"
            class="flex items-center gap-2 px-3 py-1.5 bg-hytale-orange text-dark rounded-lg text-sm font-medium hover:bg-hytale-yellow transition-colors"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            {{ t('scheduler.addCommand') }}
          </button>
        </template>

        <div class="space-y-4">
          <p class="text-sm text-ink-muted">{{ t('scheduler.quickCommandsDesc') }}</p>

          <div v-for="(commands, category) in commandsByCategory" :key="category" class="space-y-2">
            <h4 class="text-sm font-medium text-ink-muted uppercase tracking-wider">{{ t('scheduler.categories.' + category) || category }}</h4>
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              <div
                v-for="cmd in commands"
                :key="cmd.id"
                class="group relative flex items-center gap-3 p-3 bg-surface rounded-lg hover:bg-surface-overlay transition-colors"
                :class="{ 'cursor-pointer': authStore.hasPermission('scheduler.edit') }"
                @click="handleCommandClick(cmd.id)"
              >
                <div class="w-8 h-8 bg-surface-overlay rounded-lg flex items-center justify-center">
                  <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-ink truncate">{{ cmd.name }}</p>
                  <p class="text-xs text-ink-subtle font-mono truncate">{{ cmd.command }}</p>
                </div>
                <div v-if="authStore.hasPermission('scheduler.edit')" class="absolute top-1 right-1 hidden group-hover:flex gap-1">
                  <button
                    @click.stop="openCommandForm(cmd)"
                    class="p-1 text-ink-muted hover:text-ink bg-surface-overlay rounded"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  <button
                    @click.stop="deleteCommand(cmd.id)"
                    class="p-1 text-ink-muted hover:text-red-400 bg-surface-overlay rounded"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <!-- Scheduled Commands -->
      <Card :title="t('scheduler.scheduledCommands')">
        <template v-if="authStore.hasPermission('scheduler.edit')" #actions>
          <button
            @click="openScheduledForm()"
            class="flex items-center gap-2 px-3 py-1.5 bg-hytale-orange text-dark rounded-lg text-sm font-medium hover:bg-hytale-yellow transition-colors"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            {{ t('scheduler.addScheduledCommand') }}
          </button>
        </template>

        <div class="space-y-3">
          <p class="text-sm text-ink-muted">{{ t('scheduler.scheduledCommandsDesc') }}</p>

          <div v-if="config.scheduledCommands.length === 0" class="text-sm text-ink-subtle py-4 text-center">
            {{ t('scheduler.noScheduledCommands') }}
          </div>

          <div
            v-for="cmd in config.scheduledCommands"
            :key="cmd.id"
            class="flex items-center gap-3 p-3 bg-surface rounded-lg"
          >
            <button
              @click="toggleScheduledCommand(cmd)"
              :disabled="!authStore.hasPermission('scheduler.edit')"
              class="shrink-0 w-10 h-6 rounded-full transition-colors relative"
              :class="cmd.enabled ? 'bg-hytale-orange' : 'bg-surface-overlay'"
              :title="cmd.enabled ? t('common.enabled') : t('common.disabled')"
            >
              <span class="absolute top-1 w-4 h-4 bg-white rounded-full transition-all" :class="cmd.enabled ? 'left-5' : 'left-1'"></span>
            </button>

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium text-ink truncate">{{ cmd.name }}</p>
                <span class="text-xs px-1.5 py-0.5 rounded bg-surface-overlay text-ink-subtle">
                  {{ cmd.mode === 'daily' ? cmd.times.join(', ') : t('scheduler.everyNMinutes', { n: cmd.intervalMinutes }) }}
                </span>
              </div>
              <p class="text-xs text-ink-subtle font-mono truncate">{{ cmd.command }}</p>
              <p v-if="scheduledStatusFor(cmd.id) && cmd.enabled" class="text-xs text-ink-subtle mt-0.5">
                {{ t('scheduler.nextRun') }}: {{ formatRelative(scheduledStatusFor(cmd.id)!.nextRun) }}
                <span v-if="scheduledStatusFor(cmd.id)!.lastRun"> · {{ t('scheduler.lastRun') }}: {{ formatRelative(scheduledStatusFor(cmd.id)!.lastRun) }}</span>
              </p>
            </div>

            <div v-if="authStore.hasPermission('scheduler.edit')" class="flex gap-1 shrink-0">
              <button
                @click="runScheduledCommandNow(cmd.id)"
                class="p-1.5 text-ink-muted hover:text-hytale-orange bg-surface-overlay rounded"
                :title="t('scheduler.runNow')"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              <button
                @click="openScheduledForm(cmd)"
                class="p-1.5 text-ink-muted hover:text-ink bg-surface-overlay rounded"
                :title="t('common.edit')"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
              <button
                @click="deleteScheduledCommand(cmd.id)"
                class="p-1.5 text-ink-muted hover:text-red-400 bg-surface-overlay rounded"
                :title="t('common.delete')"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </Card>
    </template>

    <!-- Scheduled Command Form Modal -->
    <Modal
      :open="showScheduledForm"
      :title="editingScheduled ? t('scheduler.editScheduledCommand') : t('scheduler.addScheduledCommand')"
      @close="showScheduledForm = false"
    >
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.commandName') }}</label>
          <input
            v-model="scheduledForm.name"
            type="text"
            class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.command') }}</label>
          <input
            v-model="scheduledForm.command"
            type="text"
            placeholder="/save"
            class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none font-mono"
          />
          <p class="text-xs text-ink-subtle mt-1">{{ t('scheduler.commandWhitelistHint') }}</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.scheduleMode') }}</label>
          <div class="flex gap-2">
            <button
              type="button"
              @click="scheduledForm.mode = 'daily'"
              class="flex-1 px-4 py-2 rounded-lg border transition-colors"
              :class="scheduledForm.mode === 'daily' ? 'border-hytale-orange bg-hytale-orange/10 text-ink' : 'border-border text-ink-muted'"
            >{{ t('scheduler.modeDaily') }}</button>
            <button
              type="button"
              @click="scheduledForm.mode = 'interval'"
              class="flex-1 px-4 py-2 rounded-lg border transition-colors"
              :class="scheduledForm.mode === 'interval' ? 'border-hytale-orange bg-hytale-orange/10 text-ink' : 'border-border text-ink-muted'"
            >{{ t('scheduler.modeInterval') }}</button>
          </div>
        </div>

        <div v-if="scheduledForm.mode === 'daily'">
          <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.times') }}</label>
          <div class="flex gap-2 mb-2">
            <input
              v-model="scheduledTimeInput"
              type="time"
              class="flex-1 bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
            />
            <button @click="addScheduledTime" class="px-4 py-2 bg-surface-overlay text-ink rounded-lg hover:bg-border transition-colors">
              {{ t('common.add') }}
            </button>
          </div>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="time in scheduledForm.times"
              :key="time"
              class="flex items-center gap-1 px-2 py-1 bg-surface-overlay rounded text-sm text-ink"
            >
              {{ time }}
              <button @click="removeScheduledTime(time)" class="text-ink-subtle hover:text-red-400">×</button>
            </span>
          </div>
        </div>

        <div v-else>
          <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.intervalMinutes') }}</label>
          <input
            v-model.number="scheduledForm.intervalMinutes"
            type="number"
            min="1"
            class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
          />
        </div>

        <label class="flex items-center gap-2 cursor-pointer">
          <input v-model="scheduledForm.enabled" type="checkbox" class="accent-hytale-orange" />
          <span class="text-sm text-ink-muted">{{ t('scheduler.enabledLabel') }}</span>
        </label>
      </div>
      <template #footer>
        <button
          @click="showScheduledForm = false"
          class="px-4 py-2 text-ink-muted hover:text-ink transition-colors"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          @click="saveScheduledCommand"
          :disabled="!scheduledForm.name || !scheduledForm.command || savingScheduled"
          class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50"
        >
          {{ t('common.save') }}
        </button>
      </template>
    </Modal>

    <!-- Command Form Modal -->
    <Modal
      :open="showCommandForm"
      :title="editingCommand ? t('scheduler.editCommand') : t('scheduler.addCommand')"
      @close="showCommandForm = false"
    >
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.commandName') }}</label>
          <input
            v-model="commandForm.name"
            type="text"
            class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.command') }}</label>
          <input
            v-model="commandForm.command"
            type="text"
            class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none font-mono"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-ink-muted mb-2">{{ t('scheduler.category') }}</label>
          <select
            v-model="commandForm.category"
            class="w-full bg-surface text-ink px-4 py-2.5 rounded-lg border border-border focus:border-hytale-orange focus:outline-none"
          >
            <option value="server">{{ t('scheduler.categories.server') }}</option>
            <option value="players">{{ t('scheduler.categories.players') }}</option>
            <option value="world">{{ t('scheduler.categories.world') }}</option>
            <option value="custom">{{ t('scheduler.categories.custom') }}</option>
          </select>
        </div>
      </div>
      <template #footer>
        <button
          @click="showCommandForm = false"
          class="px-4 py-2 text-ink-muted hover:text-ink transition-colors"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          @click="saveCommand"
          :disabled="!commandForm.name || !commandForm.command || saving"
          class="px-4 py-2 bg-hytale-orange text-dark rounded-lg font-medium hover:bg-hytale-yellow transition-colors disabled:opacity-50"
        >
          {{ t('common.save') }}
        </button>
      </template>
    </Modal>
  </div>
</template>
