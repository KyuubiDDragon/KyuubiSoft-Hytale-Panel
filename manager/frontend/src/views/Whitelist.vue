<script setup lang="ts">
import { formatDateTime } from '@/utils/formatDate'
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  whitelistApi,
  bansApi,
  type BanEntry,
  type BansData,
  type WhitelistData,
  type WhitelistEntry,
  type AccessWriteMeta,
} from '@/api/management'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import Icon from '@/components/ui/Icon.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import EmptyTableState from '@/components/ui/EmptyTableState.vue'
import ResponsiveTable, { type TableColumn } from '@/components/ui/ResponsiveTable.vue'
import AccessStatus from '@/components/access/AccessStatus.vue'
import { accessErrorText, writeNotice } from '@/components/access/accessText'

const { t } = useI18n()
const authStore = useAuthStore()
const toast = useToast()

const canWhitelist = computed(() => authStore.hasPermission('players.whitelist'))
const canBan = computed(() => authStore.hasPermission('players.ban'))
const canUnban = computed(() => authStore.hasPermission('players.unban'))
const canMigrate = computed(
  () => authStore.hasPermission('players.whitelist') && authStore.hasPermission('players.permissions'),
)

// State as the server reports it
const whitelist = ref<WhitelistData | null>(null)
const bansView = ref<BansData | null>(null)
const newWhitelistPlayer = ref('')
const newBanPlayer = ref('')
const newBanReason = ref('')

// Loading, busy and error states
const loading = ref(true)
const busy = ref(false)
const error = ref('')

// Active tab: the first one the user may see
const activeTab = ref<'whitelist' | 'bans'>(canWhitelist.value || !canBan.value ? 'whitelist' : 'bans')

// Confirm dialogs (UUID or name of the row)
const showRemoveConfirm = ref(false)
const showUnbanConfirm = ref(false)
const pendingRemove = ref<{ id: string; label: string } | null>(null)
const pendingUnban = ref<{ id: string; label: string } | null>(null)

// Search
const whitelistSearch = ref('')
const bansSearch = ref('')

const statusRef = ref<InstanceType<typeof AccessStatus> | null>(null)

const entries = computed(() => whitelist.value?.entries ?? [])
const bans = computed(() => bansView.value?.bans ?? [])

const filteredEntries = computed<WhitelistEntry[]>(() => {
  const search = whitelistSearch.value.toLowerCase()
  if (!search) return entries.value
  return entries.value.filter(
    (e) => e.uuid.includes(search) || (e.name?.toLowerCase().includes(search) ?? false),
  )
})

const filteredBans = computed(() => {
  const search = bansSearch.value.toLowerCase()
  if (!search) return bans.value
  return bans.value.filter(
    (b) =>
      b.player.toLowerCase().includes(search) ||
      (b.target?.includes(search) ?? false) ||
      (b.reason?.toLowerCase().includes(search) ?? false),
  )
})

const whitelistColumns = computed<TableColumn[]>(() => [
  { key: 'player', label: t('whitelist.playerName') },
])

const bansColumns = computed<TableColumn[]>(() => [
  { key: 'player', label: t('whitelist.playerName') },
  { key: 'reason', label: t('whitelist.banReason') },
  { key: 'bannedAt', label: t('whitelist.bannedAt'), nowrap: true },
  { key: 'expiresOn', label: t('whitelist.expires'), nowrap: true },
])

const legacyText = computed(() => {
  const legacy = whitelist.value?.legacy
  if (!legacy) return ''
  return t('whitelist.legacyPending', {
    count: legacy.entries,
    state: legacy.enabled ? t('common.enabled') : t('common.disabled'),
  })
})

/** `keepError`: after a failed change, show the server's state again but keep its message. */
async function loadData(keepError = false) {
  loading.value = true
  if (!keepError) error.value = ''
  const [w, b] = await Promise.allSettled([
    canWhitelist.value ? whitelistApi.get() : Promise.resolve(null),
    canBan.value ? bansApi.get() : Promise.resolve(null),
  ])
  if (w.status === 'fulfilled') whitelist.value = w.value
  if (b.status === 'fulfilled') bansView.value = b.value
  const failed = [w, b].find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed && !keepError) error.value = accessErrorText(failed.reason, t)
  loading.value = false
  statusRef.value?.reload()
}

function report(result: AccessWriteMeta) {
  const notice = writeNotice(result, t)
  toast[notice.type](result.message && result.changed ? `${notice.text} ${result.message}` : notice.text)
}

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (e) {
    error.value = accessErrorText(e, t)
    // The change may have gone through after all; show what the server has now.
    await loadData(true)
  } finally {
    busy.value = false
  }
}

/** Turning the whitelist on with nobody on it keeps everyone out but the open groups. */
const showEnableConfirm = ref(false)

function toggleWhitelist() {
  const enabled = !(whitelist.value?.enabled ?? false)
  if (enabled && entries.value.length === 0 && !showEnableConfirm.value) {
    showEnableConfirm.value = true
    return
  }
  showEnableConfirm.value = false
  return run(async () => {
    const result = await whitelistApi.setEnabled(enabled)
    whitelist.value = result
    report(result)
  })
}

function addToWhitelist() {
  const player = newWhitelistPlayer.value.trim()
  if (!player) return
  return run(async () => {
    const result = await whitelistApi.addPlayer(player)
    whitelist.value = result
    newWhitelistPlayer.value = ''
    report(result)
  })
}

function confirmRemoveFromWhitelist(entry: WhitelistEntry) {
  pendingRemove.value = { id: entry.uuid, label: entry.name ?? entry.uuid }
  showRemoveConfirm.value = true
}

function removeFromWhitelist() {
  const pending = pendingRemove.value
  if (!pending) return
  showRemoveConfirm.value = false
  pendingRemove.value = null
  return run(async () => {
    const result = await whitelistApi.removePlayer(pending.id)
    whitelist.value = result
    report(result)
  })
}

function addBan() {
  const player = newBanPlayer.value.trim()
  if (!player) return
  return run(async () => {
    const result = await bansApi.add(player, newBanReason.value.trim() || undefined)
    bansView.value = result
    newBanPlayer.value = ''
    newBanReason.value = ''
    report(result)
  })
}

function confirmUnban(ban: BanEntry) {
  pendingUnban.value = { id: ban.target ?? ban.player, label: ban.player }
  showUnbanConfirm.value = true
}

function removeBan() {
  const pending = pendingUnban.value
  if (!pending) return
  showUnbanConfirm.value = false
  pendingUnban.value = null
  return run(async () => {
    const result = await bansApi.remove(pending.id)
    bansView.value = result
    report(result)
  })
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—'
  return formatDateTime(dateStr)
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('whitelist.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('whitelist.subtitle') }}</p>
      </div>
      <button
        @click="loadData()"
        class="p-2 text-ink-muted hover:text-ink transition-colors min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
        :aria-label="t('common.refresh')"
      >
        <Icon name="refresh" class="w-5 h-5" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg" role="alert">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2" role="tablist">
      <button
        v-if="canWhitelist"
        role="tab"
        :aria-selected="activeTab === 'whitelist'"
        @click="activeTab = 'whitelist'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors min-h-[44px]',
          activeTab === 'whitelist'
            ? 'bg-hytale-orange text-ink-inverse'
            : 'bg-surface-overlay text-ink-muted hover:text-ink',
        ]"
      >
        {{ t('whitelist.whitelist') }}
      </button>
      <button
        v-if="canBan"
        role="tab"
        :aria-selected="activeTab === 'bans'"
        @click="activeTab = 'bans'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors min-h-[44px]',
          activeTab === 'bans'
            ? 'bg-status-error text-white'
            : 'bg-surface-overlay text-ink-muted hover:text-ink',
        ]"
      >
        {{ t('whitelist.bans') }}
      </button>
    </div>

    <p v-if="!canWhitelist && !canBan" class="text-ink-muted">{{ t('access.errors.forbidden') }}</p>

    <!-- Whitelist Tab -->
    <div v-if="activeTab === 'whitelist' && canWhitelist" class="space-y-6">
      <AccessStatus ref="statusRef" :view="whitelist" :can-migrate="canMigrate" @migrated="loadData" />

      <!-- Whitelist Toggle -->
      <Card>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="font-semibold text-ink">{{ t('whitelist.enabled') }}</h3>
            <p class="text-sm text-ink-muted">{{ t('whitelist.enabledDescription') }}</p>
          </div>
          <button
            @click="toggleWhitelist"
            :disabled="busy || !whitelist"
            role="switch"
            :aria-checked="whitelist?.enabled ?? false"
            :aria-label="t('whitelist.enabled')"
            :class="[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50',
              whitelist?.enabled ? 'bg-hytale-orange' : 'bg-surface-overlay',
            ]"
          >
            <span
              :class="[
                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                whitelist?.enabled ? 'translate-x-6' : 'translate-x-1',
              ]"
            />
          </button>
        </div>
        <p v-if="whitelist && whitelist.openGroups.length > 0" class="mt-3 text-sm text-ink-muted">
          {{ t('whitelist.openGroups', { groups: whitelist.openGroups.join(', ') }) }}
        </p>
        <div v-if="whitelist?.legacy" class="mt-3 text-sm text-status-warning space-y-1">
          <p>{{ legacyText }}</p>
          <p v-if="whitelist.legacy.unresolved.length > 0">
            {{ t('whitelist.legacyUnresolved', { names: whitelist.legacy.unresolved.join(', ') }) }}
          </p>
        </div>
      </Card>

      <!-- Add Player -->
      <Card>
        <h3 class="font-semibold text-ink mb-4">{{ t('whitelist.addPlayer') }}</h3>
        <form @submit.prevent="addToWhitelist" class="flex flex-col sm:flex-row gap-3">
          <input
            v-model="newWhitelistPlayer"
            type="text"
            :placeholder="t('access.playerOrUuid')"
            :aria-label="t('access.playerOrUuid')"
            class="flex-1 px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
          />
          <Button type="submit" :disabled="busy || !newWhitelistPlayer.trim()">
            {{ t('common.save') }}
          </Button>
        </form>
        <p class="mt-2 text-xs text-ink-subtle">{{ t('whitelist.addHint') }}</p>
      </Card>

      <!-- Whitelist List -->
      <div>
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 class="font-semibold text-ink">
            {{ t('whitelist.players') }} <span class="text-ink-muted font-normal">({{ entries.length }})</span>
          </h3>
          <input
            v-model="whitelistSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange text-sm w-full sm:w-auto"
          />
        </div>

        <div v-if="loading && entries.length === 0" class="space-y-2">
          <Skeleton v-for="i in 3" :key="i" height="3rem" />
        </div>

        <EmptyTableState
          v-else-if="filteredEntries.length === 0"
          icon="players"
          :title="t('whitelist.noPlayers')"
          :subtitle="whitelistSearch ? t('common.noResults') : t('whitelist.noPlayersSubtitle')"
        />

        <ResponsiveTable
          v-else
          :columns="whitelistColumns"
          :rows="filteredEntries"
          :row-key="(r) => r.uuid"
          :aria-label="t('whitelist.players')"
          :mobile-card-label="(r) => r.name ?? r.uuid"
        >
          <template #cell:player="{ row }">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-hytale-orange/20 rounded-full flex items-center justify-center flex-shrink-0">
                <span class="text-hytale-orange font-medium">{{ (row.name ?? '?')[0]?.toUpperCase() }}</span>
              </div>
              <div class="min-w-0">
                <p class="text-ink flex items-center gap-2">
                  {{ row.name ?? t('whitelist.unknownName') }}
                  <Badge v-if="row.online" variant="success">{{ t('access.online') }}</Badge>
                </p>
                <p class="text-xs text-ink-subtle font-mono truncate">{{ row.uuid }}</p>
              </div>
            </div>
          </template>
          <template #actions="{ row }">
            <Button
              variant="ghost"
              size="sm"
              icon-only
              class="!text-ink-muted hover:!text-status-error"
              :disabled="busy"
              :aria-label="t('common.remove')"
              @click="confirmRemoveFromWhitelist(row)"
            >
              <Icon name="trash" class="w-5 h-5" />
            </Button>
          </template>
        </ResponsiveTable>
      </div>
    </div>

    <!-- Bans Tab -->
    <div v-if="activeTab === 'bans' && canBan" class="space-y-6">
      <AccessStatus :view="bansView" />

      <div
        v-if="bansView?.unsupported"
        class="p-4 bg-status-warning/10 border border-status-warning/20 rounded-lg text-sm text-ink"
      >
        {{ t('whitelist.bansUnsupported', { reason: bansView.unsupported }) }}
      </div>

      <!-- Add Ban -->
      <Card>
        <h3 class="font-semibold text-ink mb-4">{{ t('whitelist.banPlayer') }}</h3>
        <form @submit.prevent="addBan" class="space-y-3">
          <input
            v-model="newBanPlayer"
            type="text"
            :placeholder="t('access.playerOrUuid')"
            :aria-label="t('access.playerOrUuid')"
            class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
          />
          <div class="flex flex-col sm:flex-row gap-3">
            <input
              v-model="newBanReason"
              type="text"
              maxlength="200"
              :placeholder="t('whitelist.banReason')"
              :aria-label="t('whitelist.banReason')"
              class="flex-1 px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
            />
            <Button type="submit" variant="danger" :disabled="busy || !newBanPlayer.trim()">
              {{ t('whitelist.ban') }}
            </Button>
          </div>
        </form>
        <p class="mt-2 text-xs text-ink-subtle">{{ t('whitelist.banHint') }}</p>
      </Card>

      <!-- Bans List -->
      <div>
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 class="font-semibold text-ink">
            {{ t('whitelist.bannedPlayers') }} <span class="text-ink-muted font-normal">({{ bans.length }})</span>
          </h3>
          <input
            v-model="bansSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange text-sm w-full sm:w-auto"
          />
        </div>

        <div v-if="loading && bans.length === 0" class="space-y-2">
          <Skeleton v-for="i in 3" :key="i" height="3rem" />
        </div>

        <EmptyTableState
          v-else-if="filteredBans.length === 0"
          icon="ban"
          :title="t('whitelist.noBans')"
          :subtitle="bansSearch ? t('common.noResults') : t('whitelist.noBansSubtitle')"
        />

        <ResponsiveTable
          v-else
          :columns="bansColumns"
          :rows="filteredBans"
          :row-key="(b) => b.target ?? b.player"
          :aria-label="t('whitelist.bannedPlayers')"
          :mobile-card-label="(b) => b.player"
        >
          <template #cell:player="{ row }">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-status-error/20 rounded-full flex items-center justify-center flex-shrink-0">
                <Icon name="ban" class="w-4 h-4 text-status-error" />
              </div>
              <div class="min-w-0">
                <p class="text-ink font-medium flex flex-wrap items-center gap-2">
                  {{ row.player }}
                  <Badge v-if="!row.inEffect" variant="info">{{ t('whitelist.expired') }}</Badge>
                  <Badge v-if="!row.readable" variant="warning" :title="t('whitelist.unreadableHint')">
                    {{ t('whitelist.unreadable') }}
                  </Badge>
                </p>
                <p v-if="row.target && row.target !== row.player" class="text-xs text-ink-subtle font-mono truncate">
                  {{ row.target }}
                </p>
                <p v-if="row.bannedBy" class="text-xs text-ink-subtle">
                  {{ t('whitelist.bannedBy') }}: {{ row.bannedBy }}
                </p>
              </div>
            </div>
          </template>
          <template #cell:reason="{ row }">
            <span v-if="row.reason" class="text-ink-muted">{{ row.reason }}</span>
            <span v-else class="text-ink-subtle">—</span>
          </template>
          <template #cell:bannedAt="{ row }">
            <span class="text-sm text-ink-muted whitespace-nowrap">{{ formatDate(row.bannedAt) }}</span>
          </template>
          <template #cell:expiresOn="{ row }">
            <span class="text-sm text-ink-muted whitespace-nowrap">
              {{ row.permanent ? t('whitelist.permanent') : formatDate(row.expiresOn) }}
            </span>
          </template>
          <template #actions="{ row }">
            <Button
              v-if="canUnban && row.target"
              variant="secondary"
              size="sm"
              :disabled="busy"
              @click="confirmUnban(row)"
            >
              {{ t('whitelist.unban') }}
            </Button>
          </template>
        </ResponsiveTable>
      </div>
    </div>

    <!-- Confirm Remove from Whitelist -->
    <ConfirmDialog
      :show="showRemoveConfirm"
      :title="t('common.remove')"
      :message="pendingRemove ? t('whitelist.confirmRemove', { player: pendingRemove.label }) : ''"
      :confirm-text="t('common.remove')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="removeFromWhitelist"
      @cancel="showRemoveConfirm = false"
    />

    <!-- Confirm turning on an empty whitelist -->
    <ConfirmDialog
      :show="showEnableConfirm"
      :title="t('whitelist.enabled')"
      :message="t('whitelist.confirmEnableEmpty', { groups: whitelist?.openGroups.join(', ') || '—' })"
      :confirm-text="t('common.enabled')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="toggleWhitelist"
      @cancel="showEnableConfirm = false"
    />

    <!-- Confirm Unban -->
    <ConfirmDialog
      :show="showUnbanConfirm"
      :title="t('whitelist.unban')"
      :message="pendingUnban ? t('whitelist.confirmUnban', { player: pendingUnban.label }) : ''"
      :confirm-text="t('whitelist.unban')"
      :cancel-text="t('common.cancel')"
      variant="primary"
      @confirm="removeBan"
      @cancel="showUnbanConfirm = false"
    />
  </div>
</template>
