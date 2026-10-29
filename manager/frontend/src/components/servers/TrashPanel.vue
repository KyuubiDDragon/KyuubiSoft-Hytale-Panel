<script setup lang="ts">
import { formatDateTime } from '@/utils/formatDate'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api/client'
import { useToast } from '@/composables/useToast'
import { apiErrorMessage } from '@/utils/apiErrors'
import Button from '@/components/ui/Button.vue'
import Modal from '@/components/ui/Modal.vue'

/**
 * Server folders that were moved to the trash when a server was deleted with
 * its data. Removing an entry deletes the files for good, so the entry name
 * has to be typed first.
 */

interface TrashEntry {
  name: string
  serverId: string
  deletedAt: string
}

const { t, te } = useI18n()
const toast = useToast()

const entries = ref<TrashEntry[]>([])
const loading = ref(false)
const loadError = ref('')
const purgeTarget = ref<TrashEntry | null>(null)
const typedName = ref('')
const purging = ref(false)

const canPurge = computed(() => !!purgeTarget.value && typedName.value === purgeTarget.value.name)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const { data } = await api.get<{ entries: TrashEntry[] }>('/servers/_trash')
    entries.value = data.entries
  } catch (err) {
    loadError.value = apiErrorMessage(err, t, te, t('servers.adm.trash.loadFailed'))
  } finally {
    loading.value = false
  }
}

function askPurge(entry: TrashEntry) {
  purgeTarget.value = entry
  typedName.value = ''
}

async function purge() {
  const target = purgeTarget.value
  if (!target || !canPurge.value) return
  purging.value = true
  try {
    await api.delete(`/servers/_trash/${encodeURIComponent(target.name)}`, {
      params: { confirm: target.name },
    })
    toast.success(t('servers.adm.trash.purged', { name: target.name }))
    purgeTarget.value = null
    await load()
  } catch (err) {
    toast.error(apiErrorMessage(err, t, te, t('servers.adm.trash.purgeFailed')))
  } finally {
    purging.value = false
  }
}

defineExpose({ load })
onMounted(load)
</script>

<template>
  <section class="bg-surface-raised border border-border rounded-xl p-4 space-y-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-ink">{{ t('servers.adm.trash.title') }}</h2>
        <p class="text-xs text-ink-muted">{{ t('servers.adm.trash.hint') }}</p>
      </div>
      <Button variant="secondary" size="sm" :loading="loading" @click="load">
        {{ t('common.refresh') }}
      </Button>
    </div>

    <p v-if="loadError" class="text-sm text-status-error" role="alert">{{ loadError }}</p>
    <p v-else-if="!loading && entries.length === 0" class="text-sm text-ink-muted">
      {{ t('servers.adm.trash.empty') }}
    </p>

    <ul v-else class="space-y-2">
      <li
        v-for="entry in entries"
        :key="entry.name"
        class="flex items-center gap-3 bg-surface-overlay border border-border rounded-lg p-3"
      >
        <div class="flex-1 min-w-0">
          <p class="font-mono text-sm text-ink truncate">{{ entry.name }}</p>
          <p class="text-[11px] text-ink-subtle">
            {{ t('servers.adm.trash.entryInfo', { id: entry.serverId, date: formatDateTime(entry.deletedAt) }) }}
          </p>
        </div>
        <Button variant="danger" size="sm" @click="askPurge(entry)">
          {{ t('servers.adm.trash.purge') }}
        </Button>
      </li>
    </ul>

    <Modal :open="!!purgeTarget" :title="t('servers.adm.trash.purgeTitle')" @close="purgeTarget = null">
      <div v-if="purgeTarget" class="space-y-3">
        <p class="text-sm text-ink">{{ t('servers.adm.trash.purgeWarning', { name: purgeTarget.name }) }}</p>
        <div>
          <label class="block text-xs font-semibold text-ink-muted mb-1">
            {{ t('servers.adm.trash.typeName', { name: purgeTarget.name }) }}
          </label>
          <input
            v-model="typedName"
            autocomplete="off"
            spellcheck="false"
            class="w-full bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm text-ink font-mono"
            @keydown.enter.prevent="purge"
          />
        </div>
      </div>
      <template #footer>
        <Button variant="secondary" size="sm" :disabled="purging" @click="purgeTarget = null">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" size="sm" :loading="purging" :disabled="!canPurge" @click="purge">
          {{ t('servers.adm.trash.purgeConfirm') }}
        </Button>
      </template>
    </Modal>
  </section>
</template>
