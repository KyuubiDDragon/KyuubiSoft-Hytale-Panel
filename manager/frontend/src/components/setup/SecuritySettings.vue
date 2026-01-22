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
const serverPassword = ref('')
const showPassword = ref(false)
const whitelistEnabled = ref(true)
const allowOperator = ref(true)

// Validation state
const passwordError = ref('')

// Validation functions
function validatePassword(): boolean {
  passwordError.value = ''

  // Password is optional, but if provided, it must be at least 4 characters
  if (serverPassword.value && serverPassword.value.length < 4) {
    passwordError.value = t('setup.serverPasswordTooShort')
    return false
  }

  if (serverPassword.value && serverPassword.value.length > 32) {
    passwordError.value = t('setup.serverPasswordTooLong')
    return false
  }

  return true
}

// Watch for changes to clear errors
watch(serverPassword, () => {
  if (passwordError.value) validatePassword()
})

const isFormValid = computed(() => {
  return !serverPassword.value || (serverPassword.value.length >= 4 && serverPassword.value.length <= 32)
})

async function handleSubmit() {
  const isPasswordValid = validatePassword()

  if (!isPasswordValid) {
    return
  }

  const success = await setupStore.saveStep('security-settings', {
    password: serverPassword.value || null,
    whitelist: whitelistEnabled.value,
    allowOp: allowOperator.value,
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
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.securitySettingsTitle') }}</h2>
      <p class="text-gray-400">{{ t('setup.securitySettingsDescription') }}</p>
    </div>

    <!-- Form -->
    <form @submit.prevent="handleSubmit" class="space-y-5">
      <!-- Server Password -->
      <div>
        <label class="label">{{ t('setup.serverPassword') }}</label>
        <div class="relative">
          <Input
            v-model="serverPassword"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="t('setup.serverPasswordPlaceholder')"
            :error="passwordError"
            @blur="validatePassword"
          />
          <button
            type="button"
            @click="showPassword = !showPassword"
            class="absolute right-3 top-3 text-gray-400 hover:text-white"
          >
            <svg v-if="showPassword" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
            <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
        </div>
        <p v-if="!passwordError" class="mt-1 text-xs text-gray-500">
          {{ t('setup.serverPasswordHint') }}
        </p>
      </div>

      <!-- Whitelist Toggle -->
      <div class="p-4 bg-dark-200 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-4">
          <div class="flex-shrink-0 pt-1">
            <button
              type="button"
              @click="whitelistEnabled = !whitelistEnabled"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
              :class="whitelistEnabled ? 'bg-hytale-orange' : 'bg-dark-50'"
            >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                :class="whitelistEnabled ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <span class="font-medium text-white">{{ t('setup.whitelistEnabled') }}</span>
              <span class="text-xs px-2 py-0.5 rounded-full bg-status-success/20 text-status-success">
                {{ t('setup.recommended') }}
              </span>
            </div>
            <p class="mt-1 text-sm text-gray-400">
              {{ t('setup.whitelistDescription') }}
            </p>
          </div>
          <div class="flex-shrink-0">
            <svg class="w-5 h-5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
        </div>
      </div>

      <!-- Allow Operator Toggle -->
      <div class="p-4 bg-dark-200 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-4">
          <div class="flex-shrink-0 pt-1">
            <button
              type="button"
              @click="allowOperator = !allowOperator"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
              :class="allowOperator ? 'bg-hytale-orange' : 'bg-dark-50'"
            >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                :class="allowOperator ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <span class="font-medium text-white">{{ t('setup.allowOperator') }}</span>
            </div>
            <p class="mt-1 text-sm text-gray-400">
              {{ t('setup.allowOperatorDescription') }}
            </p>
          </div>
          <div class="flex-shrink-0">
            <svg class="w-5 h-5 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
        </div>

        <!-- Warning when enabled -->
        <div v-if="allowOperator" class="mt-3 p-3 bg-status-warning/10 rounded-lg border border-status-warning/20">
          <div class="flex items-start gap-2">
            <svg class="w-4 h-4 text-status-warning mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p class="text-xs text-status-warning">
              {{ t('setup.allowOperatorWarning') }}
            </p>
          </div>
        </div>
      </div>

      <!-- Security Best Practices -->
      <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-hytale-orange mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <div class="text-sm text-gray-400">
            <p class="font-medium text-gray-300 mb-1">{{ t('setup.securityTipsTitle') }}</p>
            <ul class="list-disc list-inside space-y-1">
              <li>{{ t('setup.securityTip1') }}</li>
              <li>{{ t('setup.securityTip2') }}</li>
              <li>{{ t('setup.securityTip3') }}</li>
            </ul>
          </div>
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
