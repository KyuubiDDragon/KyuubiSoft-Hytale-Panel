<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useDemoStore } from '@/stores/demo'
import { setLocale, getLocale } from '@/i18n'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'

interface SsoProvider {
  id: string
  name: string
  loginUrl: string
}

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
const checkingDemo = ref(true)
const ssoProviders = ref<SsoProvider[]>([])

onMounted(async () => {
  const logoutMessage = sessionStorage.getItem('logoutMessage')
  if (logoutMessage) {
    infoMessage.value = logoutMessage
    sessionStorage.removeItem('logoutMessage')
  }

  // Check demo mode
  try {
    const response = await fetch('/api/server/demo')
    if (response.ok) {
      const data = await response.json()
      if (data.demoMode) {
        demoStore.isDemoMode = true
      }
    }
  } catch {
    // ignore
  }

  // Attempt to load SSO providers — endpoint may not exist, that's OK
  try {
    const r = await fetch('/api/auth/sso/providers')
    if (r.ok) {
      const data = await r.json()
      if (Array.isArray(data?.providers)) {
        ssoProviders.value = data.providers
      } else if (Array.isArray(data)) {
        ssoProviders.value = data
      }
    }
  } catch {
    // ignore — no SSO available
  }

  checkingDemo.value = false
})

const locales = ['de', 'en', 'pt_br'] as const
const localeNames: Record<string, string> = { de: 'Deutsch', en: 'English', pt_br: 'Português (BR)' }

function toggleLocale() {
  const currentIndex = locales.indexOf(currentLocale.value as typeof locales[number])
  const nextIndex = (currentIndex + 1) % locales.length
  const newLocale = locales[nextIndex]
  setLocale(newLocale)
  currentLocale.value = newLocale
}

async function handleLogin() {
  error.value = ''
  loading.value = true
  try {
    await authStore.login({ username: username.value, password: password.value })
    router.push('/')
  } catch {
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
  } catch {
    error.value = t('auth.invalidCredentials')
  } finally {
    demoLoading.value = null
  }
}

function loginWithProvider(provider: SsoProvider) {
  window.location.href = provider.loginUrl
}
</script>

<template>
  <div class="min-h-screen bg-surface text-ink flex items-center justify-center p-4 relative overflow-hidden">
    <!-- Ambient Background -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <div class="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-hytale-orange/10 to-transparent rounded-full blur-3xl" />
      <div class="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-hytale-yellow/10 to-transparent rounded-full blur-3xl" />
    </div>

    <!-- Login Card -->
    <div class="relative w-full max-w-md">
      <!-- Demo gradient border wrapper -->
      <div
        :class="[
          'rounded-2xl',
          demoStore.isDemoMode
            ? 'p-[1.5px] bg-gradient-to-br from-hytale-orange via-hytale-yellow to-hytale-orange shadow-glow-orange'
            : ''
        ]"
      >
        <div class="card bg-surface-raised/95 backdrop-blur-sm border-border/50 shadow-2xl p-8 rounded-2xl">
          <!-- Logo with orange glow accent -->
          <div class="text-center mb-8">
            <div class="relative inline-flex items-center justify-center mb-4">
              <div class="absolute inset-0 bg-hytale-orange/30 blur-2xl rounded-full" aria-hidden="true" />
              <div class="relative w-24 h-24 bg-surface-overlay rounded-2xl overflow-hidden border border-border/60 shadow-lg">
                <img src="/logo.png" alt="KyuubiSoft Panel" class="w-full h-full object-cover" />
              </div>
            </div>
            <h1 class="text-2xl font-bold text-ink">KyuubiSoft Panel</h1>
            <p class="text-ink-muted mt-1 text-sm">{{ t('auth.subtitle') }}</p>
          </div>

          <!-- Info Message -->
          <div v-if="infoMessage" class="mb-6 p-4 bg-status-info/10 border border-status-info/30 rounded-lg">
            <p class="text-status-info text-sm">{{ infoMessage }}</p>
          </div>

          <!-- Error Message -->
          <div v-if="error" class="mb-6 p-4 bg-status-error/10 border border-status-error/30 rounded-lg" role="alert">
            <p class="text-status-error text-sm">{{ error }}</p>
          </div>

          <!-- Loading while checking demo mode -->
          <div v-if="checkingDemo" class="flex justify-center py-8">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-hytale-orange" />
          </div>

          <!-- Demo Mode -->
          <div v-else-if="demoStore.isDemoMode" class="space-y-4">
            <div class="text-center mb-6">
              <div class="inline-flex items-center gap-2 px-3 py-1.5 bg-hytale-orange/10 border border-hytale-orange/30 rounded-full">
                <svg class="w-4 h-4 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span class="text-sm text-hytale-orange font-medium">{{ t('demo.modeActive') }}</span>
              </div>
              <p class="text-ink-muted text-sm mt-3">{{ t('demo.selectAccount') }}</p>
            </div>

            <Button
              @click="handleDemoLogin('demo')"
              :loading="demoLoading === 'demo'"
              :disabled="demoLoading !== null"
              variant="secondary"
              block
            >
              <svg class="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {{ t('demo.viewerLogin') }}
            </Button>

            <Button
              @click="handleDemoLogin('admin')"
              :loading="demoLoading === 'admin'"
              :disabled="demoLoading !== null"
              block
            >
              <svg class="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              {{ t('demo.adminLogin') }}
            </Button>

            <p class="text-center text-ink-subtle text-xs mt-4">
              {{ t('demo.noRealData') }}
            </p>
          </div>

          <!-- Regular Login -->
          <form v-else @submit.prevent="handleLogin" class="space-y-5" novalidate>
            <Input
              v-model="username"
              :label="t('auth.username')"
              type="text"
              :placeholder="t('auth.username')"
              autocomplete="username"
              required
              name="username"
            />

            <div>
              <label for="login-password" class="label">{{ t('auth.password') }}</label>
              <div class="relative">
                <input
                  id="login-password"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  :placeholder="t('auth.password')"
                  autocomplete="current-password"
                  required
                  class="input pr-10"
                />
                <button
                  type="button"
                  @click="showPassword = !showPassword"
                  class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-ink-subtle hover:text-ink transition-colors"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                >
                  <svg v-if="showPassword" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                  <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                </button>
              </div>
            </div>

            <Button type="submit" :loading="loading" block>
              {{ t('auth.login') }}
            </Button>

            <!-- SSO Providers (Discord etc.) — only when backend exposes them -->
            <div v-if="ssoProviders.length > 0" class="pt-2">
              <div class="relative my-4">
                <div class="absolute inset-0 flex items-center" aria-hidden="true">
                  <div class="w-full border-t border-border/60" />
                </div>
                <div class="relative flex justify-center text-xs uppercase tracking-wider">
                  <span class="bg-surface-raised px-2 text-ink-subtle">or</span>
                </div>
              </div>
              <div class="space-y-2">
                <button
                  v-for="provider in ssoProviders"
                  :key="provider.id"
                  type="button"
                  @click="loginWithProvider(provider)"
                  class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border bg-surface-overlay text-ink hover:bg-surface-muted transition-colors"
                >
                  <svg
                    v-if="provider.id === 'discord'"
                    class="w-5 h-5 text-[#5865F2]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
                  >
                    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                  </svg>
                  <span class="font-medium">{{ provider.name }}</span>
                </button>
              </div>
            </div>
          </form>

          <!-- Language Toggle -->
          <div class="mt-6 text-center">
            <button
              @click="toggleLocale"
              class="text-sm text-ink-muted hover:text-ink flex items-center justify-center gap-2 mx-auto transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
              {{ localeNames[currentLocale] || currentLocale }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
