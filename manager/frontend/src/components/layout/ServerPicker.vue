<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useServersStore, displayState, type DisplayState } from '@/stores/servers'

withDefaults(defineProps<{ placement?: 'down' | 'up' }>(), { placement: 'down' })

const { t } = useI18n()
const serversStore = useServersStore()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

const RUN_STATE_POLL_MS = 30_000
let pollTimer: ReturnType<typeof setInterval> | null = null

const DOT_CLASS: Record<DisplayState, string> = {
  running: 'bg-status-success',
  stopped: 'bg-gray-500',
  unknown: 'bg-gray-500',
  creating: 'bg-status-warning',
  waiting: 'bg-status-warning',
  broken: 'bg-status-error',
}

function stateOf(id: string): DisplayState {
  const server = serversStore.servers.find((s) => s.id === id)
  return server ? displayState(server, serversStore.runStates[id]) : 'unknown'
}

const activeState = computed<DisplayState>(() =>
  serversStore.activeServer ? stateOf(serversStore.activeServer.id) : 'unknown',
)

// The running state is only asked for while the picker is on screen.
watch(
  () => serversStore.pickerVisible,
  (visible) => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    if (!visible) return
    void serversStore.refreshRunStates()
    pollTimer = setInterval(() => void serversStore.refreshRunStates(), RUN_STATE_POLL_MS)
  },
  { immediate: true },
)

function toggle() {
  open.value = !open.value
  if (open.value) void serversStore.refreshRunStates()
}

onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  if (pollTimer) clearInterval(pollTimer)
})

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
  <!-- Hidden without multiserver, without servers.list, or while nothing is loaded. -->
  <div v-if="serversStore.pickerVisible" ref="root" class="relative">
    <button
      type="button"
      @click="toggle"
      class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-surface-overlay text-sm text-ink transition-colors min-h-9"
      :class="activeState === 'broken' ? 'border border-status-error' : 'border border-border/40'"
      :aria-expanded="open"
      :aria-haspopup="true"
      :aria-label="t('serverScope.label')"
      :title="t(`serverScope.${activeState}`)"
    >
      <span class="inline-block w-2 h-2 rounded-full" :class="DOT_CLASS[activeState]" />
      <span class="font-medium truncate max-w-[7rem] sm:max-w-[12rem]">
        {{ serversStore.activeServer?.name ?? t('serverScope.loading') }}
      </span>
      <svg class="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
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
        class="absolute left-0 w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-surface-raised border border-border/60 shadow-2xl z-50 overflow-hidden"
        :class="placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'"
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
              :class="DOT_CLASS[stateOf(s.id)]"
              :title="t(`serverScope.${stateOf(s.id)}`)"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-ink truncate">{{ s.name }}</span>
                <span v-if="s.id === serversStore.defaultId" class="text-[10px] uppercase tracking-wider text-hytale-orange">{{ t('serverScope.defaultBadge') }}</span>
              </div>
              <div class="text-xs text-ink-muted truncate">
                {{ t(`serverScope.${stateOf(s.id)}`) }} · :{{ s.network.serverPort }}
              </div>
            </div>
          </button>
        </div>
        <div class="border-t border-border/60 px-3 py-2 text-xs text-ink-muted">
          {{ t('serverScope.count', { count: serversStore.servers.length }, serversStore.servers.length) }}
          · <span class="uppercase tracking-wider text-status-warning">{{ t('servers.guard.experimentalBadge') }}</span>
        </div>
      </div>
    </Transition>
  </div>
</template>
