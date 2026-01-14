<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Card from '@/components/ui/Card.vue'
import Terminal from '@/components/console/Terminal.vue'
import CommandsPanel from '@/components/console/CommandsPanel.vue'

const { t } = useI18n()
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Page Title -->
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-white">{{ t('console.title') }}</h1>
    </div>

    <!-- Console Card -->
    <Card class="flex-1 flex flex-col" :padding="false">
      <div class="p-5 flex-1 flex flex-col min-h-0">
        <Terminal />
      </div>
    </Card>

    <!-- Commands Reference Panel -->
    <CommandsPanel />
  </div>
</template>
