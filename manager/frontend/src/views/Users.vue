<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { usersApi, type User } from '@/api/users'
import Card from '@/components/ui/Card.vue'

const { t } = useI18n()
const authStore = useAuthStore()

const users = ref<User[]>([])
const loading = ref(true)
const error = ref('')

// Form state
const showAddModal = ref(false)
const showEditModal = ref(false)
const editingUser = ref<User | null>(null)
const formUsername = ref('')
const formPassword = ref('')
const formRole = ref<User['role']>('viewer')
const formError = ref('')

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

function openAddModal() {
  formUsername.value = ''
  formPassword.value = ''
  formRole.value = 'viewer'
  formError.value = ''
  showAddModal.value = true
}

function openEditModal(user: User) {
  editingUser.value = user
  formPassword.value = ''
  formRole.value = user.role
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
    await usersApi.create(formUsername.value.trim(), formPassword.value, formRole.value)
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
    const updates: { password?: string; role?: User['role'] } = {}
    if (formPassword.value) {
      updates.password = formPassword.value
    }
    if (formRole.value !== editingUser.value.role) {
      updates.role = formRole.value
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

async function deleteUser(user: User) {
  if (!confirm(t('users.confirmDelete', { username: user.username }))) return
  try {
    await usersApi.delete(user.username)
    await loadUsers()
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

function getRoleBadgeClass(role: User['role']): string {
  switch (role) {
    case 'admin':
      return 'bg-status-error/20 text-status-error'
    case 'moderator':
      return 'bg-hytale-orange/20 text-hytale-orange'
    case 'operator':
      return 'bg-blue-500/20 text-blue-400'
    default:
      return 'bg-gray-500/20 text-gray-400'
  }
}

onMounted(loadUsers)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('users.title') }}</h1>
        <p class="text-gray-400 mt-1">{{ t('users.subtitle') }}</p>
      </div>
      <div class="flex gap-2">
        <button
          @click="loadUsers"
          class="text-gray-400 hover:text-white transition-colors"
          :class="{ 'animate-spin': loading }"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        <button
          @click="openAddModal"
          class="px-4 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors flex items-center gap-2"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
          </svg>
          {{ t('users.addUser') }}
        </button>
      </div>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Info Card -->
    <Card>
      <div class="flex items-start gap-4">
        <div class="p-3 bg-hytale-orange/20 rounded-lg">
          <svg class="w-6 h-6 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
        </div>
        <div class="flex-1">
          <h3 class="font-semibold text-white">{{ t('users.rolesInfo') }}</h3>
          <div class="text-sm text-gray-400 mt-2 space-y-1">
            <p><span class="text-status-error font-medium">Admin:</span> {{ t('users.adminDesc') }}</p>
            <p><span class="text-hytale-orange font-medium">Moderator:</span> {{ t('users.moderatorDesc') }}</p>
            <p><span class="text-blue-400 font-medium">Operator:</span> {{ t('users.operatorDesc') }}</p>
            <p><span class="text-gray-400 font-medium">Viewer:</span> {{ t('users.viewerDesc') }}</p>
          </div>
        </div>
      </div>
    </Card>

    <!-- Users List -->
    <Card :title="t('users.usersList') + ` (${users.length})`" :padding="false">
      <div v-if="loading" class="text-center text-gray-500 p-8">
        {{ t('common.loading') }}
      </div>

      <div v-else-if="users.length === 0" class="text-center text-gray-500 p-8">
        {{ t('users.noUsers') }}
      </div>

      <div v-else class="divide-y divide-dark-50/30">
        <div
          v-for="user in users"
          :key="user.username"
          class="flex items-center justify-between p-4 hover:bg-dark-50/20 transition-colors"
        >
          <div class="flex items-center gap-4">
            <!-- Avatar -->
            <div class="w-10 h-10 rounded-full flex items-center justify-center"
              :class="getRoleBadgeClass(user.role).replace('/20', '/30')"
            >
              <span class="font-bold text-lg">{{ user.username[0]?.toUpperCase() }}</span>
            </div>

            <!-- Info -->
            <div>
              <div class="flex items-center gap-2">
                <p class="font-medium text-white">{{ user.username }}</p>
                <span
                  :class="['px-2 py-0.5 rounded text-xs font-medium', getRoleBadgeClass(user.role)]"
                >
                  {{ t(`users.roles.${user.role}`) }}
                </span>
                <span v-if="user.username === authStore.username" class="text-xs text-gray-500">({{ t('users.you') }})</span>
              </div>
              <div class="flex items-center gap-4 text-sm text-gray-500 mt-0.5">
                <span>{{ t('users.created') }}: {{ formatDate(user.createdAt) }}</span>
                <span v-if="user.lastLogin">{{ t('users.lastLogin') }}: {{ formatDate(user.lastLogin) }}</span>
              </div>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-2">
            <button
              @click="openEditModal(user)"
              class="p-2 text-gray-400 hover:text-hytale-orange transition-colors"
              :title="t('common.edit')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              v-if="user.username !== authStore.username"
              @click="deleteUser(user)"
              class="p-2 text-gray-400 hover:text-status-error transition-colors"
              :title="t('common.delete')"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </Card>

    <!-- Add User Modal -->
    <div v-if="showAddModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-dark-200 rounded-xl p-6 w-full max-w-md mx-4">
        <h2 class="text-xl font-bold text-white mb-4">{{ t('users.addUser') }}</h2>

        <div v-if="formError" class="p-3 mb-4 bg-status-error/10 border border-status-error/20 rounded-lg">
          <p class="text-status-error text-sm">{{ formError }}</p>
        </div>

        <form @submit.prevent="addUser" class="space-y-4">
          <div>
            <label class="block text-sm text-gray-400 mb-1">{{ t('users.username') }}</label>
            <input
              v-model="formUsername"
              type="text"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
              :placeholder="t('users.usernamePlaceholder')"
            />
          </div>

          <div>
            <label class="block text-sm text-gray-400 mb-1">{{ t('users.password') }}</label>
            <input
              v-model="formPassword"
              type="password"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
              :placeholder="t('users.passwordPlaceholder')"
            />
          </div>

          <div>
            <label class="block text-sm text-gray-400 mb-1">{{ t('users.role') }}</label>
            <select
              v-model="formRole"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
            >
              <option value="viewer">{{ t('users.roles.viewer') }}</option>
              <option value="operator">{{ t('users.roles.operator') }}</option>
              <option value="moderator">{{ t('users.roles.moderator') }}</option>
              <option value="admin">{{ t('users.roles.admin') }}</option>
            </select>
          </div>

          <div class="flex gap-3 pt-2">
            <button
              type="button"
              @click="showAddModal = false"
              class="flex-1 px-4 py-2 bg-dark-100 text-gray-300 rounded-lg hover:bg-dark-50 transition-colors"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              type="submit"
              class="flex-1 px-4 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors"
            >
              {{ t('common.add') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit User Modal -->
    <div v-if="showEditModal && editingUser" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-dark-200 rounded-xl p-6 w-full max-w-md mx-4">
        <h2 class="text-xl font-bold text-white mb-4">{{ t('users.editUser') }}: {{ editingUser.username }}</h2>

        <div v-if="formError" class="p-3 mb-4 bg-status-error/10 border border-status-error/20 rounded-lg">
          <p class="text-status-error text-sm">{{ formError }}</p>
        </div>

        <form @submit.prevent="updateUser" class="space-y-4">
          <div>
            <label class="block text-sm text-gray-400 mb-1">{{ t('users.newPassword') }}</label>
            <input
              v-model="formPassword"
              type="password"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
              :placeholder="t('users.newPasswordPlaceholder')"
            />
            <p class="text-xs text-gray-500 mt-1">{{ t('users.leaveBlank') }}</p>
          </div>

          <div>
            <label class="block text-sm text-gray-400 mb-1">{{ t('users.role') }}</label>
            <select
              v-model="formRole"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white focus:outline-none focus:border-hytale-orange"
            >
              <option value="viewer">{{ t('users.roles.viewer') }}</option>
              <option value="operator">{{ t('users.roles.operator') }}</option>
              <option value="moderator">{{ t('users.roles.moderator') }}</option>
              <option value="admin">{{ t('users.roles.admin') }}</option>
            </select>
          </div>

          <div class="flex gap-3 pt-2">
            <button
              type="button"
              @click="showEditModal = false"
              class="flex-1 px-4 py-2 bg-dark-100 text-gray-300 rounded-lg hover:bg-dark-50 transition-colors"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              type="submit"
              class="flex-1 px-4 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors"
            >
              {{ t('common.save') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
