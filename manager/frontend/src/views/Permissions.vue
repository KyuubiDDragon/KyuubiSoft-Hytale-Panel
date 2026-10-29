<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  permissionsApi,
  type AccessWriteMeta,
  type PermissionUser,
  type PermissionGroup,
  type PermissionsData,
} from '@/api/management'
import Card from '@/components/ui/Card.vue'
import Badge from '@/components/ui/Badge.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import AccessStatus from '@/components/access/AccessStatus.vue'
import { accessErrorText, writeNotice } from '@/components/access/accessText'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'

/** The whitelist's permission; it is kept when a player's own permissions are edited here. */
const JOIN_PERMISSION = 'hytale.server.join'

const { t } = useI18n()
const authStore = useAuthStore()
const toast = useToast()

const canEdit = computed(() => authStore.hasPermission('players.permissions'))
const canOp = computed(() => authStore.hasPermission('players.op'))
const canMigrate = computed(() => canEdit.value && authStore.hasPermission('players.whitelist'))

// State as the server reports it
const view = ref<PermissionsData | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref('')

const users = computed(() => view.value?.users ?? [])
const groups = computed(() => view.value?.groups ?? [])
const operatorGroup = computed(() => view.value?.operatorGroup ?? 'hytale:Admin')
const defaultGroup = computed(() => view.value?.defaultGroup ?? 'hytale:Adventurer')

// Active tab
const activeTab = ref<'users' | 'groups'>('users')

// User form
const userInput = ref('')
const userGroups = ref<string[]>([])
const userPermissions = ref('')
const editingUser = ref<PermissionUser | null>(null)

// Group form
const groupName = ref('')
const groupPermissions = ref('')
const groupParent = ref<string>('')
const editingGroup = ref<PermissionGroup | null>(null)

// Confirm dialogs
const showDeleteUserConfirm = ref(false)
const showDeleteGroupConfirm = ref(false)
const pendingDeleteUser = ref<PermissionUser | null>(null)
const pendingDeleteGroup = ref<string | null>(null)

// Search
const userSearch = ref('')
const groupSearch = ref('')

const statusRef = ref<InstanceType<typeof AccessStatus> | null>(null)

const label = (user: PermissionUser) => user.name ?? user.uuid

const filteredUsers = computed(() => {
  const search = userSearch.value.toLowerCase()
  if (!search) return users.value
  return users.value.filter(
    (u) => u.uuid.includes(search) || (u.name?.toLowerCase().includes(search) ?? false),
  )
})

const filteredGroups = computed(() => {
  const search = groupSearch.value.toLowerCase()
  if (!search) return groups.value
  return groups.value.filter((g) => g.name.toLowerCase().includes(search))
})

const parentChoices = computed(() => groups.value.filter((g) => g.name !== groupName.value.trim()))

const lines = (text: string) => [...new Set(text.split('\n').map((p) => p.trim()).filter(Boolean))]
const ownPermissions = (user: PermissionUser) => user.permissions.filter((p) => p !== JOIN_PERMISSION)

/** May this user hand out the group? The operator group also needs players.op. */
const mayAssign = (group: string) => canOp.value || group !== operatorGroup.value

/** `keepError`: after a failed change, show the server's state again but keep its message. */
async function loadData(keepError = false) {
  loading.value = true
  if (!keepError) error.value = ''
  try {
    view.value = await permissionsApi.get()
  } catch (e) {
    if (!keepError) error.value = accessErrorText(e, t)
  } finally {
    loading.value = false
  }
  statusRef.value?.reload()
}

function report(result: AccessWriteMeta) {
  const notice = writeNotice(result, t)
  toast[notice.type](notice.text)
}

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (e) {
    error.value = accessErrorText(e, t)
    // Part of a change may have gone through; show what the server has now.
    await loadData(true)
  } finally {
    busy.value = false
  }
}

function findUser(input: string): PermissionUser | undefined {
  const key = input.toLowerCase()
  return users.value.find((u) => u.uuid === key || u.name?.toLowerCase() === key)
}

function saveUser() {
  const player = userInput.value.trim()
  if (!player) return
  const editing = editingUser.value
  const existing = editing ?? findUser(player)
  const typed = lines(userPermissions.value).filter((p) => p !== JOIN_PERMISSION)
  // Editing replaces the own permissions; a new entry only adds to them. The join permission stays.
  const base = editing ? [] : (existing?.permissions ?? [])
  const permissions =
    editing || typed.length > 0
      ? [...new Set([...base, ...typed, ...(existing?.joinGrant ? [JOIN_PERMISSION] : [])])]
      : undefined
  // A new entry without a chosen group leaves the player's groups as they are.
  const groups = editing || userGroups.value.length > 0 ? userGroups.value : undefined
  if (!groups && !permissions) return
  return run(async () => {
    const result = await permissionsApi.saveUser(editing?.uuid ?? player, groups, permissions)
    view.value = result
    cancelEditUser()
    report(result)
  })
}

function confirmDeleteUser(user: PermissionUser) {
  pendingDeleteUser.value = user
  showDeleteUserConfirm.value = true
}

function removeUser() {
  const user = pendingDeleteUser.value
  if (!user) return
  showDeleteUserConfirm.value = false
  pendingDeleteUser.value = null
  return run(async () => {
    const result = await permissionsApi.removeUser(user.uuid)
    view.value = result
    report(result)
  })
}

function editUser(user: PermissionUser) {
  userInput.value = label(user)
  userGroups.value = user.defaultGroup ? [] : [...user.groups]
  userPermissions.value = ownPermissions(user).join('\n')
  editingUser.value = user
}

function cancelEditUser() {
  userInput.value = ''
  userGroups.value = []
  userPermissions.value = ''
  editingUser.value = null
}

function saveGroup() {
  const name = groupName.value.trim()
  if (!name) return
  const editing = editingGroup.value
  const builtin = new Set(editing?.builtinPermissions ?? [])
  const permissions = lines(groupPermissions.value).filter((p) => !builtin.has(p))
  const chosen = groupParent.value || null
  // Unchanged (or a built-in group, whose parent is fixed): leave the parent alone.
  const parent =
    editing && (editing.builtin || (editing.parent ?? null) === chosen) ? undefined : chosen
  return run(async () => {
    const result = await permissionsApi.saveGroup(name, permissions, parent)
    view.value = result
    cancelEditGroup()
    report(result)
  })
}

function confirmDeleteGroup(name: string) {
  pendingDeleteGroup.value = name
  showDeleteGroupConfirm.value = true
}

function removeGroup() {
  const name = pendingDeleteGroup.value
  if (!name) return
  showDeleteGroupConfirm.value = false
  pendingDeleteGroup.value = null
  return run(async () => {
    const result = await permissionsApi.removeGroup(name)
    view.value = result
    report(result)
  })
}

function editGroup(group: PermissionGroup) {
  const builtin = new Set(group.builtinPermissions)
  groupName.value = group.name
  groupPermissions.value = group.permissions.filter((p) => !builtin.has(p)).join('\n')
  groupParent.value = group.parent ?? ''
  editingGroup.value = group
}

function cancelEditGroup() {
  groupName.value = ''
  groupPermissions.value = ''
  groupParent.value = ''
  editingGroup.value = null
}

function toggleUserGroup(name: string) {
  userGroups.value = userGroups.value.includes(name)
    ? userGroups.value.filter((g) => g !== name)
    : [...userGroups.value, name]
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-ink">{{ t('permissions.title') }}</h1>
      <button
        @click="loadData()"
        class="text-ink-muted hover:text-ink transition-colors"
        :class="{ 'animate-spin': loading }"
        :aria-label="t('common.refresh')"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <AccessStatus ref="statusRef" :view="view" :can-migrate="canMigrate" @migrated="loadData" />

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg" role="alert">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2" role="tablist">
      <button
        role="tab"
        :aria-selected="activeTab === 'users'"
        @click="activeTab = 'users'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors',
          activeTab === 'users'
            ? 'bg-hytale-orange text-dark'
            : 'bg-surface-overlay text-ink-muted hover:text-ink'
        ]"
      >
        {{ t('permissions.users') }}
      </button>
      <button
        role="tab"
        :aria-selected="activeTab === 'groups'"
        @click="activeTab = 'groups'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors',
          activeTab === 'groups'
            ? 'bg-hytale-orange text-dark'
            : 'bg-surface-overlay text-ink-muted hover:text-ink'
        ]"
      >
        {{ t('permissions.groups') }}
      </button>
    </div>

    <!-- Users Tab -->
    <div v-if="activeTab === 'users'" class="space-y-6">
      <!-- Add/Edit User -->
      <Card v-if="canEdit">
        <h3 class="font-semibold text-ink mb-4">
          {{ editingUser ? t('permissions.editUser') : t('permissions.addUser') }}
        </h3>
        <form @submit.prevent="saveUser" class="space-y-4">
          <div>
            <label for="perm-player" class="block text-sm text-ink-muted mb-2">{{ t('access.playerOrUuid') }}</label>
            <input
              id="perm-player"
              v-model="userInput"
              type="text"
              :placeholder="t('access.playerOrUuid')"
              :disabled="!!editingUser"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange disabled:opacity-50"
            />
          </div>

          <div>
            <span class="block text-sm text-ink-muted mb-2">{{ t('permissions.assignGroups') }}</span>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="group in groups"
                :key="group.name"
                type="button"
                :disabled="!mayAssign(group.name)"
                :title="mayAssign(group.name) ? undefined : t('permissions.operatorNeedsOp')"
                :aria-pressed="userGroups.includes(group.name)"
                @click="toggleUserGroup(group.name)"
                :class="[
                  'px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  userGroups.includes(group.name)
                    ? 'bg-hytale-orange text-dark'
                    : 'bg-surface-overlay text-ink-muted hover:text-ink'
                ]"
              >
                {{ group.name }}
              </button>
            </div>
            <p class="mt-2 text-xs text-ink-subtle">{{ t('permissions.noGroupHint', { group: defaultGroup }) }}</p>
          </div>

          <div>
            <label for="perm-own" class="block text-sm text-ink-muted mb-2">{{ t('permissions.ownPermissions') }}</label>
            <textarea
              id="perm-own"
              v-model="userPermissions"
              :placeholder="t('permissions.ownPermissionsPlaceholder')"
              rows="3"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange font-mono text-sm"
            />
            <p class="mt-1 text-xs text-ink-subtle">{{ t('permissions.joinKept') }}</p>
          </div>

          <div class="flex gap-3">
            <button
              type="submit"
              :disabled="busy || !userInput.trim()"
              class="px-6 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ t('common.save') }}
            </button>
            <button
              v-if="editingUser"
              type="button"
              @click="cancelEditUser"
              class="px-6 py-2 bg-surface-overlay text-ink-muted font-medium rounded-lg hover:text-ink transition-colors"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </form>
      </Card>

      <!-- Users List -->
      <Card>
        <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h3 class="font-semibold text-ink">{{ t('permissions.usersList') }} ({{ users.length }})</h3>
          <input
            v-model="userSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange text-sm"
          />
        </div>
        <p v-if="view?.source === 'live'" class="text-xs text-ink-subtle mb-3">{{ t('permissions.usersIncomplete') }}</p>

        <div v-if="loading && !view" class="text-center py-8 text-ink-muted">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="filteredUsers.length === 0" class="text-center py-8 text-ink-muted">
          {{ t('permissions.noUsers') }}
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="user in filteredUsers"
            :key="user.uuid"
            class="flex items-center justify-between gap-3 p-3 bg-surface-overlay rounded-lg"
          >
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 bg-hytale-orange/20 rounded-full flex items-center justify-center flex-shrink-0">
                <span class="text-hytale-orange font-medium">{{ (user.name ?? '?')[0]?.toUpperCase() }}</span>
              </div>
              <div class="min-w-0">
                <p class="text-ink font-medium flex flex-wrap items-center gap-2">
                  {{ user.name ?? t('whitelist.unknownName') }}
                  <Badge v-if="user.online" variant="success">{{ t('access.online') }}</Badge>
                  <Badge v-if="user.operator" variant="warning">{{ t('permissions.operator') }}</Badge>
                  <Badge v-if="user.joinGrant" variant="info">{{ t('permissions.joinGrant') }}</Badge>
                </p>
                <p class="text-xs text-ink-subtle font-mono truncate">{{ user.uuid }}</p>
                <div class="flex flex-wrap gap-1 mt-1">
                  <span
                    v-for="group in user.groups"
                    :key="group"
                    class="px-2 py-0.5 bg-surface-overlay text-ink-muted text-xs rounded"
                    :title="user.defaultGroup ? t('permissions.defaultGroupHint') : undefined"
                  >
                    {{ group }}<template v-if="user.defaultGroup"> ({{ t('permissions.defaultGroup') }})</template>
                  </span>
                  <span v-if="user.groups.length === 0" class="text-xs text-ink-subtle">
                    {{ t('permissions.noGroupsAssigned') }}
                  </span>
                  <span
                    v-for="perm in ownPermissions(user).slice(0, 6)"
                    :key="perm"
                    class="px-2 py-0.5 bg-surface-overlay text-ink-muted text-xs rounded font-mono"
                  >
                    {{ perm }}
                  </span>
                  <span v-if="ownPermissions(user).length > 6" class="text-xs text-ink-subtle">
                    +{{ ownPermissions(user).length - 6 }} {{ t('permissions.more') }}
                  </span>
                </div>
              </div>
            </div>
            <div v-if="canEdit" class="flex gap-2 flex-shrink-0">
              <button
                @click="editUser(user)"
                :aria-label="t('permissions.editUser')"
                class="p-2 text-ink-muted hover:text-hytale-orange transition-colors"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                @click="confirmDeleteUser(user)"
                :disabled="busy"
                :aria-label="t('common.delete')"
                class="p-2 text-ink-muted hover:text-status-error transition-colors"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </Card>
    </div>

    <!-- Groups Tab -->
    <div v-if="activeTab === 'groups'" class="space-y-6">
      <!-- Add/Edit Group -->
      <Card v-if="canEdit">
        <h3 class="font-semibold text-ink mb-4">
          {{ editingGroup ? t('permissions.editGroup') : t('permissions.addGroup') }}
        </h3>
        <form @submit.prevent="saveGroup" class="space-y-4">
          <div>
            <label for="group-name" class="block text-sm text-ink-muted mb-2">{{ t('permissions.groupName') }}</label>
            <input
              id="group-name"
              v-model="groupName"
              type="text"
              :placeholder="t('permissions.groupName')"
              :disabled="!!editingGroup"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange disabled:opacity-50"
            />
          </div>

          <div>
            <label for="group-perms" class="block text-sm text-ink-muted mb-2">{{ t('permissions.permissions') }}</label>
            <textarea
              id="group-perms"
              v-model="groupPermissions"
              :placeholder="t('permissions.permissionsPlaceholder')"
              rows="4"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange font-mono text-sm"
            />
            <p v-if="editingGroup && editingGroup.builtinPermissions.length > 0" class="mt-1 text-xs text-ink-subtle">
              {{ t('permissions.builtinPermissions', { permissions: editingGroup.builtinPermissions.join(', ') }) }}
            </p>
          </div>

          <div>
            <label for="group-parent" class="block text-sm text-ink-muted mb-2">{{ t('permissions.inheritsFrom') }}</label>
            <select
              id="group-parent"
              v-model="groupParent"
              :disabled="editingGroup?.builtin"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink focus:outline-none focus:border-hytale-orange disabled:opacity-50"
            >
              <option value="">{{ t('permissions.noParent') }}</option>
              <option v-for="group in parentChoices" :key="group.name" :value="group.name">{{ group.name }}</option>
            </select>
            <p v-if="editingGroup?.builtin" class="mt-1 text-xs text-ink-subtle">
              {{ t('permissions.builtinHint', { parent: editingGroup.parent ?? '—' }) }}
            </p>
            <p v-else-if="view?.serverRunning" class="mt-1 text-xs text-ink-subtle">{{ t('permissions.parentNeedsStop') }}</p>
          </div>

          <p v-if="!canOp" class="text-xs text-ink-subtle">{{ t('permissions.operatorNeedsOp') }}</p>

          <div class="flex gap-3">
            <button
              type="submit"
              :disabled="busy || !groupName.trim()"
              class="px-6 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ t('common.save') }}
            </button>
            <button
              v-if="editingGroup"
              type="button"
              @click="cancelEditGroup"
              class="px-6 py-2 bg-surface-overlay text-ink-muted font-medium rounded-lg hover:text-ink transition-colors"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </form>
      </Card>

      <!-- Groups List -->
      <Card>
        <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h3 class="font-semibold text-ink">{{ t('permissions.groupsList') }} ({{ groups.length }})</h3>
          <input
            v-model="groupSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange text-sm"
          />
        </div>

        <div v-if="loading && !view" class="text-center py-8 text-ink-muted">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="filteredGroups.length === 0" class="text-center py-8 text-ink-muted">
          {{ t('permissions.noGroups') }}
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="group in filteredGroups"
            :key="group.name"
            class="p-4 bg-surface-overlay rounded-lg"
          >
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-3 flex-wrap">
                <div class="w-8 h-8 bg-hytale-yellow/20 rounded-full flex items-center justify-center">
                  <svg class="w-4 h-4 text-hytale-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <span class="text-ink font-medium">{{ group.name }}</span>
                <Badge v-if="group.builtin" variant="info">{{ t('permissions.builtin') }}</Badge>
                <Badge v-if="group.name === defaultGroup" variant="success">{{ t('permissions.defaultGroup') }}</Badge>
              </div>
              <div v-if="canEdit" class="flex gap-2">
                <button
                  @click="editGroup(group)"
                  :disabled="!mayAssign(group.name)"
                  :aria-label="t('permissions.editGroup')"
                  class="p-2 text-ink-muted hover:text-hytale-orange transition-colors disabled:opacity-40"
                >
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  v-if="!group.builtin"
                  @click="confirmDeleteGroup(group.name)"
                  :disabled="busy"
                  :aria-label="t('common.delete')"
                  class="p-2 text-ink-muted hover:text-status-error transition-colors"
                >
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>

            <div v-if="group.parent" class="mb-2">
              <span class="text-xs text-ink-subtle">{{ t('permissions.inheritsFrom') }}:</span>
              <span class="ml-2 px-2 py-0.5 bg-surface-overlay text-ink-muted text-xs rounded">{{ group.parent }}</span>
            </div>

            <div v-if="group.permissions.length > 0">
              <p class="text-xs text-ink-subtle mb-1">{{ t('permissions.permissions') }}:</p>
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="perm in group.permissions.slice(0, 10)"
                  :key="perm"
                  class="px-2 py-0.5 bg-surface-overlay text-ink-muted text-xs rounded font-mono"
                >
                  {{ perm }}
                </span>
                <span
                  v-if="group.permissions.length > 10"
                  class="px-2 py-0.5 bg-surface-overlay text-ink-muted text-xs rounded"
                >
                  +{{ group.permissions.length - 10 }} {{ t('permissions.more') }}
                </span>
              </div>
            </div>
            <p v-if="group.effectivePermissions.length > group.permissions.length" class="mt-2 text-xs text-ink-subtle">
              {{ t('permissions.effective', { count: group.effectivePermissions.length }) }}
            </p>
          </div>
        </div>
      </Card>
    </div>

    <!-- Confirm Delete User -->
    <ConfirmDialog
      :show="showDeleteUserConfirm"
      :title="t('common.delete')"
      :message="pendingDeleteUser ? t('permissions.confirmDeleteUser', { name: label(pendingDeleteUser) }) : ''"
      :confirm-text="t('common.delete')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="removeUser"
      @cancel="showDeleteUserConfirm = false"
    />

    <!-- Confirm Delete Group -->
    <ConfirmDialog
      :show="showDeleteGroupConfirm"
      :title="t('common.delete')"
      :message="pendingDeleteGroup ? t('permissions.confirmDeleteGroup', { name: pendingDeleteGroup }) : ''"
      :confirm-text="t('common.delete')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="removeGroup"
      @cancel="showDeleteGroupConfirm = false"
    />
  </div>
</template>
