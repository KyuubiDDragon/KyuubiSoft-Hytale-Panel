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
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const showPassword = ref(false)
const showConfirmPassword = ref(false)

// Validation state
const usernameError = ref('')
const passwordError = ref('')
const confirmPasswordError = ref('')

// Password strength
const passwordStrength = computed(() => {
  const pwd = password.value
  if (!pwd) return { level: 0, label: '', class: '' }

  let score = 0

  // Length
  if (pwd.length >= 8) score++
  if (pwd.length >= 12) score++
  if (pwd.length >= 16) score++

  // Character types
  if (/[a-z]/.test(pwd)) score++
  if (/[A-Z]/.test(pwd)) score++
  if (/[0-9]/.test(pwd)) score++
  if (/[^a-zA-Z0-9]/.test(pwd)) score++

  if (score <= 2) {
    return { level: 1, label: t('setup.passwordWeak'), class: 'bg-status-error' }
  } else if (score <= 4) {
    return { level: 2, label: t('setup.passwordMedium'), class: 'bg-status-warning' }
  } else {
    return { level: 3, label: t('setup.passwordStrong'), class: 'bg-status-success' }
  }
})

// Validation functions
function validateUsername(): boolean {
  usernameError.value = ''

  if (!username.value) {
    usernameError.value = t('setup.usernameRequired')
    return false
  }

  if (username.value.length < 3) {
    usernameError.value = t('setup.usernameTooShort')
    return false
  }

  if (username.value.length > 32) {
    usernameError.value = t('setup.usernameTooLong')
    return false
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username.value)) {
    usernameError.value = t('setup.usernameInvalid')
    return false
  }

  return true
}

function validatePassword(): boolean {
  passwordError.value = ''

  if (!password.value) {
    passwordError.value = t('setup.passwordRequired')
    return false
  }

  if (password.value.length < 12) {
    passwordError.value = t('setup.passwordTooShort')
    return false
  }

  return true
}

function validateConfirmPassword(): boolean {
  confirmPasswordError.value = ''

  if (!confirmPassword.value) {
    confirmPasswordError.value = t('setup.confirmPasswordRequired')
    return false
  }

  if (confirmPassword.value !== password.value) {
    confirmPasswordError.value = t('setup.passwordsDoNotMatch')
    return false
  }

  return true
}

// Watch for changes to clear errors
watch(username, () => {
  if (usernameError.value) validateUsername()
})

watch(password, () => {
  if (passwordError.value) validatePassword()
  if (confirmPasswordError.value && confirmPassword.value) validateConfirmPassword()
})

watch(confirmPassword, () => {
  if (confirmPasswordError.value) validateConfirmPassword()
})

const isFormValid = computed(() => {
  return (
    username.value &&
    password.value &&
    confirmPassword.value &&
    password.value === confirmPassword.value &&
    password.value.length >= 12 &&
    username.value.length >= 3 &&
    username.value.length <= 32 &&
    /^[a-zA-Z0-9_]+$/.test(username.value)
  )
})

const passwordsMatch = computed(() => {
  return confirmPassword.value && password.value === confirmPassword.value
})

async function handleSubmit() {
  // Validate all fields
  const isUsernameValid = validateUsername()
  const isPasswordValid = validatePassword()
  const isConfirmValid = validateConfirmPassword()

  if (!isUsernameValid || !isPasswordValid || !isConfirmValid) {
    return
  }

  const success = await setupStore.createAdmin({
    username: username.value,
    password: password.value,
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
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.createAdminTitle') }}</h2>
      <p class="text-gray-400">{{ t('setup.createAdminDescription') }}</p>
    </div>

    <!-- Form -->
    <form @submit.prevent="handleSubmit" class="space-y-5">
      <!-- Username -->
      <div>
        <label class="label">{{ t('setup.username') }}</label>
        <Input
          v-model="username"
          type="text"
          :placeholder="t('setup.usernamePlaceholder')"
          :error="usernameError"
          autocomplete="username"
          @blur="validateUsername"
        />
        <p v-if="!usernameError" class="mt-1 text-xs text-gray-500">
          {{ t('setup.usernameHint') }}
        </p>
      </div>

      <!-- Password -->
      <div>
        <label class="label">{{ t('setup.password') }}</label>
        <div class="relative">
          <Input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="t('setup.passwordPlaceholder')"
            :error="passwordError"
            autocomplete="new-password"
            @blur="validatePassword"
          />
          <button
            type="button"
            @click="showPassword = !showPassword"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
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

        <!-- Password Strength Indicator -->
        <div v-if="password" class="mt-2">
          <div class="flex items-center gap-2">
            <div class="flex-1 h-1.5 bg-dark-50 rounded-full overflow-hidden">
              <div
                class="h-full transition-all duration-300"
                :class="passwordStrength.class"
                :style="{ width: `${(passwordStrength.level / 3) * 100}%` }"
              />
            </div>
            <span
              class="text-xs font-medium"
              :class="{
                'text-status-error': passwordStrength.level === 1,
                'text-status-warning': passwordStrength.level === 2,
                'text-status-success': passwordStrength.level === 3,
              }"
            >
              {{ passwordStrength.label }}
            </span>
          </div>
        </div>

        <p v-if="!passwordError" class="mt-1 text-xs text-gray-500">
          {{ t('setup.passwordHint') }}
        </p>
      </div>

      <!-- Confirm Password -->
      <div>
        <label class="label">{{ t('setup.confirmPassword') }}</label>
        <div class="relative">
          <Input
            v-model="confirmPassword"
            :type="showConfirmPassword ? 'text' : 'password'"
            :placeholder="t('setup.confirmPasswordPlaceholder')"
            :error="confirmPasswordError"
            autocomplete="new-password"
            @blur="validateConfirmPassword"
          />
          <button
            type="button"
            @click="showConfirmPassword = !showConfirmPassword"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
          >
            <svg v-if="showConfirmPassword" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
            <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
        </div>

        <!-- Match Indicator -->
        <div v-if="confirmPassword && !confirmPasswordError" class="mt-2 flex items-center gap-2">
          <svg
            v-if="passwordsMatch"
            class="w-4 h-4 text-status-success"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <svg
            v-else
            class="w-4 h-4 text-status-error"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span
            class="text-xs"
            :class="passwordsMatch ? 'text-status-success' : 'text-status-error'"
          >
            {{ passwordsMatch ? t('setup.passwordsMatch') : t('setup.passwordsDoNotMatch') }}
          </span>
        </div>
      </div>

      <!-- Security Notice -->
      <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-hytale-orange mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <div class="text-sm text-gray-400">
            <p class="font-medium text-gray-300 mb-1">{{ t('setup.securityNoticeTitle') }}</p>
            <p>{{ t('setup.securityNoticeText') }}</p>
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
          {{ t('setup.createAccount') }}
          <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
        </Button>
      </div>
    </form>
  </div>
</template>
