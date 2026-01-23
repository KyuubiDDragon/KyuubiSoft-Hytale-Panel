<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
  back: []
}>()

// Form state
const serverName = ref('My Hytale Server')
const motd = ref('Welcome to my server!')
const maxPlayers = ref(20)
const gameMode = ref('Adventure')

// Validation state
const serverNameError = ref('')
const motdError = ref('')

// Available options
const maxPlayersOptions = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
]

const gameModeOptions = [
  { value: 'Adventure', labelKey: 'setup.gameModeAdventure' },
  { value: 'Creative', labelKey: 'setup.gameModeCreative' },
  { value: 'Survival', labelKey: 'setup.gameModeSurvival' },
  { value: 'Spectator', labelKey: 'setup.gameModeSpectator' },
]

// Validation functions
function validateServerName(): boolean {
  serverNameError.value = ''

  if (!serverName.value.trim()) {
    serverNameError.value = t('setup.serverNameRequired')
    return false
  }

  if (serverName.value.length < 3) {
    serverNameError.value = t('setup.serverNameTooShort')
    return false
  }

  if (serverName.value.length > 64) {
    serverNameError.value = t('setup.serverNameTooLong')
    return false
  }

  return true
}

function validateMotd(): boolean {
  motdError.value = ''

  if (motd.value.length > 256) {
    motdError.value = t('setup.motdTooLong')
    return false
  }

  return true
}

// Watch for changes to clear errors
watch(serverName, () => {
  if (serverNameError.value) validateServerName()
})

watch(motd, () => {
  if (motdError.value) validateMotd()
})

const isFormValid = computed(() => {
  return (
    serverName.value.trim() &&
    serverName.value.length >= 3 &&
    serverName.value.length <= 64 &&
    motd.value.length <= 256
  )
})

async function handleSubmit() {
  const isServerNameValid = validateServerName()
  const isMotdValid = validateMotd()

  if (!isServerNameValid || !isMotdValid) {
    return
  }

  const success = await setupStore.saveStep('server-config', {
    name: serverName.value,
    motd: motd.value,
    maxPlayers: maxPlayers.value,
    gameMode: gameMode.value,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  emit('back')
}
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.serverConfigTitle') }}</h2>
      <p class="text-gray-400">{{ t('setup.serverConfigDescription') }}</p>
    </div>

    <!-- Form -->
    <form @submit.prevent="handleSubmit" class="space-y-5">
      <!-- Server Name -->
      <div>
        <label class="label">{{ t('setup.serverName') }}</label>
        <Input
          v-model="serverName"
          type="text"
          :placeholder="t('setup.serverNamePlaceholder')"
          :error="serverNameError"
          @blur="validateServerName"
        />
        <p v-if="!serverNameError" class="mt-1 text-xs text-gray-500">
          {{ t('setup.serverNameHint') }}
        </p>
      </div>

      <!-- MOTD -->
      <div>
        <label class="label">{{ t('setup.motd') }}</label>
        <div class="relative">
          <textarea
            v-model="motd"
            :placeholder="t('setup.motdPlaceholder')"
            class="input min-h-[100px] resize-none"
            :class="{ 'input-error': motdError }"
            @blur="validateMotd"
          />
          <span class="absolute bottom-2 right-2 text-xs text-gray-500">
            {{ motd.length }}/256
          </span>
        </div>
        <p v-if="motdError" class="mt-1 text-sm text-status-error">{{ motdError }}</p>
        <p v-else class="mt-1 text-xs text-gray-500">
          {{ t('setup.motdHint') }}
        </p>
      </div>

      <!-- Max Players -->
      <div>
        <label class="label">{{ t('setup.maxPlayers') }}</label>
        <div class="relative">
          <select
            v-model="maxPlayers"
            class="input appearance-none cursor-pointer pr-10"
          >
            <option
              v-for="option in maxPlayersOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }} {{ t('setup.players') }}
            </option>
          </select>
          <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
            <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
        <p class="mt-1 text-xs text-gray-500">
          {{ t('setup.maxPlayersHint') }}
        </p>
      </div>

      <!-- Game Mode -->
      <div>
        <label class="label">{{ t('setup.gameMode') }}</label>
        <div class="relative">
          <select
            v-model="gameMode"
            class="input appearance-none cursor-pointer pr-10"
          >
            <option
              v-for="option in gameModeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ t(option.labelKey) }}
            </option>
          </select>
          <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
            <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
        <p class="mt-1 text-xs text-gray-500">
          {{ t('setup.gameModeHint') }}
        </p>
      </div>

      <!-- Info Box -->
      <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-sm text-gray-400">{{ t('setup.serverConfigInfo') }}</p>
        </div>
      </div>

      <!-- Error Message -->
      <div v-if="setupStore.error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
        <p class="text-status-error text-sm">{{ setupStore.error }}</p>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-between pt-4">
        <Button type="button" variant="secondary" @click="handleBack">
          <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          {{ t('common.back') }}
        </Button>

        <Button
          type="submit"
          :loading="setupStore.isLoading"
          :disabled="!isFormValid"
        >
          {{ t('common.next') }}
          <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </Button>
      </div>
    </form>
  </div>
</template>
