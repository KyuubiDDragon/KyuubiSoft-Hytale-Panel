<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import api from '@/api/client'
import Card from '@/components/ui/Card.vue'
import { useToast } from '@/composables/useToast'
import { useConfirm } from '@/composables/useConfirm'

interface Note { id: number; note: string; byUser: string; createdAt: string }
interface Punishment { id: number; type: string; reason: string | null; byUser: string; createdAt: string; expiresAt: string | null; active: number }

const { t } = useI18n()
const route = useRoute()
const authStore = useAuthStore()
const { addToast } = useToast()
const { ask } = useConfirm()
const playerName = computed(() => String(route.params.name || ''))
const canEdit = computed(() => authStore.hasPermission('players.kick'))
const canErase = computed(() => authStore.hasPermission('players.ban'))
const exporting = ref(false)
const erasing = ref(false)

async function exportData() {
  exporting.value = true
  try {
    const res = await api.get(`/players/${encodeURIComponent(playerName.value)}/export-data`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `player-data-${playerName.value}.json`
    a.click()
    URL.revokeObjectURL(url)
    addToast(t('profile.gdpr.exported'), 'success')
  } catch {
    addToast(t('profile.gdpr.exportFailed'), 'error')
  } finally {
    exporting.value = false
  }
}

async function eraseData() {
  const ok = await ask({
    title: t('profile.gdpr.eraseTitle'),
    message: t('profile.gdpr.eraseConfirm', { name: playerName.value }),
    variant: 'danger',
    confirmText: t('profile.gdpr.erase'),
  })
  if (!ok) return
  erasing.value = true
  try {
    await api.delete(`/players/${encodeURIComponent(playerName.value)}/data`)
    addToast(t('profile.gdpr.erased'), 'success')
    await load()
  } catch {
    addToast(t('profile.gdpr.eraseFailed'), 'error')
  } finally {
    erasing.value = false
  }
}

const notes = ref<Note[]>([])
const punishments = ref<Punishment[]>([])
const newNote = ref('')
const saving = ref(false)
const error = ref('')

async function load() {
  try {
    const [n, p] = await Promise.all([
      api.get<{ notes: Note[] }>(`/players/${encodeURIComponent(playerName.value)}/notes`),
      api.get<{ punishments: Punishment[] }>(`/players/${encodeURIComponent(playerName.value)}/punishments`),
    ])
    notes.value = n.data.notes
    punishments.value = p.data.punishments
    error.value = ''
  } catch {
    error.value = t('profile.loadError')
  }
}

async function addNote() {
  const text = newNote.value.trim()
  if (!text) return
  saving.value = true
  try {
    await api.post(`/players/${encodeURIComponent(playerName.value)}/notes`, { note: text })
    newNote.value = ''
    await load()
  } catch {
    error.value = t('profile.saveError')
  } finally {
    saving.value = false
  }
}

async function deleteNote(id: number) {
  try {
    await api.delete(`/players/${encodeURIComponent(playerName.value)}/notes/${id}`)
    notes.value = notes.value.filter(n => n.id !== id)
  } catch { /* ignore */ }
}

function punishClass(type: string): string {
  if (type.includes('ban')) return 'badge-error'
  if (type.includes('mute')) return 'badge-warning'
  if (type === 'kick') return 'badge-info'
  return 'badge-info'
}

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center gap-3">
      <div class="w-12 h-12 rounded-full bg-hytale-orange/20 flex items-center justify-center">
        <span class="text-hytale-orange font-bold text-lg">{{ playerName.charAt(0).toUpperCase() }}</span>
      </div>
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ playerName }}</h1>
        <p class="text-ink-muted text-sm">{{ t('profile.subtitle') }}</p>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <button
          @click="exportData"
          :disabled="exporting"
          class="flex items-center gap-2 px-3 py-2 bg-surface-overlay text-ink rounded-lg text-sm hover:bg-border transition-colors disabled:opacity-50"
          :title="t('profile.gdpr.exportHint')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
          {{ exporting ? t('common.loading') : t('profile.gdpr.export') }}
        </button>
        <button
          v-if="canErase"
          @click="eraseData"
          :disabled="erasing"
          class="flex items-center gap-2 px-3 py-2 bg-red-500/10 text-red-400 rounded-lg text-sm hover:bg-red-500/20 transition-colors disabled:opacity-50"
          :title="t('profile.gdpr.eraseHint')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          {{ t('profile.gdpr.erase') }}
        </button>
      </div>
    </div>

    <p v-if="error" class="text-status-error text-sm">{{ error }}</p>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Staff notes -->
      <Card :title="t('profile.notes')">
        <div v-if="canEdit" class="flex gap-2 mb-4">
          <input
            v-model="newNote"
            @keyup.enter="addNote"
            :placeholder="t('profile.addNotePlaceholder')"
            class="input flex-1"
          />
          <button @click="addNote" :disabled="saving || !newNote.trim()" class="btn btn-primary btn-sm">
            {{ t('profile.add') }}
          </button>
        </div>
        <ul v-if="notes.length" class="space-y-2">
          <li v-for="n in notes" :key="n.id" class="flex items-start justify-between gap-2 p-3 rounded-lg bg-surface-muted/40">
            <div class="min-w-0">
              <p class="text-sm text-ink break-words">{{ n.note }}</p>
              <p class="text-xs text-ink-subtle mt-1">{{ n.byUser }} · {{ new Date(n.createdAt).toLocaleString() }}</p>
            </div>
            <button v-if="canEdit" @click="deleteNote(n.id)" class="text-ink-subtle hover:text-status-error text-xs flex-shrink-0" :title="t('common.delete')">✕</button>
          </li>
        </ul>
        <p v-else class="text-ink-subtle text-sm">{{ t('profile.noNotes') }}</p>
      </Card>

      <!-- Punishment timeline -->
      <Card :title="t('profile.punishmentHistory')">
        <ul v-if="punishments.length" class="space-y-2">
          <li v-for="p in punishments" :key="p.id" class="p-3 rounded-lg bg-surface-muted/40">
            <div class="flex items-center gap-2 mb-1">
              <span class="badge" :class="punishClass(p.type)">{{ p.type }}</span>
              <span v-if="p.active" class="text-xs text-status-warning">{{ t('profile.active') }}</span>
            </div>
            <p v-if="p.reason" class="text-sm text-ink">{{ p.reason }}</p>
            <p class="text-xs text-ink-subtle mt-1">
              {{ p.byUser }} · {{ new Date(p.createdAt).toLocaleString() }}
              <template v-if="p.expiresAt"> · {{ t('profile.until') }} {{ new Date(p.expiresAt).toLocaleString() }}</template>
            </p>
          </li>
        </ul>
        <p v-else class="text-ink-subtle text-sm">{{ t('profile.noPunishments') }}</p>
      </Card>
    </div>
  </div>
</template>
