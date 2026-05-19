<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  description: string
  iconPath: string
  iconColor?: string
  iconAnimate?: boolean
  gradientFrom?: string
  gradientTo?: string
  borderColor?: string
}>(), {
  iconColor: 'text-hytale-orange',
  iconAnimate: false,
  gradientFrom: 'from-hytale-orange/20',
  gradientTo: 'to-hytale-yellow/20',
  borderColor: 'border-hytale-orange',
})

defineEmits<{
  dismiss: []
}>()
</script>

<template>
  <div :class="['bg-gradient-to-r', gradientFrom, gradientTo, 'border-2', borderColor, 'rounded-lg p-4']">
    <div class="flex items-start gap-4">
      <div class="flex-shrink-0">
        <svg :class="['w-8 h-8', iconColor, iconAnimate ? 'animate-pulse' : '']" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="iconPath" />
        </svg>
      </div>
      <div class="flex-1 min-w-0">
        <h3 class="text-lg font-semibold text-white mb-1">{{ title }}</h3>
        <p class="text-ink-muted text-sm mb-3">{{ description }}</p>
        <slot />
      </div>
      <button @click="$emit('dismiss')" class="flex-shrink-0 text-ink-muted hover:text-ink transition-colors">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  </div>
</template>
