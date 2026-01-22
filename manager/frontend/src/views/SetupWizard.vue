<script setup lang="ts">
import { ref, computed, onMounted, markRaw, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSetupStore, SETUP_STEPS } from '@/stores/setup'

// Import step components
import SystemCheck from '@/components/setup/SystemCheck.vue'
import LanguageSelect from '@/components/setup/LanguageSelect.vue'
import AdminAccount from '@/components/setup/AdminAccount.vue'
import ServerDownload from '@/components/setup/ServerDownload.vue'
import AssetsExtract from '@/components/setup/AssetsExtract.vue'
import ServerAuth from '@/components/setup/ServerAuth.vue'
import ServerConfig from '@/components/setup/ServerConfig.vue'
import SecuritySettings from '@/components/setup/SecuritySettings.vue'
import AutomationSettings from '@/components/setup/AutomationSettings.vue'
import PerformanceSettings from '@/components/setup/PerformanceSettings.vue'
import PluginInstall from '@/components/setup/PluginInstall.vue'
import Integrations from '@/components/setup/Integrations.vue'
import NetworkConfig from '@/components/setup/NetworkConfig.vue'
import Summary from '@/components/setup/Summary.vue'

const { t } = useI18n()
const router = useRouter()
const setupStore = useSetupStore()

// Map component names to actual components
const stepComponents: Record<string, Component> = {
  SystemCheck: markRaw(SystemCheck),
  LanguageSelect: markRaw(LanguageSelect),
  AdminAccount: markRaw(AdminAccount),
  ServerDownload: markRaw(ServerDownload),
  AssetsExtract: markRaw(AssetsExtract),
  ServerAuth: markRaw(ServerAuth),
  ServerConfig: markRaw(ServerConfig),
  SecuritySettings: markRaw(SecuritySettings),
  AutomationSettings: markRaw(AutomationSettings),
  PerformanceSettings: markRaw(PerformanceSettings),
  PluginInstall: markRaw(PluginInstall),
  Integrations: markRaw(Integrations),
  NetworkConfig: markRaw(NetworkConfig),
  Summary: markRaw(Summary),
}

// Current step component
const currentComponent = computed(() => {
  const config = setupStore.currentStepConfig
  if (!config) return null
  return stepComponents[config.component]
})

// Loading state for initial setup check
const initialLoading = ref(true)

// Step transition animation
const transitionName = ref('slide-left')

// Handle step completion
async function handleStepComplete() {
  if (setupStore.isLastStep) {
    // Complete the setup
    const redirectUrl = await setupStore.completeSetup()
    if (redirectUrl) {
      router.push(redirectUrl)
    }
  } else {
    transitionName.value = 'slide-left'
    setupStore.nextStep()
  }
}

// Handle going back
function handleStepBack() {
  transitionName.value = 'slide-right'
  setupStore.prevStep()
}

// Handle skip for optional steps
function handleStepSkip() {
  setupStore.skipCurrentStep()
}

// Navigate to specific step (only if completed)
function goToStep(index: number) {
  if (index < setupStore.currentStep) {
    transitionName.value = index < setupStore.currentStep ? 'slide-right' : 'slide-left'
    setupStore.goToStep(index)
  }
}

// Check if a step was skipped
function isStepSkipped(stepId: string) {
  return setupStore.skippedSteps.includes(stepId)
}

// Initialize
onMounted(async () => {
  const needsSetup = await setupStore.loadSetupStatus()
  initialLoading.value = false

  if (!needsSetup) {
    // Setup already complete, redirect to login
    router.push('/login')
  }
})
</script>

<template>
  <div class="min-h-screen bg-dark flex flex-col">
    <!-- Background Pattern -->
    <div class="fixed inset-0 overflow-hidden pointer-events-none">
      <div class="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-hytale-orange/5 to-transparent rounded-full blur-3xl" />
      <div class="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-hytale-yellow/5 to-transparent rounded-full blur-3xl" />
    </div>

    <!-- Loading State -->
    <div v-if="initialLoading" class="flex-1 flex items-center justify-center">
      <div class="text-center">
        <svg class="w-16 h-16 text-hytale-orange animate-spin mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <p class="text-gray-400">{{ t('setup.loading') }}</p>
      </div>
    </div>

    <!-- Main Content -->
    <template v-else>
      <!-- Header -->
      <header class="relative z-10 py-6 px-4 sm:px-6 lg:px-8">
        <div class="max-w-4xl mx-auto flex items-center justify-between">
          <!-- Logo -->
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-dark-200 rounded-xl overflow-hidden border border-dark-50/50">
              <img src="/logo.png" alt="KyuubiSoft Panel" class="w-full h-full object-cover" />
            </div>
            <div>
              <h1 class="text-lg font-bold text-white">KyuubiSoft Panel</h1>
              <p class="text-xs text-gray-400">{{ t('setup.wizardTitle') }}</p>
            </div>
          </div>

          <!-- Step Counter -->
          <div class="hidden sm:flex items-center gap-2 text-sm text-gray-400">
            <span>{{ t('setup.step') }}</span>
            <span class="text-white font-medium">{{ setupStore.currentStep + 1 }}</span>
            <span>/</span>
            <span>{{ setupStore.totalSteps }}</span>
          </div>
        </div>
      </header>

      <!-- Progress Bar -->
      <div class="relative z-10 px-4 sm:px-6 lg:px-8">
        <div class="max-w-4xl mx-auto">
          <div class="h-1 bg-dark-200 rounded-full overflow-hidden">
            <div
              class="h-full bg-gradient-to-r from-hytale-orange to-hytale-yellow transition-all duration-500 ease-out"
              :style="{ width: `${setupStore.progress}%` }"
            />
          </div>
        </div>
      </div>

      <!-- Step Navigation - Compact view for many steps -->
      <div class="relative z-10 px-4 sm:px-6 lg:px-8 py-4">
        <div class="max-w-4xl mx-auto">
          <!-- Mobile: Current step indicator only -->
          <div class="sm:hidden flex items-center justify-center gap-2">
            <span class="text-sm text-gray-400">{{ t(setupStore.currentStepConfig?.titleKey || '') }}</span>
            <span v-if="setupStore.currentStepConfig?.skippable" class="text-xs text-gray-500">({{ t('setup.optional') }})</span>
          </div>

          <!-- Desktop: Step dots with current step name -->
          <div class="hidden sm:flex flex-col items-center gap-3">
            <!-- Step dots -->
            <div class="flex items-center gap-1">
              <template v-for="(step, index) in SETUP_STEPS" :key="step.id">
                <button
                  @click="goToStep(index)"
                  class="group relative transition-all"
                  :class="[
                    index <= setupStore.currentStep ? 'cursor-pointer' : 'cursor-not-allowed',
                  ]"
                  :disabled="index > setupStore.currentStep"
                  :title="t(step.titleKey)"
                >
                  <!-- Step dot -->
                  <div
                    class="w-3 h-3 rounded-full transition-all"
                    :class="[
                      index < setupStore.currentStep
                        ? isStepSkipped(step.id)
                          ? 'bg-status-warning'
                          : 'bg-status-success'
                        : index === setupStore.currentStep
                          ? 'bg-hytale-orange ring-2 ring-hytale-orange/30 ring-offset-2 ring-offset-dark w-4 h-4'
                          : 'bg-dark-200',
                    ]"
                  />

                  <!-- Tooltip on hover -->
                  <div class="absolute -top-8 left-1/2 transform -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    <div class="bg-dark-100 text-white text-xs px-2 py-1 rounded whitespace-nowrap">
                      {{ t(step.titleKey) }}
                    </div>
                  </div>
                </button>

                <!-- Connector Line -->
                <div
                  v-if="index < SETUP_STEPS.length - 1"
                  class="w-4 lg:w-6 h-0.5"
                  :class="[
                    index < setupStore.currentStep
                      ? isStepSkipped(step.id) ? 'bg-status-warning' : 'bg-status-success'
                      : 'bg-dark-200',
                  ]"
                />
              </template>
            </div>

            <!-- Current step name -->
            <div class="flex items-center gap-2">
              <span class="text-sm text-white font-medium">{{ t(setupStore.currentStepConfig?.titleKey || '') }}</span>
              <span v-if="setupStore.currentStepConfig?.skippable" class="text-xs bg-dark-200 text-gray-400 px-2 py-0.5 rounded">
                {{ t('setup.optional') }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Step Content -->
      <main class="relative z-10 flex-1 px-4 sm:px-6 lg:px-8 py-8">
        <div class="max-w-2xl mx-auto">
          <div class="card p-6 sm:p-8">
            <Transition :name="transitionName" mode="out-in">
              <component
                :is="currentComponent"
                :key="setupStore.currentStep"
                @complete="handleStepComplete"
                @back="handleStepBack"
              />
            </Transition>
          </div>
        </div>
      </main>

      <!-- Footer -->
      <footer class="relative z-10 py-4 px-4 sm:px-6 lg:px-8">
        <div class="max-w-4xl mx-auto text-center">
          <p class="text-xs text-gray-500">
            KyuubiSoft Hytale Panel &copy; {{ new Date().getFullYear() }}
          </p>
        </div>
      </footer>
    </template>
  </div>
</template>

<style scoped>
/* Slide transitions */
.slide-left-enter-active,
.slide-left-leave-active,
.slide-right-enter-active,
.slide-right-leave-active {
  transition: all 0.3s ease-out;
}

.slide-left-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

.slide-left-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}

.slide-right-enter-from {
  opacity: 0;
  transform: translateX(-30px);
}

.slide-right-leave-to {
  opacity: 0;
  transform: translateX(30px);
}
</style>
