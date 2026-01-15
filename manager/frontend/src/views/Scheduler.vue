<script setup lang="ts">
import { ref, onMounted, reactive, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import { schedulerApi, type ScheduleConfig, type QuickCommand, type SchedulerStatus } from '@/api/scheduler'

const { t } = useI18n()

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
  quickCommands: [],
})

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

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('scheduler.title') }}</h1>
        <p class="text-gray-400 mt-1">{{ t('scheduler.subtitle') }}</p>
      </div>
    </div>

    <!-- Messages -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>
    <div v-if="successMessage" class="p-4 bg-status-success/10 border border-status-success/20 rounded-lg">
      <p class="text-status-success">{{ successMessage }}</p>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400">
      {{ t('common.loading') }}
    </div>

    <template v-else>
      <!-- Automatic Backups -->
      <Card :title="t('scheduler.autoBackups')">
        <div class="space-y-4">
          <!-- Enable Toggle -->
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-white">{{ t('scheduler.enableAutoBackups') }}</p>
              <p class="text-sm text-gray-400">{{ t('scheduler.autoBackupsDesc') }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="config.backups.enabled" class="sr-only peer">
              <div class="w-11 h-6 bg-dark-50 rounded-full peer peer-checked:bg-hytale-orange peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
          </div>

          <div v-if="config.backups.enabled" class="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-dark-50">
            <!-- Schedule Time -->
            <div>
              <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('scheduler.backupTime') }}</label>
              <input
                v-model="config.backups.schedule"
                type="time"
                class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
              />
            </div>

            <!-- Retention -->
            <div>
              <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('scheduler.retentionDays') }}</label>
              <input
                v-model.number="config.backups.retentionDays"
                type="number"
                min="1"
                max="365"
                class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
              />
            </div>

            <!-- Before Restart -->
            <div class="flex items-center">
              <label class="flex items-center cursor-pointer">
                <input type="checkbox" v-model="config.backups.beforeRestart" class="sr-only peer">
                <div class="w-5 h-5 bg-dark-50 rounded peer peer-checked:bg-hytale-orange flex items-center justify-center">
                  <svg v-if="config.backups.beforeRestart" class="w-3 h-3 text-dark" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <span class="ml-2 text-sm text-gray-300">{{ t('scheduler.beforeRestart') }}</span>
              </label>
            </div>
          </div>

          <!-- Status -->
          <div v-if="status?.backups" class="pt-4 border-t border-dark-50 text-sm text-gray-400">
            <p v-if="status.backups.nextRun">{{ t('scheduler.nextBackup') }}: {{ new Date(status.backups.nextRun).toLocaleString() }}</p>
            <p v-if="status.backups.lastRun">{{ t('scheduler.lastBackup') }}: {{ new Date(status.backups.lastRun).toLocaleString() }}</p>
          </div>

          <!-- Save -->
          <div class="pt-4 border-t border-dark-50 flex justify-end">
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

      <!-- Broadcast -->
      <Card :title="t('scheduler.broadcast')">
        <div class="space-y-4">
          <p class="text-sm text-gray-400">{{ t('scheduler.broadcastDesc') }}</p>
          <div class="flex gap-3">
            <input
              v-model="broadcastMessage"
              type="text"
              :placeholder="t('scheduler.broadcastPlaceholder')"
              class="flex-1 bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
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
              <p class="font-medium text-white">{{ t('scheduler.enableAnnouncements') }}</p>
              <p class="text-sm text-gray-400">{{ t('scheduler.announcementsDesc') }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="config.announcements.enabled" class="sr-only peer">
              <div class="w-11 h-6 bg-dark-50 rounded-full peer peer-checked:bg-hytale-orange peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
          </div>

          <!-- Welcome Message -->
          <div v-if="config.announcements.enabled">
            <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('scheduler.welcomeMessage') }}</label>
            <input
              v-model="config.announcements.welcome"
              type="text"
              :placeholder="t('scheduler.welcomePlaceholder')"
              class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            />
            <p class="text-xs text-gray-500 mt-1">{{ t('scheduler.welcomeHint') }}</p>
          </div>

          <!-- Scheduled List -->
          <div v-if="config.announcements.enabled && config.announcements.scheduled.length > 0" class="space-y-2">
            <div
              v-for="ann in config.announcements.scheduled"
              :key="ann.id"
              class="flex items-center gap-3 p-3 bg-dark-400 rounded-lg"
            >
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="ann.enabled" class="sr-only peer">
                <div class="w-9 h-5 bg-dark-50 rounded-full peer peer-checked:bg-hytale-orange peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
              </label>
              <div class="flex-1">
                <p class="text-white text-sm">{{ ann.message }}</p>
                <p class="text-xs text-gray-500">{{ t('scheduler.every') }} {{ ann.intervalMinutes }} {{ t('scheduler.minutes') }}</p>
              </div>
              <button
                @click="removeAnnouncement(ann.id)"
                class="p-1 text-gray-400 hover:text-red-400 transition-colors"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Add Announcement -->
          <div v-if="config.announcements.enabled" class="flex gap-3 pt-4 border-t border-dark-50">
            <input
              v-model="newAnnouncement.message"
              type="text"
              :placeholder="t('scheduler.announcementPlaceholder')"
              class="flex-1 bg-dark-400 text-white px-4 py-2 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            />
            <input
              v-model.number="newAnnouncement.intervalMinutes"
              type="number"
              min="1"
              class="w-24 bg-dark-400 text-white px-3 py-2 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none text-center"
            />
            <button
              @click="addAnnouncement"
              class="px-4 py-2 bg-dark-50 text-white rounded-lg hover:bg-dark-100 transition-colors"
            >
              {{ t('common.add') }}
            </button>
          </div>

          <!-- Save -->
          <div class="pt-4 border-t border-dark-50 flex justify-end">
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
        <template #actions>
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
          <p class="text-sm text-gray-400">{{ t('scheduler.quickCommandsDesc') }}</p>

          <div v-for="(commands, category) in commandsByCategory" :key="category" class="space-y-2">
            <h4 class="text-sm font-medium text-gray-400 uppercase tracking-wider">{{ category }}</h4>
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              <div
                v-for="cmd in commands"
                :key="cmd.id"
                class="group relative flex items-center gap-3 p-3 bg-dark-400 rounded-lg hover:bg-dark-50 transition-colors cursor-pointer"
                @click="executeCommand(cmd.id)"
              >
                <div class="w-8 h-8 bg-dark-100 rounded-lg flex items-center justify-center">
                  <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-white truncate">{{ cmd.name }}</p>
                  <p class="text-xs text-gray-500 font-mono truncate">{{ cmd.command }}</p>
                </div>
                <div class="absolute top-1 right-1 hidden group-hover:flex gap-1">
                  <button
                    @click.stop="openCommandForm(cmd)"
                    class="p-1 text-gray-400 hover:text-white bg-dark-100 rounded"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  <button
                    @click.stop="deleteCommand(cmd.id)"
                    class="p-1 text-gray-400 hover:text-red-400 bg-dark-100 rounded"
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
    </template>

    <!-- Command Form Modal -->
    <div v-if="showCommandForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-dark-200 rounded-xl p-6 w-full max-w-md">
        <h3 class="text-lg font-bold text-white mb-4">
          {{ editingCommand ? t('scheduler.editCommand') : t('scheduler.addCommand') }}
        </h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('scheduler.commandName') }}</label>
            <input
              v-model="commandForm.name"
              type="text"
              class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('scheduler.command') }}</label>
            <input
              v-model="commandForm.command"
              type="text"
              class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none font-mono"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-2">{{ t('scheduler.category') }}</label>
            <select
              v-model="commandForm.category"
              class="w-full bg-dark-400 text-white px-4 py-2.5 rounded-lg border border-dark-50 focus:border-hytale-orange focus:outline-none"
            >
              <option value="server">Server</option>
              <option value="players">Players</option>
              <option value="world">World</option>
              <option value="custom">Custom</option>
            </select>
          </div>
        </div>
        <div class="flex justify-end gap-3 mt-6">
          <button
            @click="showCommandForm = false"
            class="px-4 py-2 text-gray-400 hover:text-white transition-colors"
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
        </div>
      </div>
    </div>
  </div>
</template>
