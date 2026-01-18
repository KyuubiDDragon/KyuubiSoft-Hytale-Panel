<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { rolesApi, type Role } from '@/api/roles'
import Card from '@/components/ui/Card.vue'

const { t } = useI18n()
const authStore = useAuthStore()

// State
const roles = ref<Role[]>([])
const loading = ref(true)
const error = ref('')
const availablePermissions = ref<Record<string, string>>({})

// Edit dialog state
const showEditModal = ref(false)
const editingRole = ref<Role | null>(null)
const isCreating = ref(false)

// Form state
const formName = ref('')
const formDescription = ref('')
const formColor = ref('gray')
const formPermissions = ref<string[]>([])
const formError = ref('')
const saving = ref(false)

// Predefined colors
const colorOptions = [
  { name: 'red', class: 'bg-red-500', textClass: 'text-red-500' },
  { name: 'orange', class: 'bg-orange-500', textClass: 'text-orange-500' },
  { name: 'yellow', class: 'bg-yellow-500', textClass: 'text-yellow-500' },
  { name: 'green', class: 'bg-green-500', textClass: 'text-green-500' },
  { name: 'blue', class: 'bg-blue-500', textClass: 'text-blue-500' },
  { name: 'purple', class: 'bg-purple-500', textClass: 'text-purple-500' },
  { name: 'gray', class: 'bg-gray-500', textClass: 'text-gray-500' },
]

// Group permissions by category
const groupedPermissions = computed(() => {
  const groups: Record<string, { key: string }[]> = {}

  for (const key of Object.keys(availablePermissions.value)) {
    const category = key.split('.')[0] || 'other'

    if (!groups[category]) {
      groups[category] = []
    }
    groups[category].push({ key })
  }

  // Sort categories alphabetically
  const sortedGroups: Record<string, { key: string }[]> = {}
  Object.keys(groups).sort().forEach(key => {
    sortedGroups[key] = groups[key].sort((a, b) => a.key.localeCompare(b.key))
  })

  return sortedGroups
})

const canManageRoles = computed(() => authStore.hasPermission('roles.manage'))

function getColorClass(color?: string): string {
  const option = colorOptions.find(c => c.name === color)
  return option?.class || 'bg-gray-500'
}

function getColorBadgeClass(color?: string): string {
  const colorMap: Record<string, string> = {
    red: 'bg-red-500/20 text-red-400',
    orange: 'bg-orange-500/20 text-orange-400',
    yellow: 'bg-yellow-500/20 text-yellow-400',
    green: 'bg-green-500/20 text-green-400',
    blue: 'bg-blue-500/20 text-blue-400',
    purple: 'bg-purple-500/20 text-purple-400',
    gray: 'bg-gray-500/20 text-gray-400',
  }
  return colorMap[color || 'gray'] || 'bg-gray-500/20 text-gray-400'
}

async function loadRoles() {
  loading.value = true
  error.value = ''
  try {
    const [rolesData, permissionsData] = await Promise.all([
      rolesApi.getAll(),
      rolesApi.getPermissions()
    ])
    roles.value = rolesData.roles
    availablePermissions.value = permissionsData.permissions
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

function openCreateModal() {
  isCreating.value = true
  editingRole.value = null
  formName.value = ''
  formDescription.value = ''
  formColor.value = 'gray'
  formPermissions.value = []
  formError.value = ''
  showEditModal.value = true
}

function openEditModal(role: Role) {
  isCreating.value = false
  editingRole.value = role
  formName.value = role.name
  formDescription.value = role.description
  formColor.value = role.color || 'gray'
  formPermissions.value = [...role.permissions]
  formError.value = ''
  showEditModal.value = true
}

// Handler for role card click - checks permission before opening edit modal
function handleRoleCardClick(role: Role) {
  if (canManageRoles.value) {
    openEditModal(role)
  }
}

function closeModal() {
  showEditModal.value = false
  editingRole.value = null
  isCreating.value = false
}

function togglePermission(permission: string) {
  if (formPermissions.value.includes(permission)) {
    formPermissions.value = formPermissions.value.filter(p => p !== permission)
  } else {
    formPermissions.value.push(permission)
  }
}

function selectAllPermissions() {
  formPermissions.value = Object.keys(availablePermissions.value)
}

function deselectAllPermissions() {
  formPermissions.value = []
}

async function saveRole() {
  formError.value = ''

  if (!formName.value.trim()) {
    formError.value = t('roles.nameRequired')
    return
  }

  saving.value = true

  try {
    const data = {
      name: formName.value.trim(),
      description: formDescription.value.trim(),
      permissions: formPermissions.value,
      color: formColor.value,
    }

    if (isCreating.value) {
      await rolesApi.create(data)
    } else if (editingRole.value) {
      // For system roles, only update permissions
      if (editingRole.value.isSystem) {
        await rolesApi.update(editingRole.value.id, { permissions: formPermissions.value })
      } else {
        await rolesApi.update(editingRole.value.id, data)
      }
    }

    closeModal()
    await loadRoles()
  } catch (e: any) {
    formError.value = e.response?.data?.error || t('errors.serverError')
  } finally {
    saving.value = false
  }
}

async function deleteRole(role: Role) {
  if (role.isSystem) return

  if (!confirm(t('roles.confirmDelete', { name: role.name }))) return

  try {
    await rolesApi.delete(role.id)
    await loadRoles()
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}

onMounted(loadRoles)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('roles.title') }}</h1>
        <p class="text-gray-400 mt-1">{{ t('roles.subtitle') }}</p>
      </div>
      <div class="flex gap-2">
        <button
          @click="loadRoles"
          class="text-gray-400 hover:text-white transition-colors"
          :class="{ 'animate-spin': loading }"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        <button
          v-if="canManageRoles"
          @click="openCreateModal"
          class="px-4 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors flex items-center gap-2"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          {{ t('roles.createRole') }}
        </button>
      </div>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="flex justify-center py-12">
      <div class="text-gray-400">{{ t('common.loading') }}</div>
    </div>

    <!-- Roles Grid -->
    <div v-else-if="roles.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div
        v-for="role in roles"
        :key="role.id"
        @click="handleRoleCardClick(role)"
        :class="[
          'bg-dark-200 rounded-xl p-5 transition-colors border border-transparent',
          canManageRoles ? 'cursor-pointer hover:bg-dark-100 hover:border-dark-50' : ''
        ]"
      >
        <!-- Role Header -->
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-3">
            <!-- Color Indicator -->
            <div
              :class="['w-3 h-3 rounded-full', getColorClass(role.color)]"
            ></div>
            <!-- Name -->
            <h3 class="font-semibold text-white">{{ role.name }}</h3>
          </div>
          <!-- Badges -->
          <div class="flex items-center gap-2">
            <span
              v-if="role.isSystem"
              class="flex items-center gap-1 px-2 py-0.5 bg-blue-500/20 text-blue-400 text-xs rounded"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              {{ t('roles.system') }}
            </span>
            <span
              :class="['px-2 py-0.5 rounded text-xs', getColorBadgeClass(role.color)]"
            >
              {{ role.color || 'gray' }}
            </span>
          </div>
        </div>

        <!-- Description -->
        <p class="text-gray-400 text-sm mb-4 line-clamp-2">
          {{ role.description || t('roles.noDescription') }}
        </p>

        <!-- Footer -->
        <div class="flex items-center justify-between text-sm">
          <div class="flex items-center gap-1 text-gray-500">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <span>{{ role.permissions.length }} {{ t('roles.permissions') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="!role.isSystem && canManageRoles"
              @click.stop="deleteRole(role)"
              class="p-1.5 text-gray-400 hover:text-status-error transition-colors"
              :title="t('common.delete')"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <Card v-else>
      <div class="text-center py-8">
        <svg class="w-12 h-12 text-gray-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        <p class="text-gray-400">{{ t('roles.noRoles') }}</p>
      </div>
    </Card>

    <!-- Edit/Create Role Modal -->
    <div v-if="showEditModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-dark-200 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <!-- Modal Header -->
        <div class="p-6 border-b border-dark-50">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <h2 class="text-xl font-bold text-white">
                {{ isCreating ? t('roles.createRole') : t('roles.editRole') }}
              </h2>
              <span
                v-if="editingRole?.isSystem"
                class="flex items-center gap-1 px-2 py-0.5 bg-blue-500/20 text-blue-400 text-xs rounded"
              >
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                {{ t('roles.system') }}
              </span>
            </div>
            <button
              @click="closeModal"
              class="text-gray-400 hover:text-white transition-colors"
            >
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p v-if="editingRole?.isSystem" class="text-sm text-gray-500 mt-2">
            {{ t('roles.systemRoleNote') }}
          </p>
        </div>

        <!-- Modal Body -->
        <div class="p-6 overflow-y-auto flex-1">
          <!-- Error Message -->
          <div v-if="formError" class="p-3 mb-4 bg-status-error/10 border border-status-error/20 rounded-lg">
            <p class="text-status-error text-sm">{{ formError }}</p>
          </div>

          <form @submit.prevent="saveRole" class="space-y-6">
            <!-- Basic Info -->
            <div class="space-y-4">
              <!-- Name -->
              <div>
                <label class="block text-sm text-gray-400 mb-1">{{ t('roles.name') }}</label>
                <input
                  v-model="formName"
                  type="text"
                  :disabled="editingRole?.isSystem"
                  class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange disabled:opacity-50 disabled:cursor-not-allowed"
                  :placeholder="t('roles.namePlaceholder')"
                />
              </div>

              <!-- Description -->
              <div>
                <label class="block text-sm text-gray-400 mb-1">{{ t('roles.description') }}</label>
                <textarea
                  v-model="formDescription"
                  rows="2"
                  :disabled="editingRole?.isSystem"
                  class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange resize-none disabled:opacity-50 disabled:cursor-not-allowed"
                  :placeholder="t('roles.descriptionPlaceholder')"
                />
              </div>

              <!-- Color Picker -->
              <div>
                <label class="block text-sm text-gray-400 mb-2">{{ t('roles.color') }}</label>
                <div class="flex gap-2">
                  <button
                    v-for="color in colorOptions"
                    :key="color.name"
                    type="button"
                    :disabled="editingRole?.isSystem"
                    @click="formColor = color.name"
                    :class="[
                      'w-8 h-8 rounded-lg transition-all',
                      color.class,
                      formColor === color.name ? 'ring-2 ring-white ring-offset-2 ring-offset-dark-200' : '',
                      editingRole?.isSystem ? 'opacity-50 cursor-not-allowed' : 'hover:scale-110'
                    ]"
                    :title="color.name"
                  />
                </div>
              </div>
            </div>

            <!-- Permissions -->
            <div>
              <div class="flex items-center justify-between mb-3">
                <label class="text-sm text-gray-400">{{ t('roles.permissions') }}</label>
                <div class="flex gap-2">
                  <button
                    type="button"
                    @click="selectAllPermissions"
                    class="px-3 py-1 text-xs bg-dark-100 text-gray-400 rounded hover:text-white transition-colors"
                  >
                    {{ t('roles.selectAll') }}
                  </button>
                  <button
                    type="button"
                    @click="deselectAllPermissions"
                    class="px-3 py-1 text-xs bg-dark-100 text-gray-400 rounded hover:text-white transition-colors"
                  >
                    {{ t('roles.deselectAll') }}
                  </button>
                </div>
              </div>

              <div class="space-y-4 max-h-64 overflow-y-auto p-3 bg-dark-100 rounded-lg">
                <div v-for="(permissions, category) in groupedPermissions" :key="category">
                  <h4 class="text-sm font-medium text-white mb-2">{{ t('permissionCategories.' + category) }}</h4>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label
                      v-for="perm in permissions"
                      :key="perm.key"
                      class="flex items-start gap-2 p-2 rounded hover:bg-dark-50 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        :checked="formPermissions.includes(perm.key)"
                        @change="togglePermission(perm.key)"
                        class="sr-only peer"
                      />
                      <div class="w-5 h-5 bg-dark-50 rounded peer-checked:bg-hytale-orange flex items-center justify-center flex-shrink-0 mt-0.5">
                        <svg v-if="formPermissions.includes(perm.key)" class="w-3 h-3 text-dark" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                      <div class="flex-1 min-w-0">
                        <span class="text-sm text-white font-mono">{{ perm.key }}</span>
                        <p class="text-xs text-gray-500 truncate">{{ t('permissionDescriptions.' + perm.key) }}</p>
                      </div>
                    </label>
                  </div>
                </div>

                <div v-if="Object.keys(groupedPermissions).length === 0" class="text-center py-4 text-gray-500">
                  {{ t('roles.noPermissionsAvailable') }}
                </div>
              </div>

              <p class="mt-2 text-xs text-gray-500">
                {{ formPermissions.length }} {{ t('roles.permissionsSelected') }}
              </p>
            </div>
          </form>
        </div>

        <!-- Modal Footer -->
        <div class="p-6 border-t border-dark-50 flex gap-3">
          <button
            type="button"
            @click="closeModal"
            class="flex-1 px-4 py-2 bg-dark-100 text-gray-300 rounded-lg hover:bg-dark-50 transition-colors"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            v-if="authStore.hasPermission('roles.manage')"
            @click="saveRole"
            :disabled="saving || !formName.trim()"
            class="flex-1 px-4 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ saving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
