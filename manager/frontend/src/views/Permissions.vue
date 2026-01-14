<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { permissionsApi, type PermissionUser, type PermissionGroup } from '@/api/management'
import Card from '@/components/ui/Card.vue'

const { t } = useI18n()

// State
const users = ref<PermissionUser[]>([])
const groups = ref<PermissionGroup[]>([])
const loading = ref(true)
const error = ref('')

// Active tab
const activeTab = ref<'users' | 'groups'>('users')

// User form
const newUserName = ref('')
const newUserGroups = ref<string[]>([])
const editingUser = ref<string | null>(null)

// Group form
const newGroupName = ref('')
const newGroupPermissions = ref('')
const newGroupInherits = ref<string[]>([])
const editingGroup = ref<string | null>(null)

// Search
const userSearch = ref('')
const groupSearch = ref('')

const filteredUsers = computed(() => {
  if (!userSearch.value) return users.value
  const search = userSearch.value.toLowerCase()
  return users.value.filter(u => u.name.toLowerCase().includes(search))
})

const filteredGroups = computed(() => {
  if (!groupSearch.value) return groups.value
  const search = groupSearch.value.toLowerCase()
  return groups.value.filter(g => g.name.toLowerCase().includes(search))
})

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const data = await permissionsApi.get()
    users.value = data.users
    groups.value = data.groups
  } catch (e) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

async function saveUser() {
  if (!newUserName.value.trim()) return
  try {
    const result = await permissionsApi.addUser(newUserName.value.trim(), newUserGroups.value)
    users.value = result.users
    newUserName.value = ''
    newUserGroups.value = []
    editingUser.value = null
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function removeUser(name: string) {
  try {
    const result = await permissionsApi.removeUser(name)
    users.value = result.users
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

function editUser(user: PermissionUser) {
  newUserName.value = user.name
  newUserGroups.value = [...user.groups]
  editingUser.value = user.name
}

function cancelEditUser() {
  newUserName.value = ''
  newUserGroups.value = []
  editingUser.value = null
}

async function saveGroup() {
  if (!newGroupName.value.trim()) return
  try {
    const permissions = newGroupPermissions.value
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.length > 0)
    const result = await permissionsApi.addGroup(
      newGroupName.value.trim(),
      permissions,
      newGroupInherits.value.length > 0 ? newGroupInherits.value : undefined
    )
    groups.value = result.groups
    newGroupName.value = ''
    newGroupPermissions.value = ''
    newGroupInherits.value = []
    editingGroup.value = null
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

async function removeGroup(name: string) {
  try {
    const result = await permissionsApi.removeGroup(name)
    groups.value = result.groups
  } catch (e) {
    error.value = t('errors.serverError')
  }
}

function editGroup(group: PermissionGroup) {
  newGroupName.value = group.name
  newGroupPermissions.value = group.permissions.join('\n')
  newGroupInherits.value = group.inherits || []
  editingGroup.value = group.name
}

function cancelEditGroup() {
  newGroupName.value = ''
  newGroupPermissions.value = ''
  newGroupInherits.value = []
  editingGroup.value = null
}

function toggleUserGroup(groupName: string) {
  if (newUserGroups.value.includes(groupName)) {
    newUserGroups.value = newUserGroups.value.filter(g => g !== groupName)
  } else {
    newUserGroups.value.push(groupName)
  }
}

function toggleGroupInherit(groupName: string) {
  if (newGroupInherits.value.includes(groupName)) {
    newGroupInherits.value = newGroupInherits.value.filter(g => g !== groupName)
  } else {
    newGroupInherits.value.push(groupName)
  }
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-6">
    <!-- Page Title -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">{{ t('permissions.title') }}</h1>
      <button
        @click="loadData"
        class="text-gray-400 hover:text-white transition-colors"
        :class="{ 'animate-spin': loading }"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2">
      <button
        @click="activeTab = 'users'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors',
          activeTab === 'users'
            ? 'bg-hytale-orange text-dark'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        {{ t('permissions.users') }}
      </button>
      <button
        @click="activeTab = 'groups'"
        :class="[
          'px-4 py-2 rounded-lg font-medium transition-colors',
          activeTab === 'groups'
            ? 'bg-hytale-orange text-dark'
            : 'bg-dark-100 text-gray-400 hover:text-white'
        ]"
      >
        {{ t('permissions.groups') }}
      </button>
    </div>

    <!-- Users Tab -->
    <div v-if="activeTab === 'users'" class="space-y-6">
      <!-- Add/Edit User -->
      <Card>
        <h3 class="font-semibold text-white mb-4">
          {{ editingUser ? t('permissions.editUser') : t('permissions.addUser') }}
        </h3>
        <form @submit.prevent="saveUser" class="space-y-4">
          <div>
            <label class="block text-sm text-gray-400 mb-2">{{ t('permissions.playerName') }}</label>
            <input
              v-model="newUserName"
              type="text"
              :placeholder="t('permissions.playerName')"
              :disabled="!!editingUser"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange disabled:opacity-50"
            />
          </div>

          <div>
            <label class="block text-sm text-gray-400 mb-2">{{ t('permissions.assignGroups') }}</label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="group in groups"
                :key="group.name"
                type="button"
                @click="toggleUserGroup(group.name)"
                :class="[
                  'px-3 py-1.5 rounded-lg text-sm transition-colors',
                  newUserGroups.includes(group.name)
                    ? 'bg-hytale-orange text-dark'
                    : 'bg-dark-100 text-gray-400 hover:text-white'
                ]"
              >
                {{ group.name }}
              </button>
              <span v-if="groups.length === 0" class="text-gray-500 text-sm">
                {{ t('permissions.noGroups') }}
              </span>
            </div>
          </div>

          <div class="flex gap-3">
            <button
              type="submit"
              :disabled="!newUserName.trim()"
              class="px-6 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ t('common.save') }}
            </button>
            <button
              v-if="editingUser"
              type="button"
              @click="cancelEditUser"
              class="px-6 py-2 bg-dark-100 text-gray-400 font-medium rounded-lg hover:text-white transition-colors"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </form>
      </Card>

      <!-- Users List -->
      <Card>
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold text-white">{{ t('permissions.usersList') }} ({{ users.length }})</h3>
          <input
            v-model="userSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange text-sm"
          />
        </div>

        <div v-if="loading" class="text-center py-8 text-gray-400">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="filteredUsers.length === 0" class="text-center py-8 text-gray-400">
          {{ t('permissions.noUsers') }}
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="user in filteredUsers"
            :key="user.name"
            class="flex items-center justify-between p-3 bg-dark-100 rounded-lg"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-hytale-orange/20 rounded-full flex items-center justify-center">
                <span class="text-hytale-orange font-medium">{{ user.name[0]?.toUpperCase() }}</span>
              </div>
              <div>
                <p class="text-white font-medium">{{ user.name }}</p>
                <p v-if="user.uuid" class="text-xs text-gray-500 font-mono">{{ user.uuid }}</p>
                <div class="flex flex-wrap gap-1 mt-1">
                  <span
                    v-for="group in user.groups"
                    :key="group"
                    class="px-2 py-0.5 bg-dark-50 text-gray-300 text-xs rounded"
                  >
                    {{ group }}
                  </span>
                  <span v-if="user.groups.length === 0" class="text-xs text-gray-500">
                    {{ t('permissions.noGroupsAssigned') }}
                  </span>
                </div>
              </div>
            </div>
            <div class="flex gap-2">
              <button
                @click="editUser(user)"
                class="p-2 text-gray-400 hover:text-hytale-orange transition-colors"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                @click="removeUser(user.name)"
                class="p-2 text-gray-400 hover:text-status-error transition-colors"
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
      <Card>
        <h3 class="font-semibold text-white mb-4">
          {{ editingGroup ? t('permissions.editGroup') : t('permissions.addGroup') }}
        </h3>
        <form @submit.prevent="saveGroup" class="space-y-4">
          <div>
            <label class="block text-sm text-gray-400 mb-2">{{ t('permissions.groupName') }}</label>
            <input
              v-model="newGroupName"
              type="text"
              :placeholder="t('permissions.groupName')"
              :disabled="!!editingGroup"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange disabled:opacity-50"
            />
          </div>

          <div>
            <label class="block text-sm text-gray-400 mb-2">{{ t('permissions.permissions') }}</label>
            <textarea
              v-model="newGroupPermissions"
              :placeholder="t('permissions.permissionsPlaceholder')"
              rows="4"
              class="w-full px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange font-mono text-sm"
            />
          </div>

          <div>
            <label class="block text-sm text-gray-400 mb-2">{{ t('permissions.inheritsFrom') }}</label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="group in groups.filter(g => g.name !== newGroupName)"
                :key="group.name"
                type="button"
                @click="toggleGroupInherit(group.name)"
                :class="[
                  'px-3 py-1.5 rounded-lg text-sm transition-colors',
                  newGroupInherits.includes(group.name)
                    ? 'bg-hytale-orange text-dark'
                    : 'bg-dark-100 text-gray-400 hover:text-white'
                ]"
              >
                {{ group.name }}
              </button>
            </div>
          </div>

          <div class="flex gap-3">
            <button
              type="submit"
              :disabled="!newGroupName.trim()"
              class="px-6 py-2 bg-hytale-orange text-dark font-medium rounded-lg hover:bg-hytale-yellow transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ t('common.save') }}
            </button>
            <button
              v-if="editingGroup"
              type="button"
              @click="cancelEditGroup"
              class="px-6 py-2 bg-dark-100 text-gray-400 font-medium rounded-lg hover:text-white transition-colors"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </form>
      </Card>

      <!-- Groups List -->
      <Card>
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold text-white">{{ t('permissions.groupsList') }} ({{ groups.length }})</h3>
          <input
            v-model="groupSearch"
            type="text"
            :placeholder="t('common.search')"
            class="px-3 py-1.5 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange text-sm"
          />
        </div>

        <div v-if="loading" class="text-center py-8 text-gray-400">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="filteredGroups.length === 0" class="text-center py-8 text-gray-400">
          {{ t('permissions.noGroups') }}
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="group in filteredGroups"
            :key="group.name"
            class="p-4 bg-dark-100 rounded-lg"
          >
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 bg-hytale-yellow/20 rounded-full flex items-center justify-center">
                  <svg class="w-4 h-4 text-hytale-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <span class="text-white font-medium">{{ group.name }}</span>
              </div>
              <div class="flex gap-2">
                <button
                  @click="editGroup(group)"
                  class="p-2 text-gray-400 hover:text-hytale-orange transition-colors"
                >
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  @click="removeGroup(group.name)"
                  class="p-2 text-gray-400 hover:text-status-error transition-colors"
                >
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>

            <div v-if="group.inherits && group.inherits.length > 0" class="mb-2">
              <span class="text-xs text-gray-500">{{ t('permissions.inheritsFrom') }}:</span>
              <span
                v-for="inherit in group.inherits"
                :key="inherit"
                class="ml-2 px-2 py-0.5 bg-dark-50 text-gray-300 text-xs rounded"
              >
                {{ inherit }}
              </span>
            </div>

            <div v-if="group.permissions.length > 0">
              <p class="text-xs text-gray-500 mb-1">{{ t('permissions.permissions') }}:</p>
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="perm in group.permissions.slice(0, 10)"
                  :key="perm"
                  class="px-2 py-0.5 bg-dark-50 text-gray-300 text-xs rounded font-mono"
                >
                  {{ perm }}
                </span>
                <span
                  v-if="group.permissions.length > 10"
                  class="px-2 py-0.5 bg-dark-50 text-gray-400 text-xs rounded"
                >
                  +{{ group.permissions.length - 10 }} {{ t('permissions.more') }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
