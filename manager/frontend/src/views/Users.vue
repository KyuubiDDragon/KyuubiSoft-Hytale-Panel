<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { usersApi, type User } from '@/api/users'
import { rolesApi, type Role } from '@/api/roles'
import Card from '@/components/ui/Card.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Button from '@/components/ui/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import ErrorState from '@/components/ui/ErrorState.vue'
import EmptyTableState from '@/components/ui/EmptyTableState.vue'
import ResponsiveTable, { type TableColumn } from '@/components/ui/ResponsiveTable.vue'

const { t } = useI18n()
const authStore = useAuthStore()

const users = ref<User[]>([])
const roles = ref<Role[]>([])
const loading = ref(true)
const error = ref('')

// Form state
const showAddModal = ref(false)
const showEditModal = ref(false)
const showDeleteConfirm = ref(false)
const editingUser = ref<User | null>(null)
const deletingUser = ref<User | null>(null)
const formUsername = ref('')
const formPassword = ref('')
const formRoleId = ref<string>('')
const formError = ref('')

const columns = computed<TableColumn[]>(() => [
  { key: 'username', label: t('users.username') },
  { key: 'role', label: t('users.role') },
  { key: 'created', label: t('users.created'), hideOnMobile: false, nowrap: true },
  { key: 'lastLogin', label: t('users.lastLogin'), hideOnMobile: false, nowrap: true },
])

// Helper to get default role ID (viewer role or first role)
const defaultRoleId = computed(() => {
  const viewerRole = roles.value.find(r => r.name.toLowerCase() === 'viewer')
  return viewerRole?.id || roles.value[0]?.id || ''
})

function getRoleById(roleId: string): Role | undefined {
  return roles.value.find(r => r.id === roleId)
}

function getRoleName(roleId: string): string {
  const role = getRoleById(roleId)
  return role?.name || roleId
}

function getRoleBadgeStyle(roleId: string): { bg: string; text: string } {
  const role = getRoleById(roleId)
  if (role?.color) {
    return {
      bg: `${role.color}33`,
      text: role.color,
    }
  }
  const name = role?.name?.toLowerCase() || ''
  if (name === 'admin') return { bg: 'rgba(239, 68, 68, 0.2)', text: '#ef4444' }
  if (name === 'moderator') return { bg: 'rgba(251, 146, 60, 0.2)', text: '#fb923c' }
  if (name === 'operator') return { bg: 'rgba(59, 130, 246, 0.2)', text: '#3b82f6' }
  return { bg: 'rgba(107, 114, 128, 0.2)', text: '#6b7280' }
}

async function loadUsers() {
  loading.value = true
  error.value = ''
  try {
    const data = await usersApi.getAll()
    users.value = data.users
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function loadRoles() {
  try {
    const response = await rolesApi.getAll()
    roles.value = response.roles
  } catch (e) {
    console.error('Failed to load roles:', e)
  }
}

function openAddModal() {
  formUsername.value = ''
  formPassword.value = ''
  formRoleId.value = defaultRoleId.value
  formError.value = ''
  showAddModal.value = true
}

function openEditModal(user: User) {
  editingUser.value = user
  formPassword.value = ''
  formRoleId.value = user.roleId || ''
  formError.value = ''
  showEditModal.value = true
}

async function addUser() {
  formError.value = ''
  if (!formUsername.value.trim() || !formPassword.value.trim()) {
    formError.value = t('users.requiredFields')
    return
  }
  try {
    await usersApi.create(formUsername.value.trim(), formPassword.value, formRoleId.value)
    showAddModal.value = false
    await loadUsers()
  } catch (e: any) {
    formError.value = e.response?.data?.error || t('errors.serverError')
  }
}

async function updateUser() {
  formError.value = ''
  if (!editingUser.value) return
  try {
    const updates: { password?: string; roleId?: string } = {}
    if (formPassword.value) {
      updates.password = formPassword.value
    }
    const currentRoleId = editingUser.value.roleId
    if (formRoleId.value !== currentRoleId) {
      updates.roleId = formRoleId.value
    }
    if (Object.keys(updates).length === 0) {
      showEditModal.value = false
      return
    }
    await usersApi.update(editingUser.value.username, updates)
    showEditModal.value = false
    await loadUsers()
  } catch (e: any) {
    formError.value = e.response?.data?.error || t('errors.serverError')
  }
}

function deleteUser(user: User) {
  deletingUser.value = user
  showDeleteConfirm.value = true
}

async function confirmDeleteUser() {
  if (!deletingUser.value) return
  try {
    await usersApi.delete(deletingUser.value.username)
    await loadUsers()
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    showDeleteConfirm.value = false
    deletingUser.value = null
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

onMounted(() => {
  loadUsers()
  loadRoles()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('users.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('users.subtitle') }}</p>
      </div>
      <div class="flex gap-2">
        <button
          @click="loadUsers"
          class="p-2 text-ink-muted hover:text-ink transition-colors min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
          :aria-label="t('common.refresh')"
        >
          <Icon name="refresh" class="w-5 h-5" :class="{ 'animate-spin': loading }" />
        </button>
        <Button v-if="authStore.hasPermission('users.create')" @click="openAddModal" class="flex items-center gap-2">
          <Icon name="users" class="w-4 h-4" />
          {{ t('users.addUser') }}
        </Button>
      </div>
    </div>

    <!-- Error Banner -->
    <div v-if="error && users.length > 0" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Info Card -->
    <Card>
      <div class="flex items-start gap-4">
        <div class="p-3 bg-hytale-orange/20 rounded-lg flex-shrink-0">
          <Icon name="users" class="w-6 h-6 text-hytale-orange" />
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-semibold text-ink">{{ t('users.rolesInfo') }}</h3>
          <div class="text-sm text-ink-muted mt-2 space-y-1">
            <p v-for="role in roles" :key="role.id">
              <span class="font-medium" :style="{ color: role.color || '#6b7280' }">{{ role.name }}:</span>
              {{ role.description }}
            </p>
            <p v-if="roles.length === 0" class="text-ink-subtle italic">{{ t('common.loading') }}</p>
          </div>
        </div>
      </div>
    </Card>

    <!-- Users list -->
    <div>
      <h2 class="text-lg font-semibold text-ink mb-3">
        {{ t('users.usersList') }} <span class="text-ink-muted font-normal">({{ users.length }})</span>
      </h2>

      <ErrorState
        v-if="error && users.length === 0"
        :message="error"
        @retry="loadUsers"
      />

      <div v-else-if="loading && users.length === 0" class="space-y-2">
        <Skeleton v-for="i in 4" :key="i" height="3.5rem" />
      </div>

      <EmptyTableState
        v-else-if="users.length === 0"
        icon="users"
        :title="t('users.noUsers')"
        :subtitle="t('users.noUsersSubtitle')"
      >
        <Button v-if="authStore.hasPermission('users.create')" size="sm" @click="openAddModal">
          {{ t('users.addUser') }}
        </Button>
      </EmptyTableState>

      <ResponsiveTable
        v-else
        :columns="columns"
        :rows="users"
        :row-key="(u) => u.username"
        :aria-label="t('users.usersList')"
        :mobile-card-label="(u) => u.username"
      >
        <template #cell:username="{ row }">
          <div class="flex items-center gap-3">
            <div
              class="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
              :style="{
                backgroundColor: getRoleBadgeStyle(row.roleId).bg,
                color: getRoleBadgeStyle(row.roleId).text,
              }"
            >
              <span class="font-bold">{{ row.username[0]?.toUpperCase() }}</span>
            </div>
            <div class="min-w-0">
              <p class="font-medium text-ink truncate">{{ row.username }}</p>
              <span v-if="row.username === authStore.username" class="text-xs text-ink-subtle">({{ t('users.you') }})</span>
            </div>
          </div>
        </template>
        <template #cell:role="{ row }">
          <span
            class="px-2 py-0.5 rounded text-xs font-medium"
            :style="{
              backgroundColor: getRoleBadgeStyle(row.roleId).bg,
              color: getRoleBadgeStyle(row.roleId).text,
            }"
          >
            {{ getRoleName(row.roleId) }}
          </span>
        </template>
        <template #cell:created="{ row }">
          <span class="text-sm text-ink-muted whitespace-nowrap">{{ formatDate(row.createdAt) }}</span>
        </template>
        <template #cell:lastLogin="{ row }">
          <span v-if="row.lastLogin" class="text-sm text-ink-muted whitespace-nowrap">{{ formatDate(row.lastLogin) }}</span>
          <span v-else class="text-sm text-ink-subtle">—</span>
        </template>
        <template #actions="{ row }">
          <Button
            v-if="authStore.hasPermission('users.edit')"
            variant="ghost"
            size="sm"
            icon-only
            :aria-label="t('common.edit')"
            @click="openEditModal(row)"
          >
            <Icon name="edit" class="w-5 h-5" />
          </Button>
          <Button
            v-if="row.username !== authStore.username && authStore.hasPermission('users.delete')"
            variant="ghost"
            size="sm"
            icon-only
            :aria-label="t('common.delete')"
            class="!text-ink-muted hover:!text-status-error"
            @click="deleteUser(row)"
          >
            <Icon name="trash" class="w-5 h-5" />
          </Button>
        </template>
      </ResponsiveTable>
    </div>

    <!-- Add User Modal -->
    <div v-if="showAddModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-surface-raised rounded-xl p-6 w-full max-w-md">
        <h2 class="text-xl font-bold text-ink mb-4">{{ t('users.addUser') }}</h2>

        <div v-if="formError" class="p-3 mb-4 bg-status-error/10 border border-status-error/20 rounded-lg">
          <p class="text-status-error text-sm">{{ formError }}</p>
        </div>

        <form @submit.prevent="addUser" class="space-y-4">
          <div>
            <label class="block text-sm text-ink-muted mb-1">{{ t('users.username') }}</label>
            <input
              v-model="formUsername"
              type="text"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
              :placeholder="t('users.usernamePlaceholder')"
            />
          </div>

          <div>
            <label class="block text-sm text-ink-muted mb-1">{{ t('users.password') }}</label>
            <input
              v-model="formPassword"
              type="password"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
              :placeholder="t('users.passwordPlaceholder')"
            />
          </div>

          <div>
            <label class="block text-sm text-ink-muted mb-1">{{ t('users.role') }}</label>
            <select
              v-model="formRoleId"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink focus:outline-none focus:border-hytale-orange"
            >
              <option v-for="role in roles" :key="role.id" :value="role.id">
                {{ role.name }} - {{ role.description }}
              </option>
            </select>
          </div>

          <div class="flex gap-3 pt-2">
            <Button variant="secondary" type="button" @click="showAddModal = false" class="flex-1">{{ t('common.cancel') }}</Button>
            <Button type="submit" class="flex-1">{{ t('common.add') }}</Button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit User Modal -->
    <div v-if="showEditModal && editingUser" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-surface-raised rounded-xl p-6 w-full max-w-md">
        <h2 class="text-xl font-bold text-ink mb-4">{{ t('users.editUser') }}: {{ editingUser.username }}</h2>

        <div v-if="formError" class="p-3 mb-4 bg-status-error/10 border border-status-error/20 rounded-lg">
          <p class="text-status-error text-sm">{{ formError }}</p>
        </div>

        <form @submit.prevent="updateUser" class="space-y-4">
          <div>
            <label class="block text-sm text-ink-muted mb-1">{{ t('users.newPassword') }}</label>
            <input
              v-model="formPassword"
              type="password"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange"
              :placeholder="t('users.newPasswordPlaceholder')"
            />
            <p class="text-xs text-ink-subtle mt-1">{{ t('users.leaveBlank') }}</p>
          </div>

          <div>
            <label class="block text-sm text-ink-muted mb-1">{{ t('users.role') }}</label>
            <select
              v-model="formRoleId"
              class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink focus:outline-none focus:border-hytale-orange"
            >
              <option v-for="role in roles" :key="role.id" :value="role.id">
                {{ role.name }} - {{ role.description }}
              </option>
            </select>
          </div>

          <div class="flex gap-3 pt-2">
            <Button variant="secondary" type="button" @click="showEditModal = false" class="flex-1">{{ t('common.cancel') }}</Button>
            <Button type="submit" class="flex-1">{{ t('common.save') }}</Button>
          </div>
        </form>
      </div>
    </div>

    <!-- Delete Confirm Dialog -->
    <ConfirmDialog
      :show="showDeleteConfirm"
      :title="t('common.delete')"
      :message="deletingUser ? t('users.confirmDelete', { username: deletingUser.username }) : ''"
      :confirm-text="t('common.delete')"
      :cancel-text="t('common.cancel')"
      variant="danger"
      @confirm="confirmDeleteUser"
      @cancel="showDeleteConfirm = false"
    />
  </div>
</template>
