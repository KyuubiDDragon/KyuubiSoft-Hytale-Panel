<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { rolesApi, type Role } from '@/api/roles'
import Button from '@/components/ui/Button.vue'
import Icon from '@/components/ui/Icon.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import ErrorState from '@/components/ui/ErrorState.vue'
import EmptyTableState from '@/components/ui/EmptyTableState.vue'
import ResponsiveTable, { type TableColumn } from '@/components/ui/ResponsiveTable.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

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

const colorOptions = [
  { name: 'red', class: 'bg-red-500', textClass: 'text-red-500' },
  { name: 'orange', class: 'bg-orange-500', textClass: 'text-orange-500' },
  { name: 'yellow', class: 'bg-yellow-500', textClass: 'text-yellow-500' },
  { name: 'green', class: 'bg-green-500', textClass: 'text-green-500' },
  { name: 'blue', class: 'bg-blue-500', textClass: 'text-blue-500' },
  { name: 'purple', class: 'bg-purple-500', textClass: 'text-purple-500' },
  { name: 'gray', class: 'bg-gray-500', textClass: 'text-ink-subtle' },
]

const columns = computed<TableColumn[]>(() => [
  { key: 'name', label: t('roles.name') },
  { key: 'description', label: t('roles.description') },
  { key: 'permissions', label: t('roles.permissions'), align: 'center', width: '10rem' },
  { key: 'type', label: t('roles.type'), align: 'center', width: '8rem' },
])

const groupedPermissions = computed(() => {
  const groups: Record<string, { key: string }[]> = {}

  for (const key of Object.keys(availablePermissions.value)) {
    const category = key.split('.')[0] || 'other'

    if (!groups[category]) {
      groups[category] = []
    }
    groups[category].push({ key })
  }

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

async function loadRoles() {
  loading.value = true
  error.value = ''
  try {
    const [rolesData, permissionsData] = await Promise.all([
      rolesApi.getAll(),
      rolesApi.getPermissions(),
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

// Role deletion uses ConfirmDialog instead of window.confirm — keeps the
// modal style consistent with the rest of the admin views.
const pendingDeleteRole = ref<Role | null>(null)

function askDeleteRole(role: Role) {
  if (role.isSystem) return
  pendingDeleteRole.value = role
}

async function confirmDeleteRole() {
  const role = pendingDeleteRole.value
  pendingDeleteRole.value = null
  if (!role) return
  try {
    await rolesApi.delete(role.id)
    await loadRoles()
  } catch (e: any) {
    error.value = e.response?.data?.error || t('errors.serverError')
  }
}

onMounted(loadRoles)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-ink">{{ t('roles.title') }}</h1>
        <p class="text-ink-muted mt-1">{{ t('roles.subtitle') }}</p>
      </div>
      <div class="flex gap-2">
        <button
          @click="loadRoles"
          class="p-2 text-ink-muted hover:text-ink transition-colors min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
          :class="{ 'animate-spin': loading }"
          :aria-label="t('common.refresh')"
        >
          <Icon name="refresh" class="w-5 h-5" />
        </button>
        <Button v-if="canManageRoles" @click="openCreateModal" class="flex items-center gap-2">
          <Icon name="plus" class="w-5 h-5" />
          {{ t('roles.createRole') }}
        </Button>
      </div>
    </div>

    <ErrorState
      v-if="error && roles.length === 0"
      :message="error"
      @retry="loadRoles"
    />

    <div v-else-if="loading && roles.length === 0" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" height="4rem" />
    </div>

    <EmptyTableState
      v-else-if="roles.length === 0"
      icon="shield"
      :title="t('roles.noRoles')"
      :subtitle="t('roles.noRolesSubtitle')"
    >
      <Button v-if="canManageRoles" size="sm" @click="openCreateModal">
        {{ t('roles.createRole') }}
      </Button>
    </EmptyTableState>

    <ResponsiveTable
      v-else
      :columns="columns"
      :rows="roles"
      row-key="id"
      :aria-label="t('roles.title')"
      :mobile-card-label="(r) => r.name"
    >
      <template #cell:name="{ row }">
        <div class="flex items-center gap-3">
          <span :class="['w-3 h-3 rounded-full flex-shrink-0', getColorClass(row.color)]" />
          <span class="font-semibold text-ink">{{ row.name }}</span>
        </div>
      </template>
      <template #cell:description="{ row }">
        <span class="text-ink-muted">{{ row.description || t('roles.noDescription') }}</span>
      </template>
      <template #cell:permissions="{ row }">
        <span class="inline-flex items-center gap-1 text-sm text-ink-muted">
          <Icon name="shield" class="w-4 h-4" />
          {{ row.permissions.length }}
        </span>
      </template>
      <template #cell:type="{ row }">
        <span
          v-if="row.isSystem"
          class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/20 text-blue-400 text-xs rounded"
        >
          <Icon name="lock" class="w-3 h-3" />
          {{ t('roles.system') }}
        </span>
        <span v-else class="text-xs text-ink-subtle">{{ t('roles.customRole') }}</span>
      </template>
      <template #actions="{ row }">
        <Button
          v-if="canManageRoles"
          variant="ghost"
          size="sm"
          icon-only
          :aria-label="t('common.edit')"
          @click="openEditModal(row)"
        >
          <Icon name="edit" class="w-5 h-5" />
        </Button>
        <Button
          v-if="!row.isSystem && canManageRoles"
          variant="ghost"
          size="sm"
          icon-only
          class="!text-ink-muted hover:!text-status-error"
          :aria-label="t('common.delete')"
          @click="askDeleteRole(row)"
        >
          <Icon name="trash" class="w-5 h-5" />
        </Button>
      </template>
    </ResponsiveTable>

    <!-- Edit/Create Role Modal -->
    <div v-if="showEditModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-surface-raised rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <!-- Modal Header -->
        <div class="p-6 border-b border-border">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <h2 class="text-xl font-bold text-ink">
                {{ isCreating ? t('roles.createRole') : t('roles.editRole') }}
              </h2>
              <span
                v-if="editingRole?.isSystem"
                class="flex items-center gap-1 px-2 py-0.5 bg-blue-500/20 text-blue-400 text-xs rounded"
              >
                <Icon name="lock" class="w-3 h-3" />
                {{ t('roles.system') }}
              </span>
            </div>
            <button
              @click="closeModal"
              class="text-ink-muted hover:text-ink transition-colors"
              :aria-label="t('common.close')"
            >
              <Icon name="close" class="w-6 h-6" />
            </button>
          </div>
          <p v-if="editingRole?.isSystem" class="text-sm text-ink-subtle mt-2">
            {{ t('roles.systemRoleNote') }}
          </p>
        </div>

        <!-- Modal Body -->
        <div class="p-6 overflow-y-auto flex-1">
          <div v-if="formError" class="p-3 mb-4 bg-status-error/10 border border-status-error/20 rounded-lg">
            <p class="text-status-error text-sm">{{ formError }}</p>
          </div>

          <form @submit.prevent="saveRole" class="space-y-6">
            <div class="space-y-4">
              <div>
                <label class="block text-sm text-ink-muted mb-1">{{ t('roles.name') }}</label>
                <input
                  v-model="formName"
                  type="text"
                  :disabled="editingRole?.isSystem"
                  class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange disabled:opacity-50 disabled:cursor-not-allowed"
                  :placeholder="t('roles.namePlaceholder')"
                />
              </div>

              <div>
                <label class="block text-sm text-ink-muted mb-1">{{ t('roles.description') }}</label>
                <textarea
                  v-model="formDescription"
                  rows="2"
                  :disabled="editingRole?.isSystem"
                  class="w-full px-4 py-2 bg-surface-overlay border border-border rounded-lg text-ink placeholder-ink-subtle focus:outline-none focus:border-hytale-orange resize-none disabled:opacity-50 disabled:cursor-not-allowed"
                  :placeholder="t('roles.descriptionPlaceholder')"
                />
              </div>

              <div>
                <label class="block text-sm text-ink-muted mb-2">{{ t('roles.color') }}</label>
                <div class="flex gap-2 flex-wrap">
                  <button
                    v-for="color in colorOptions"
                    :key="color.name"
                    type="button"
                    :disabled="editingRole?.isSystem"
                    @click="formColor = color.name"
                    :class="[
                      'w-8 h-8 rounded-lg transition-all',
                      color.class,
                      formColor === color.name ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface-raised' : '',
                      editingRole?.isSystem ? 'opacity-50 cursor-not-allowed' : 'hover:scale-110',
                    ]"
                    :title="color.name"
                    :aria-label="color.name"
                  />
                </div>
              </div>
            </div>

            <div>
              <div class="flex items-center justify-between mb-3">
                <label class="text-sm text-ink-muted">{{ t('roles.permissions') }}</label>
                <div class="flex gap-2">
                  <button
                    type="button"
                    @click="selectAllPermissions"
                    class="px-3 py-1 text-xs bg-surface-overlay text-ink-muted rounded hover:text-ink transition-colors"
                  >
                    {{ t('roles.selectAll') }}
                  </button>
                  <button
                    type="button"
                    @click="deselectAllPermissions"
                    class="px-3 py-1 text-xs bg-surface-overlay text-ink-muted rounded hover:text-ink transition-colors"
                  >
                    {{ t('roles.deselectAll') }}
                  </button>
                </div>
              </div>

              <div class="space-y-4 max-h-64 overflow-y-auto p-3 bg-surface-overlay rounded-lg">
                <div v-for="(permissions, category) in groupedPermissions" :key="category">
                  <h4 class="text-sm font-medium text-ink mb-2">{{ t('permissionCategories.' + category) }}</h4>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label
                      v-for="perm in permissions"
                      :key="perm.key"
                      class="flex items-start gap-2 p-2 rounded hover:bg-surface-muted cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        :checked="formPermissions.includes(perm.key)"
                        @change="togglePermission(perm.key)"
                        class="sr-only peer"
                      />
                      <div class="w-5 h-5 bg-surface-muted rounded peer-checked:bg-hytale-orange flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Icon
                          v-if="formPermissions.includes(perm.key)"
                          name="check"
                          class="w-3 h-3 text-ink-inverse"
                        />
                      </div>
                      <div class="flex-1 min-w-0">
                        <span class="text-sm text-ink">{{ t('permissionDescriptions.' + perm.key) }}</span>
                        <p class="text-xs text-ink-subtle font-mono truncate">{{ perm.key }}</p>
                      </div>
                    </label>
                  </div>
                </div>

                <div v-if="Object.keys(groupedPermissions).length === 0" class="text-center py-4 text-ink-subtle">
                  {{ t('roles.noPermissionsAvailable') }}
                </div>
              </div>

              <p class="mt-2 text-xs text-ink-subtle">
                {{ formPermissions.length }} {{ t('roles.permissionsSelected') }}
              </p>
            </div>
          </form>
        </div>

        <!-- Modal Footer -->
        <div class="p-6 border-t border-border flex gap-3">
          <Button variant="secondary" type="button" @click="closeModal" class="flex-1">
            {{ t('common.cancel') }}
          </Button>
          <Button
            v-if="authStore.hasPermission('roles.manage')"
            @click="saveRole"
            :loading="saving"
            :disabled="saving || !formName.trim()"
            class="flex-1"
          >
            {{ saving ? t('common.saving') : t('common.save') }}
          </Button>
        </div>
      </div>
    </div>

    <!-- Role delete confirm (replaces window.confirm). -->
    <ConfirmDialog
      :show="!!pendingDeleteRole"
      :title="t('roles.confirmDeleteTitle')"
      :message="pendingDeleteRole ? t('roles.confirmDelete', { name: pendingDeleteRole.name }) : ''"
      :confirm-text="t('common.delete')"
      variant="danger"
      @confirm="confirmDeleteRole"
      @cancel="pendingDeleteRole = null"
    />
  </div>
</template>
