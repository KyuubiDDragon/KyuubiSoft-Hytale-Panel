<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { BackupInfo } from '@/api/backup'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

const { t } = useI18n()

defineProps<{
  backups: BackupInfo[]
  loading?: boolean
}>()

const emit = defineEmits<{
  restore: [id: string]
  delete: [id: string]
  download: [id: string]
}>()

function formatDate(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleString()
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="table">
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
        <tr v-if="backups.length === 0">
          <td colspan="5" class="text-center text-gray-500 py-8">
            {{ t('backups.noBackups') }}
          </td>
        </tr>
        <tr v-for="backup in backups" :key="backup.id">
          <td class="font-medium">{{ backup.id }}</td>
          <td>{{ backup.size_mb }} MB</td>
          <td>{{ formatDate(backup.created_at) }}</td>
          <td>
            <Badge :variant="backup.type === 'manual' ? 'info' : 'success'">
              {{ backup.type === 'manual' ? t('backups.manual') : t('backups.auto') }}
            </Badge>
          </td>
          <td>
            <div class="flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                @click="emit('download', backup.id)"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </Button>
              <Button
                size="sm"
                variant="primary"
                @click="emit('restore', backup.id)"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </Button>
              <Button
                size="sm"
                variant="danger"
                @click="emit('delete', backup.id)"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </Button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
