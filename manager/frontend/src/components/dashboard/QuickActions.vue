<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { serverApi } from '@/api/server'
import { backupApi } from '@/api/backup'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()

const loading = ref({
  start: false,
  stop: false,
  restart: false,
  backup: false,
})

const emit = defineEmits<{
  action: [type: string, success: boolean]
}>()

async function handleStart() {
  loading.value.start = true
  try {
    await serverApi.start()
    emit('action', 'start', true)
  } catch (error) {
    emit('action', 'start', false)
  } finally {
    loading.value.start = false
  }
}

async function handleStop() {
  loading.value.stop = true
  try {
    await serverApi.stop()
    emit('action', 'stop', true)
  } catch (error) {
    emit('action', 'stop', false)
  } finally {
    loading.value.stop = false
  }
}

async function handleRestart() {
  loading.value.restart = true
  try {
    await serverApi.restart()
    emit('action', 'restart', true)
  } catch (error) {
    emit('action', 'restart', false)
  } finally {
    loading.value.restart = false
  }
}

async function handleBackup() {
  loading.value.backup = true
  try {
    await backupApi.create()
    emit('action', 'backup', true)
  } catch (error) {
    emit('action', 'backup', false)
  } finally {
    loading.value.backup = false
  }
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h3 class="text-lg font-semibold text-white">{{ t('dashboard.quickActions') }}</h3>
    </div>
    <div class="card-body">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Button
          variant="success"
          :loading="loading.start"
          @click="handleStart"
          class="w-full"
        >
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {{ t('dashboard.start') }}
        </Button>

        <Button
          variant="danger"
          :loading="loading.stop"
          @click="handleStop"
          class="w-full"
        >
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
          </svg>
          {{ t('dashboard.stop') }}
        </Button>

        <Button
          variant="secondary"
          :loading="loading.restart"
          @click="handleRestart"
          class="w-full"
        >
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('dashboard.restart') }}
        </Button>

        <Button
          variant="primary"
          :loading="loading.backup"
          @click="handleBackup"
          class="w-full"
        >
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
          </svg>
          {{ t('dashboard.createBackup') }}
        </Button>
      </div>
    </div>
  </div>
</template>
