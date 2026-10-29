<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import {
  backupApi,
  requestErrorText,
  waitForBackupJob,
  type BackupInfo,
  type BackupJob,
  type StorageInfo,
} from '@/api/backup'
import { useToast } from '@/composables/useToast'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Modal from '@/components/ui/Modal.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import BackupTable from '@/components/backup/BackupTable.vue'
import NativeBackupPanel from '@/components/backup/NativeBackupPanel.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import ErrorState from '@/components/ui/ErrorState.vue'

const { t } = useI18n()
const authStore = useAuthStore()
const toast = useToast()

const backups = ref<BackupInfo[]>([])
const storage = ref<StorageInfo | null>(null)
const loading = ref(true)
const creating = ref(false)
const error = ref('')
const nativePanel = ref<InstanceType<typeof NativeBackupPanel> | null>(null)

// Modals
const showDeleteModal = ref(false)
const showRestoreModal = ref(false)
const selectedBackup = ref<string | null>(null)
const actionLoading = ref(false)

// The backup job (restore / native backup) currently running on the server.
const activeJob = ref<BackupJob | null>(null)
let unmounted = false

const JOB_TYPE_KEYS: Record<BackupJob['type'], string> = {
  restore: 'restore',
  'native-restore': 'nativeRestore',
  'native-create': 'nativeCreate',
  'world-restore': 'worldRestore',
}
const JOB_STEP_KEYS: Record<string, string> = {
  queued: 'queued',
  validating: 'validating',
  extracting: 'extracting',
  'stopping-server': 'stoppingServer',
  'safety-backup': 'safetyBackup',
  swapping: 'swapping',
  'starting-server': 'startingServer',
  'backing-up': 'backingUp',
  done: 'done',
}

const activeJobText = computed(() => {
  const job = activeJob.value
  if (!job) return ''
  const type = t(`backups.job.types.${JOB_TYPE_KEYS[job.type] ?? 'restore'}`)
  const step = JOB_STEP_KEYS[job.step] ? t(`backups.job.steps.${JOB_STEP_KEYS[job.step]}`) : job.step
  return t('backups.job.running', { type, step })
})

const errorText = (err: unknown) => requestErrorText(err, t('errors.serverError'))

async function fetchBackups() {
  loading.value = true
  try {
    const response = await backupApi.list()
    backups.value = response.backups
    storage.value = response.storage
    error.value = ''
  } catch (err) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

/** Follow a job until it ends, then report it and refresh both lists. */
async function trackJob(job: BackupJob) {
  // One poller per job (a resumed job and a fresh start can meet).
  if (activeJob.value?.id === job.id) return
  activeJob.value = job
  const isStale = () => unmounted || activeJob.value?.id !== job.id
  const finished = await waitForBackupJob(job, {
    shouldStop: isStale,
    onUpdate: (current) => {
      if (!isStale()) activeJob.value = current
    },
  })
  if (isStale()) return
  activeJob.value = null
  if (finished.state === 'succeeded') {
    toast.success(finished.message || t('backups.job.succeeded'))
  } else if (finished.state === 'failed') {
    toast.error(finished.error || t('backups.job.failed'))
  } else {
    toast.warning(t('backups.job.lost'))
  }
  await Promise.all([fetchBackups(), nativePanel.value?.refresh()])
}

async function resumeRunningJob() {
  try {
    const { running } = await backupApi.listJobs()
    if (running) void trackJob(running)
  } catch {
    /* no job info: nothing to resume */
  }
}

async function createBackup() {
  creating.value = true
  try {
    const result = await backupApi.create()
    await fetchBackups()
    toast.success(t('backups.createSuccess'))
    if (result.warning) toast.warning(t('backups.createWarning', { reason: result.warning }))
  } catch (err) {
    toast.error(await errorText(err))
  } finally {
    creating.value = false
  }
}

function handleRestore(id: string) {
  selectedBackup.value = id
  showRestoreModal.value = true
}

function handleDelete(id: string) {
  selectedBackup.value = id
  showDeleteModal.value = true
}

async function handleDownload(id: string) {
  try {
    const { blob, filename } = await backupApi.download(id)

    // Create a temporary download link
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()

    // Cleanup
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  } catch (err) {
    toast.error(await errorText(err))
  }
}

async function confirmRestore() {
  if (!selectedBackup.value) return
  actionLoading.value = true
  try {
    const response = await backupApi.restore(selectedBackup.value)
    showRestoreModal.value = false
    if (response.job) {
      toast.info(t('backups.restoreStarted'))
      void trackJob(response.job)
    } else {
      toast.success(response.message || t('backups.restoreSuccess'))
      await fetchBackups()
    }
  } catch (err) {
    toast.error(await errorText(err))
  } finally {
    actionLoading.value = false
  }
}

async function confirmDelete() {
  if (!selectedBackup.value) return
  actionLoading.value = true
  try {
    await backupApi.delete(selectedBackup.value)
    showDeleteModal.value = false
    toast.success(t('backups.deleteSuccess'))
    await fetchBackups()
  } catch (err) {
    toast.error(await errorText(err))
  } finally {
    actionLoading.value = false
  }
}

onMounted(() => {
  void fetchBackups()
  void resumeRunningJob()
})
onBeforeUnmount(() => {
  unmounted = true
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <PageHeader :title="t('backups.title')" :subtitle="t('backups.subtitle')">
      <template #actions>
        <Button
          v-if="authStore.hasPermission('backups.create')"
          :loading="creating"
          :disabled="!!activeJob"
          @click="createBackup"
        >
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          {{ t('backups.create') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Error State -->
    <ErrorState v-if="error" size="sm" :message="error" @retry="fetchBackups" />

    <!-- Running restore / native backup -->
    <div
      v-if="activeJob"
      class="card border border-hytale-orange/40"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div class="card-body flex items-center gap-3">
        <svg class="w-5 h-5 animate-spin text-hytale-orange shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        <div>
          <p class="font-medium text-ink">{{ activeJobText }}</p>
          <p class="text-sm text-ink-muted">{{ t('backups.job.hint') }}</p>
        </div>
      </div>
    </div>

    <!-- Storage Info -->
    <div v-if="storage" class="card">
      <div class="card-body">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-hytale-orange/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
              </svg>
            </div>
            <div>
              <p class="text-sm text-ink-muted">{{ t('backups.storage') }}</p>
              <p class="text-lg font-semibold text-ink">{{ storage.total_size_mb }} MB</p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-sm text-ink-muted">{{ storage.backup_count }} Backups</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Server-written (native) backups -->
    <NativeBackupPanel ref="nativePanel" :busy="!!activeJob" @job="trackJob" />

    <!-- Panel Backups Table -->
    <Card :padding="false" :title="t('backups.panelTitle')">
      <BackupTable
        :backups="backups"
        :loading="loading"
        :busy="!!activeJob"
        @restore="handleRestore"
        @delete="handleDelete"
        @download="handleDownload"
      />
    </Card>

    <!-- Delete Modal -->
    <Modal
      :open="showDeleteModal"
      :title="t('backups.delete')"
      @close="showDeleteModal = false"
    >
      <p class="text-ink-muted">{{ t('backups.confirmDelete') }}</p>
      <template #footer>
        <Button variant="secondary" @click="showDeleteModal = false">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" :loading="actionLoading" @click="confirmDelete">
          {{ t('common.delete') }}
        </Button>
      </template>
    </Modal>

    <!-- Restore Confirm Dialog -->
    <ConfirmDialog
      :show="showRestoreModal"
      :title="t('backups.restore')"
      :message="t('backups.confirmRestore')"
      :confirm-text="t('backups.restore')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      :loading="actionLoading"
      @confirm="confirmRestore"
      @cancel="showRestoreModal = false"
    />
  </div>
</template>
