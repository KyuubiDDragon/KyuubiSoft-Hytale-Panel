<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  title: string
  value: string | number
  subtitle?: string
  status?: 'success' | 'warning' | 'error' | 'info'
  icon?: 'server' | 'cpu' | 'memory' | 'players' | 'clock'
}>()

const statusColor = computed(() => {
  switch (props.status) {
    case 'success': return 'text-status-success'
    case 'warning': return 'text-status-warning'
    case 'error': return 'text-status-error'
    case 'info': return 'text-status-info'
    default: return 'text-white'
  }
})

const iconBgColor = computed(() => {
  switch (props.status) {
    case 'success': return 'bg-status-success/20'
    case 'warning': return 'bg-status-warning/20'
    case 'error': return 'bg-status-error/20'
    case 'info': return 'bg-status-info/20'
    default: return 'bg-hytale-orange/20'
  }
})
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="flex items-start justify-between">
        <div>
          <p class="text-sm text-gray-400 mb-1">{{ title }}</p>
          <p :class="['text-2xl font-bold', statusColor]">{{ value }}</p>
          <p v-if="subtitle" class="text-sm text-gray-500 mt-1">{{ subtitle }}</p>
        </div>
        <div :class="['w-12 h-12 rounded-xl flex items-center justify-center', iconBgColor]">
          <!-- Server Icon -->
          <svg v-if="icon === 'server'" class="w-6 h-6" :class="statusColor" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
          </svg>

          <!-- CPU Icon -->
          <svg v-else-if="icon === 'cpu'" class="w-6 h-6" :class="statusColor" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
          </svg>

          <!-- Memory Icon -->
          <svg v-else-if="icon === 'memory'" class="w-6 h-6" :class="statusColor" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>

          <!-- Players Icon -->
          <svg v-else-if="icon === 'players'" class="w-6 h-6" :class="statusColor" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>

          <!-- Clock Icon -->
          <svg v-else-if="icon === 'clock'" class="w-6 h-6" :class="statusColor" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
      </div>
    </div>
  </div>
</template>
