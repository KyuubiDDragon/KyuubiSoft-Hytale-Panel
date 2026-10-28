<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppLayout from './components/layout/AppLayout.vue'
import CommandPalette from './components/ui/CommandPalette.vue'
import ConfirmHost from './components/ui/ConfirmHost.vue'
import { useAuthStore } from './stores/auth'
import { useThemeStore } from './stores/theme'
import { useServersStore } from './stores/servers'
import { useSessionGuard } from './composables/useSessionGuard'

const route = useRoute()
const authStore = useAuthStore()
// Initialise the theme store early so the class lands on <html> before the
// first render — avoids a flash of the wrong theme.
useThemeStore()
// Validate the session on app start and whenever the tab wakes up, so the UI
// never shows "logged in" while the token behind it is long dead.
useSessionGuard()

// The server list decides which server every request addresses, so pages
// only start once it is known; logging out forgets it.
const serversStore = useServersStore()
watch(
  () => authStore.isAuthenticated,
  (authenticated) => {
    if (authenticated) void serversStore.init()
    else serversStore.reset()
  },
  { immediate: true },
)

const showLayout = computed(() => {
  return authStore.isAuthenticated && route.name !== 'login'
})
</script>

<template>
  <AppLayout v-if="showLayout">
    <!-- Keyed by the server: switching servers re-creates the page, so it
         neither keeps polling nor shows data of the previous server. -->
    <router-view v-if="serversStore.loaded" v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" :key="serversStore.epoch" />
      </Transition>
    </router-view>
  </AppLayout>
  <router-view v-else />
  <!-- Command palette is global; opens with Cmd/Ctrl+K regardless of route. -->
  <CommandPalette v-if="authStore.isAuthenticated" />
  <!-- Global confirm host — any view can `await useConfirm().ask(...)`. -->
  <ConfirmHost />
</template>
