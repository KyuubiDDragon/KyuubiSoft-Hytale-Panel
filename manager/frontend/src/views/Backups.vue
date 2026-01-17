<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { backupApi, type BackupInfo, type StorageInfo } from '@/api/backup'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Modal from '@/components/ui/Modal.vue'
import BackupTable from '@/components/backup/BackupTable.vue'

const { t } = useI18n()

const backups = ref<BackupInfo[]>([])
const storage = ref<StorageInfo | null>(null)
const loading = ref(true)
const creating = ref(false)
const error = ref('')

// Modals
const showDeleteModal = ref(false)
const showRestoreModal = ref(false)
const selectedBackup = ref<string | null>(null)
const actionLoading = ref(false)

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

async function createBackup() {
  creating.value = true
  try {
    await backupApi.create()
    await fetchBackups()
  } catch (err) {
    error.value = t('errors.serverError')
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
    error.value = t('errors.serverError')
  }
}

async function confirmRestore() {
  if (!selectedBackup.value) return
  actionLoading.value = true
  try {
    await backupApi.restore(selectedBackup.value)
    showRestoreModal.value = false
    await fetchBackups()
  } catch (err) {
    error.value = t('errors.serverError')
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
    await fetchBackups()
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

onMounted(fetchBackups)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">{{ t('backups.title') }}</h1>
      <Button :loading="creating" @click="createBackup">
        <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        {{ t('backups.create') }}
      </Button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
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
              <p class="text-sm text-gray-400">{{ t('backups.storage') }}</p>
              <p class="text-lg font-semibold text-white">{{ storage.total_size_mb }} MB</p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-sm text-gray-400">{{ storage.backup_count }} Backups</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Backups Table -->
    <Card :padding="false">
      <BackupTable
        :backups="backups"
        :loading="loading"
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
      <p class="text-gray-300">{{ t('backups.confirmDelete') }}</p>
      <template #footer>
        <Button variant="secondary" @click="showDeleteModal = false">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" :loading="actionLoading" @click="confirmDelete">
          {{ t('common.delete') }}
        </Button>
      </template>
    </Modal>

    <!-- Restore Modal -->
    <Modal
      :open="showRestoreModal"
      :title="t('backups.restore')"
      @close="showRestoreModal = false"
    >
      <p class="text-gray-300">{{ t('backups.confirmRestore') }}</p>
      <template #footer>
        <Button variant="secondary" @click="showRestoreModal = false">
          {{ t('common.cancel') }}
        </Button>
        <Button :loading="actionLoading" @click="confirmRestore">
          {{ t('backups.restore') }}
        </Button>
      </template>
    </Modal>
  </div>
</template>
