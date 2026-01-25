<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useDemoStore } from '@/stores/demo'
import { setLocale, getLocale } from '@/i18n'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'

const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()
const demoStore = useDemoStore()

const username = ref('')
const password = ref('')
const error = ref('')
const infoMessage = ref('')
const loading = ref(false)
const demoLoading = ref<'demo' | 'admin' | null>(null)
const showPassword = ref(false)
const currentLocale = ref(getLocale())

// Check for logout message from session invalidation
onMounted(async () => {
  const logoutMessage = sessionStorage.getItem('logoutMessage')
  if (logoutMessage) {
    infoMessage.value = logoutMessage
    sessionStorage.removeItem('logoutMessage')
  }

  // Check if demo mode is enabled
  await demoStore.checkDemoMode()
})

function toggleLocale() {
  const newLocale = currentLocale.value === 'de' ? 'en' : 'de'
  setLocale(newLocale)
  currentLocale.value = newLocale
}

async function handleLogin() {
  error.value = ''
  loading.value = true

  try {
    await authStore.login({
      username: username.value,
      password: password.value,
    })
    router.push('/')
  } catch (err) {
    error.value = t('auth.invalidCredentials')
  } finally {
    loading.value = false
  }
}

async function handleDemoLogin(type: 'demo' | 'admin') {
  error.value = ''
  demoLoading.value = type

  try {
    const credentials = type === 'admin'
      ? { username: 'admin', password: 'admin' }
      : { username: 'demo', password: 'demo' }

    await authStore.login(credentials)
    router.push('/')
  } catch (err) {
    error.value = t('auth.invalidCredentials')
  } finally {
    demoLoading.value = null
  }
}
</script>

<template>
  <div class="min-h-screen bg-dark flex items-center justify-center p-4">
    <!-- Background Pattern -->
    <div class="absolute inset-0 overflow-hidden">
      <div class="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-hytale-orange/5 to-transparent rounded-full blur-3xl" />
      <div class="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-hytale-yellow/5 to-transparent rounded-full blur-3xl" />
    </div>

    <!-- Login Card -->
    <div class="relative w-full max-w-md">
      <div class="card p-8">
        <!-- Logo -->
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-24 h-24 bg-dark-200 rounded-2xl mb-4 overflow-hidden border border-dark-50/50 shadow-lg">
            <img src="/logo.png" alt="KyuubiSoft Panel" class="w-full h-full object-cover" />
          </div>
          <h1 class="text-2xl font-bold text-white">KyuubiSoft Panel</h1>
          <p class="text-gray-400 mt-1 text-sm">Hytale Server Management</p>
        </div>

        <!-- Info Message (e.g., forced logout) -->
        <div v-if="infoMessage" class="mb-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <p class="text-blue-400 text-sm">{{ infoMessage }}</p>
        </div>

        <!-- Error Message -->
        <div v-if="error" class="mb-6 p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
          <p class="text-status-error text-sm">{{ error }}</p>
        </div>

        <!-- Demo Mode Buttons -->
        <div v-if="demoStore.isDemoMode" class="space-y-4">
          <div class="text-center mb-6">
            <div class="inline-flex items-center gap-2 px-3 py-1.5 bg-hytale-orange/10 border border-hytale-orange/30 rounded-full">
              <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span class="text-sm text-hytale-orange font-medium">{{ t('demo.modeActive') }}</span>
            </div>
            <p class="text-gray-400 text-sm mt-3">{{ t('demo.selectAccount') }}</p>
          </div>

          <Button
            @click="handleDemoLogin('demo')"
            :loading="demoLoading === 'demo'"
            :disabled="demoLoading !== null"
            variant="secondary"
            class="w-full"
          >
            <svg class="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            {{ t('demo.viewerLogin') }}
          </Button>

          <Button
            @click="handleDemoLogin('admin')"
            :loading="demoLoading === 'admin'"
            :disabled="demoLoading !== null"
            class="w-full"
          >
            <svg class="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            {{ t('demo.adminLogin') }}
          </Button>

          <p class="text-center text-gray-500 text-xs mt-4">
            {{ t('demo.noRealData') }}
          </p>
        </div>

        <!-- Regular Login Form -->
        <form v-else @submit.prevent="handleLogin" class="space-y-5">
          <div>
            <label class="label">{{ t('auth.username') }}</label>
            <Input
              v-model="username"
              type="text"
              :placeholder="t('auth.username')"
              autocomplete="username"
            />
          </div>

          <div>
            <label class="label">{{ t('auth.password') }}</label>
            <div class="relative">
              <Input
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                :placeholder="t('auth.password')"
                autocomplete="current-password"
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
          </div>

          <Button
            type="submit"
            :loading="loading"
            class="w-full"
          >
            {{ t('auth.login') }}
          </Button>
        </form>

        <!-- Language Toggle -->
        <div class="mt-6 text-center">
          <button
            @click="toggleLocale"
            class="text-sm text-gray-400 hover:text-white flex items-center justify-center gap-2 mx-auto"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            {{ currentLocale === 'de' ? 'Deutsch' : 'English' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
