<script setup lang="ts">
import { ref, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import Sidebar from './Sidebar.vue'
import MobileNav from './MobileNav.vue'
import Header from './Header.vue'
import PermissionBanner from './PermissionBanner.vue'
import DemoBanner from './DemoBanner.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'

const { t } = useI18n()
const sidebarOpen = ref(false)

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

provide('sidebarOpen', sidebarOpen)
provide('toggleSidebar', toggleSidebar)
</script>

<template>
  <div class="flex h-screen bg-surface text-ink overflow-hidden">
    <!-- Keyboard skip link: jumps past the 20+ sidebar items straight to the page. -->
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-hytale-orange focus:text-dark focus:font-medium focus:shadow-lg"
    >
      {{ t('common.skipToContent') }}
    </a>

    <!-- Mobile overlay -->
    <Transition
      enter-active-class="transition-opacity ease-out duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity ease-in duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="sidebarOpen"
        class="fixed inset-0 bg-black/50 z-30 lg:hidden"
        @click="sidebarOpen = false"
      />
    </Transition>

    <!-- Sidebar -->
    <Sidebar
      :class="[
        'fixed lg:static inset-y-0 left-0 z-40 transform transition-transform duration-200 ease-in-out lg:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full'
      ]"
    />

    <!-- Main Content -->
    <div class="flex-1 flex flex-col overflow-hidden w-0">
      <!-- Demo Mode Banner (only shows if in demo mode) -->
      <DemoBanner />

      <!-- Permission Warning Banner (only shows if there are issues) -->
      <PermissionBanner />

      <!-- Header -->
      <Header />

      <!-- Page Content (extra bottom padding on mobile clears the bottom nav) -->
      <main id="main-content" tabindex="-1" class="flex-1 overflow-auto p-4 sm:p-6 pb-24 lg:pb-6 focus:outline-none">
        <slot />
      </main>
    </div>

    <!-- Mobile bottom navigation (hidden at lg+) -->
    <MobileNav />

    <!-- Global Toast Notifications -->
    <ToastContainer />
  </div>
</template>
