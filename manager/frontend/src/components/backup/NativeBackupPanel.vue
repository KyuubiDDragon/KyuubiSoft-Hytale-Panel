<script setup lang="ts">
/**
 * The game server's own backups (`/backup`, written to backups/native and
 * backups/native/archive). The server holds world saving while it packs, so
 * these are consistent even while players are online.
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'
import {
  backupApi,
  requestErrorText,
  type BackupJob,
  type JobStartResponse,
  type NativeBackupInfo,
  type NativeBackupList,
} from '@/api/backup'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

const props = defineProps<{
  /** A backup job is running; starting another one is refused by the server anyway. */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** A job was started (native backup or restore); the parent tracks it. */
  job: [job: BackupJob]
}>()

const { t } = useI18n()
const authStore = useAuthStore()
const toast = useToast()
const { ask } = useConfirm()

const list = ref<NativeBackupList | null>(null)
const loading = ref(true)
const starting = ref(false)

// Also reads the JSON error of a failed download (which arrives as a Blob).
const errorText = (err: unknown) => requestErrorText(err, t('errors.serverError'))

// Only the first load shows the loading state; later refreshes keep the table as it is.
async function refresh() {
  try {
    list.value = await backupApi.listNative()
  } catch (err) {
    toast.error(await errorText(err))
  } finally {
    loading.value = false
  }
}

function handleStarted(response: JobStartResponse) {
  if (response.job) emit('job', response.job)
  else if (response.success) toast.success(response.message || t('backups.native.created'))
  else toast.error(response.error || t('errors.serverError'))
}

async function createNow() {
  starting.value = true
  try {
    handleStarted(await backupApi.createNative())
  } catch (err) {
    toast.error(await errorText(err))
  } finally {
    starting.value = false
  }
}

async function restore(backup: NativeBackupInfo) {
  const ok = await ask({
    title: t('backups.native.restoreTitle'),
    message: t('backups.native.confirmRestore', { name: backup.name }),
    variant: 'danger',
    confirmText: t('backups.restore'),
  })
  if (!ok) return
  try {
    handleStarted(await backupApi.restoreNative(backup))
  } catch (err) {
    toast.error(await errorText(err))
  }
}

async function remove(backup: NativeBackupInfo) {
  const ok = await ask({
    title: t('backups.delete'),
    message: t('backups.native.confirmDelete', { name: backup.name }),
    variant: 'danger',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    await backupApi.deleteNative(backup)
    toast.success(t('backups.deleteSuccess'))
    await refresh()
  } catch (err) {
    toast.error(await errorText(err))
  }
}

async function download(backup: NativeBackupInfo) {
  try {
    const { blob, filename } = await backupApi.downloadNative(backup)
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  } catch (err) {
    toast.error(await errorText(err))
  }
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleString()
}

defineExpose({ refresh })
onMounted(refresh)
</script>

<template>
  <Card :padding="false">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3 w-full">
        <div>
          <h3 class="text-lg font-semibold text-ink">{{ t('backups.native.title') }}</h3>
          <p class="text-sm text-ink-muted">{{ t('backups.native.subtitle') }}</p>
        </div>
        <Button
          v-if="authStore.hasPermission('backups.create')"
          :loading="starting"
          :disabled="props.busy || list?.inProgress"
          @click="createNow"
        >
          {{ t('backups.native.create') }}
        </Button>
      </div>
    </template>

    <div v-if="list && !list.available" class="px-5 py-3 text-sm text-ink-muted border-b border-border">
      {{ t('backups.native.unavailable', { directory: list.directory }) }}
    </div>
    <div v-else-if="list?.inProgress" class="px-5 py-3 text-sm text-ink-muted border-b border-border">
      {{ t('backups.native.inProgress') }}
    </div>

    <div class="overflow-x-auto">
      <table class="table" :aria-label="t('backups.native.title')">
        <thead>
          <tr>
            <th>{{ t('backups.name') }}</th>
            <th>{{ t('backups.size') }}</th>
            <th>{{ t('backups.date') }}</th>
            <th>{{ t('backups.type') }}</th>
            <th class="text-right">{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loading && (!list || list.backups.length === 0)">
            <td colspan="5" class="text-center text-ink-subtle py-8">
              {{ t('backups.native.empty') }}
            </td>
          </tr>
          <tr v-for="backup in list?.backups ?? []" :key="`${backup.scope}/${backup.name}`">
            <td class="font-medium">{{ backup.name }}</td>
            <td>{{ backup.size_mb }} MB</td>
            <td>{{ formatDate(backup.created_at) }}</td>
            <td>
              <Badge :variant="backup.scope === 'archive' ? 'warning' : 'success'">
                {{ backup.scope === 'archive' ? t('backups.native.archive') : t('backups.native.recent') }}
              </Badge>
            </td>
            <td>
              <div class="flex justify-end gap-2">
                <Button
                  v-if="authStore.hasPermission('backups.download')"
                  size="sm"
                  variant="secondary"
                  :aria-label="t('backups.download')"
                  @click="download(backup)"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </Button>
                <Button
                  v-if="authStore.hasPermission('backups.restore')"
                  size="sm"
                  variant="primary"
                  :disabled="props.busy"
                  :aria-label="t('backups.restore')"
                  @click="restore(backup)"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </Button>
                <Button
                  v-if="authStore.hasPermission('backups.delete')"
                  size="sm"
                  variant="danger"
                  :disabled="props.busy"
                  :aria-label="t('backups.delete')"
                  @click="remove(backup)"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </Card>
</template>
