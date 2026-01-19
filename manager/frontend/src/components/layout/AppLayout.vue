<script setup lang="ts">
import Sidebar from './Sidebar.vue'
import Header from './Header.vue'
import PermissionBanner from './PermissionBanner.vue'
</script>

<template>
  <div class="flex h-screen bg-dark overflow-hidden">
    <!-- Sidebar -->
    <Sidebar />

    <!-- Main Content -->
    <div class="flex-1 flex flex-col overflow-hidden">
      <!-- Permission Warning Banner (only shows if there are issues) -->
      <PermissionBanner />

      <!-- Header -->
      <Header />

      <!-- Page Content -->
      <main class="flex-1 overflow-auto p-6">
        <slot />
      </main>
    </div>
  </div>
</template>
