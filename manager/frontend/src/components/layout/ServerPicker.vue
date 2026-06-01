<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useServersStore } from '@/stores/servers'

const serversStore = useServersStore()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

onMounted(() => {
  if (!serversStore.loaded) {
    void serversStore.refresh()
  }
  document.addEventListener('click', onDocClick)
})
onUnmounted(() => document.removeEventListener('click', onDocClick))

// Close on outside-clicks only. Without the target check the handler fires
// on the toggle button itself (clicks bubble to document) and closes the
// dropdown in the same tick the button opened it — the user sees nothing.
function onDocClick(event: MouseEvent) {
  if (!open.value) return
  if (root.value && event.target instanceof Node && root.value.contains(event.target)) return
  open.value = false
}

function pick(id: string) {
  serversStore.setActive(id)
  open.value = false
}
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      @click="open = !open"
      class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-surface-overlay text-sm text-white transition-colors min-h-9"
      :class="serversStore.activeServer?.status === 'broken' ? 'border border-status-error' : 'border border-border/40'"
      :aria-expanded="open"
      :aria-haspopup="true"
    >
      <span
        class="inline-block w-2 h-2 rounded-full"
        :class="serversStore.activeServer?.status === 'ready' ? 'bg-status-success' :
                serversStore.activeServer?.status === 'creating' ? 'bg-status-warning' :
                serversStore.activeServer?.status === 'broken' ? 'bg-status-error' : 'bg-gray-500'"
      />
      <span class="font-medium truncate max-w-[12rem]">
        {{ serversStore.activeServer?.name ?? 'Loading…' }}
      </span>
      <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="open"
        @click.stop
        class="absolute left-0 top-full mt-2 w-72 rounded-xl bg-surface-raised border border-border/60 shadow-2xl z-50 overflow-hidden"
        role="listbox"
      >
        <div class="max-h-72 overflow-y-auto">
          <button
            v-for="s in serversStore.servers"
            :key="s.id"
            role="option"
            :aria-selected="s.id === serversStore.activeId"
            @click="pick(s.id)"
            class="w-full flex items-start gap-3 px-3 py-2 text-left hover:bg-surface-overlay transition-colors"
            :class="s.id === serversStore.activeId ? 'bg-surface-overlay' : ''"
          >
            <span
              class="mt-1 inline-block w-2 h-2 rounded-full"
              :class="s.status === 'ready' ? 'bg-status-success' :
                      s.status === 'creating' ? 'bg-status-warning' :
                      'bg-status-error'"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-white truncate">{{ s.name }}</span>
                <span v-if="s.id === serversStore.defaultId" class="text-[10px] uppercase tracking-wider text-hytale-orange">default</span>
              </div>
              <div class="text-xs text-gray-400 truncate">{{ s.containerName }} · :{{ s.network.serverPort }}</div>
            </div>
          </button>
        </div>
        <div class="border-t border-border/60 px-3 py-2 text-xs text-gray-400">
          {{ serversStore.servers.length }} server{{ serversStore.servers.length === 1 ? '' : 's' }} registered
        </div>
      </div>
    </Transition>
  </div>
</template>
