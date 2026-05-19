<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppLayout from './components/layout/AppLayout.vue'
import CommandPalette from './components/ui/CommandPalette.vue'
import { useAuthStore } from './stores/auth'
import { useThemeStore } from './stores/theme'

const route = useRoute()
const authStore = useAuthStore()
// Initialise the theme store early so the class lands on <html> before the
// first render — avoids a flash of the wrong theme.
useThemeStore()

const showLayout = computed(() => {
  return authStore.isAuthenticated && route.name !== 'login'
})
</script>

<template>
  <AppLayout v-if="showLayout">
    <router-view v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" />
      </Transition>
    </router-view>
  </AppLayout>
  <router-view v-else />
  <!-- Command palette is global; opens with Cmd/Ctrl+K regardless of route. -->
  <CommandPalette v-if="authStore.isAuthenticated" />
</template>
