<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'

const { t } = useI18n()

interface Notification {
  id: number
  title: string
  body: string | null
  level: 'info' | 'warning' | 'error' | 'success'
  link: string | null
  createdAt: string
  readAt: string | null
}

const notifications = ref<Notification[]>([])
const open = ref(false)
const POLL_MS = 30_000
let timer: ReturnType<typeof setInterval> | null = null

const unreadCount = computed(() => notifications.value.filter(n => !n.readAt).length)

async function load() {
  try {
    const { data } = await api.get<{ notifications: Notification[] }>('/me/notifications')
    notifications.value = data.notifications
  } catch {
    // ignore — backend may not yet have any prefs set for this user
  }
}

async function markRead(id: number) {
  try {
    await api.post(`/me/notifications/${id}/read`)
    const n = notifications.value.find(x => x.id === id)
    if (n) n.readAt = new Date().toISOString()
  } catch { /* */ }
}

async function dismissAll() {
  try {
    await api.post('/me/notifications/dismiss-all')
    notifications.value = []
  } catch { /* */ }
}

function levelColor(level: Notification['level']): string {
  switch (level) {
    case 'error': return 'text-status-error'
    case 'warning': return 'text-status-warning'
    case 'success': return 'text-status-success'
    default: return 'text-status-info'
  }
}

function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.closest('[data-notification-bell]')) open.value = false
}

onMounted(() => {
  void load()
  timer = setInterval(load, POLL_MS)
  document.addEventListener('click', onDocClick)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div class="relative" data-notification-bell>
    <button
      type="button"
      @click="open = !open"
      :aria-label="unreadCount > 0 ? t('notifications.bellWithCount', { count: unreadCount }) : t('notifications.title')"
      class="relative p-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-50 transition-colors flex items-center justify-center"
    >
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
      <span
        v-if="unreadCount > 0"
        class="absolute top-1 right-1 min-w-[1rem] h-4 rounded-full bg-status-error text-white text-[10px] font-bold flex items-center justify-center px-1"
      >{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-if="open" class="absolute right-0 top-full mt-2 w-80 rounded-xl bg-dark-200 border border-dark-50/60 shadow-2xl z-50 overflow-hidden">
        <div class="px-3 py-2 border-b border-dark-50/60 flex items-center justify-between">
          <span class="text-sm font-medium text-ink">{{ t('notifications.title') }}</span>
          <button v-if="notifications.length" @click="dismissAll" class="text-xs text-ink-muted hover:text-ink">{{ t('notifications.dismissAll') }}</button>
        </div>
        <div class="max-h-96 overflow-y-auto">
          <div v-if="notifications.length === 0" class="p-6 text-center text-sm text-ink-muted">{{ t('notifications.empty') }}</div>
          <button
            v-for="n in notifications"
            :key="n.id"
            @click="markRead(n.id)"
            class="w-full text-left px-3 py-2 hover:bg-dark-100 transition-colors border-b border-dark-50/40"
            :class="!n.readAt ? 'bg-dark-100/40' : ''"
          >
            <div class="flex items-center gap-2">
              <span class="text-xs uppercase tracking-wider" :class="levelColor(n.level)">{{ n.level }}</span>
              <span v-if="!n.readAt" class="w-1.5 h-1.5 rounded-full bg-hytale-orange" />
              <span class="ml-auto text-[10px] text-gray-500">{{ new Date(n.createdAt).toLocaleString() }}</span>
            </div>
            <div class="text-sm text-white mt-0.5">{{ n.title }}</div>
            <div v-if="n.body" class="text-xs text-gray-400 mt-0.5 line-clamp-2">{{ n.body }}</div>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
