import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  setupApi,
  type SystemCheckItem,
  type SetupStatus,
  type AdminAccountData,
  type LanguageData,
  type DownloadMethodData,
  type ServerAuthData,
  type ServerConfigData,
  type SecuritySettingsData,
  type AutomationSettingsData,
  type PerformanceSettingsData,
  type PluginInstallData,
  type IntegrationsData,
  type NetworkConfigData,
} from '@/api/setup'

// Step definitions
export interface SetupStep {
  id: string
  title: string
  titleKey: string
  component: string
  required: boolean
  skippable?: boolean
}

export const SETUP_STEPS: SetupStep[] = [
  {
    id: 'system-check',
    title: 'System Check',
    titleKey: 'setup.steps.systemCheck',
    component: 'SystemCheck',
    required: true,
  },
  {
    id: 'language',
    title: 'Language Selection',
    titleKey: 'setup.steps.language',
    component: 'LanguageSelect',
    required: true,
  },
  {
    id: 'admin-account',
    title: 'Admin Account',
    titleKey: 'setup.steps.adminAccount',
    component: 'AdminAccount',
    required: true,
  },
  {
    id: 'download-method',
    title: 'Server Download',
    titleKey: 'setup.steps.downloadMethod',
    component: 'ServerDownload',
    required: true,
  },
  {
    id: 'assets-extract',
    title: 'Asset Extraction',
    titleKey: 'setup.steps.assetsExtract',
    component: 'AssetsExtract',
    required: false,
    skippable: true,
  },
  {
    id: 'server-auth',
    title: 'Server Authentication',
    titleKey: 'setup.steps.serverAuth',
    component: 'ServerAuth',
    required: true,
  },
  {
    id: 'server-config',
    title: 'Server Configuration',
    titleKey: 'setup.steps.serverConfig',
    component: 'ServerConfig',
    required: true,
  },
  {
    id: 'security-settings',
    title: 'Security Settings',
    titleKey: 'setup.steps.securitySettings',
    component: 'SecuritySettings',
    required: false,
    skippable: true,
  },
  {
    id: 'automation',
    title: 'Automation',
    titleKey: 'setup.steps.automation',
    component: 'AutomationSettings',
    required: false,
    skippable: true,
  },
  {
    id: 'performance',
    title: 'Performance',
    titleKey: 'setup.steps.performance',
    component: 'PerformanceSettings',
    required: false,
    skippable: true,
  },
  {
    id: 'plugin',
    title: 'Plugin Installation',
    titleKey: 'setup.steps.plugin',
    component: 'PluginInstall',
    required: false,
    skippable: true,
  },
  {
    id: 'integrations',
    title: 'Integrations',
    titleKey: 'setup.steps.integrations',
    component: 'Integrations',
    required: false,
    skippable: true,
  },
  {
    id: 'network',
    title: 'Network Configuration',
    titleKey: 'setup.steps.network',
    component: 'NetworkConfig',
    required: false,
    skippable: true,
  },
  {
    id: 'summary',
    title: 'Summary',
    titleKey: 'setup.steps.summary',
    component: 'Summary',
    required: true,
  },
]

// Setup data types
export interface SetupData {
  systemCheck: {
    checks: SystemCheckItem[]
    canProceed: boolean
    errors: number
    warnings: number
  } | null
  language: LanguageData | null
  admin: AdminAccountData | null
  downloadMethod: DownloadMethodData | null
  assetsExtract: {
    extracted: boolean
    skipped: boolean
  } | null
  serverAuth: ServerAuthData | null
  serverConfig: ServerConfigData | null
  securitySettings: SecuritySettingsData | null
  automation: AutomationSettingsData | null
  performance: PerformanceSettingsData | null
  plugin: PluginInstallData | null
  integrations: IntegrationsData | null
  network: NetworkConfigData | null
}

export const useSetupStore = defineStore('setup', () => {
  // State
  const currentStep = ref(0)
  const totalSteps = ref(SETUP_STEPS.length)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const setupRequired = ref(true)
  const completedSteps = ref<string[]>([])
  const skippedSteps = ref<string[]>([])

  // Setup data for each step
  const setupData = ref<SetupData>({
    systemCheck: null,
    language: null,
    admin: null,
    downloadMethod: null,
    assetsExtract: null,
    serverAuth: null,
    serverConfig: null,
    securitySettings: null,
    automation: null,
    performance: null,
    plugin: null,
    integrations: null,
    network: null,
  })

  // Getters
  const currentStepConfig = computed(() => SETUP_STEPS[currentStep.value])

  const isFirstStep = computed(() => currentStep.value === 0)

  const isLastStep = computed(() => currentStep.value === totalSteps.value - 1)

  const progress = computed(() => {
    if (totalSteps.value === 0) return 0
    return Math.round((currentStep.value / (totalSteps.value - 1)) * 100)
  })

  const currentStepSkippable = computed(() => {
    const step = SETUP_STEPS[currentStep.value]
    return step?.skippable ?? false
  })

  const canGoNext = computed(() => {
    const step = SETUP_STEPS[currentStep.value]
    if (!step) return false

    // If step is skipped, allow proceeding
    if (skippedSteps.value.includes(step.id)) return true

    return validateStep(step.id)
  })

  const canGoBack = computed(() => currentStep.value > 0)

  // Validation functions for each step
  function validateStep(stepId: string): boolean {
    switch (stepId) {
      case 'system-check':
        return setupData.value.systemCheck?.canProceed ?? false
      case 'language':
        return !!setupData.value.language?.language
      case 'admin-account':
        return !!(setupData.value.admin?.username && setupData.value.admin?.password)
      case 'download-method':
        return !!(setupData.value.downloadMethod?.method && setupData.value.downloadMethod?.completed)
      case 'assets-extract':
        return setupData.value.assetsExtract?.extracted || setupData.value.assetsExtract?.skipped || false
      case 'server-auth':
        return setupData.value.serverAuth?.authenticated ?? false
      case 'server-config':
        return !!(setupData.value.serverConfig?.serverName)
      case 'security-settings':
        return true // Optional step, always valid
      case 'automation':
        return true // Optional step, always valid
      case 'performance':
        return true // Optional step, always valid
      case 'plugin':
        return true // Optional step, always valid
      case 'integrations':
        return true // Optional step, always valid
      case 'network':
        return true // Optional step, always valid
      case 'summary':
        return true // Summary is always valid
      default:
        return true
    }
  }

  // Actions
  async function loadSetupStatus(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const status: SetupStatus = await setupApi.getStatus()
      setupRequired.value = !status.setupComplete

      if (status.completedSteps) {
        completedSteps.value = status.completedSteps
      }

      if (status.skippedSteps) {
        skippedSteps.value = status.skippedSteps
      }

      // If setup is complete, return false (no setup needed)
      if (status.setupComplete) {
        return false
      }

      // Resume from last step if any
      if (status.currentStep > 0 && status.currentStep < totalSteps.value) {
        currentStep.value = status.currentStep
      }

      return true
    } catch (err) {
      console.error('Failed to load setup status:', err)
      // If status endpoint fails (404), setup is needed
      setupRequired.value = true
      return true
    } finally {
      isLoading.value = false
    }
  }

  async function runSystemCheck(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.runSystemCheck()
      setupData.value.systemCheck = result
      return result.canProceed
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'System check failed'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveLanguage(data: LanguageData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveLanguage(data)
      if (result.success) {
        setupData.value.language = data
        markStepCompleted('language')
        return true
      }
      error.value = result.error || 'Failed to save language'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save language'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function createAdmin(data: AdminAccountData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.createAdmin(data)
      if (result.success) {
        setupData.value.admin = data
        markStepCompleted('admin-account')
        return true
      }
      error.value = result.error || 'Failed to create admin account'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to create admin account'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveDownloadMethod(data: DownloadMethodData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveDownloadMethod(data)
      if (result.success) {
        setupData.value.downloadMethod = data
        markStepCompleted('download-method')
        return true
      }
      error.value = result.error || 'Failed to save download method'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save download method'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveAssetsExtract(extracted: boolean, skipped: boolean = false): Promise<boolean> {
    setupData.value.assetsExtract = { extracted, skipped }
    if (skipped) {
      markStepSkipped('assets-extract')
    } else {
      markStepCompleted('assets-extract')
    }
    return true
  }

  async function saveServerAuth(data: ServerAuthData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveServerAuth(data)
      if (result.success) {
        setupData.value.serverAuth = data
        markStepCompleted('server-auth')
        return true
      }
      error.value = result.error || 'Failed to save server authentication'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save server authentication'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveServerConfig(data: ServerConfigData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveServerConfig(data)
      if (result.success) {
        setupData.value.serverConfig = data
        markStepCompleted('server-config')
        return true
      }
      error.value = result.error || 'Failed to save server configuration'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save server configuration'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveSecuritySettings(data: SecuritySettingsData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveSecuritySettings(data)
      if (result.success) {
        setupData.value.securitySettings = data
        markStepCompleted('security-settings')
        return true
      }
      error.value = result.error || 'Failed to save security settings'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save security settings'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveAutomation(data: AutomationSettingsData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveAutomation(data)
      if (result.success) {
        setupData.value.automation = data
        markStepCompleted('automation')
        return true
      }
      error.value = result.error || 'Failed to save automation settings'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save automation settings'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function savePerformance(data: PerformanceSettingsData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.savePerformance(data)
      if (result.success) {
        setupData.value.performance = data
        markStepCompleted('performance')
        return true
      }
      error.value = result.error || 'Failed to save performance settings'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save performance settings'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function savePluginInstall(data: PluginInstallData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.savePluginInstall(data)
      if (result.success) {
        setupData.value.plugin = data
        markStepCompleted('plugin')
        return true
      }
      error.value = result.error || 'Failed to save plugin installation'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save plugin installation'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveIntegrations(data: IntegrationsData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveIntegrations(data)
      if (result.success) {
        setupData.value.integrations = data
        markStepCompleted('integrations')
        return true
      }
      error.value = result.error || 'Failed to save integrations'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save integrations'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveNetwork(data: NetworkConfigData): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveNetwork(data)
      if (result.success) {
        setupData.value.network = data
        markStepCompleted('network')
        return true
      }
      error.value = result.error || 'Failed to save network configuration'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save network configuration'
      return false
    } finally {
      isLoading.value = false
    }
  }

  async function saveStep(stepId: string, data: Record<string, unknown>): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.saveStep(stepId, data)
      if (result.success) {
        markStepCompleted(stepId)
        return true
      }
      error.value = result.error || 'Failed to save step'
      return false
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save step'
      return false
    } finally {
      isLoading.value = false
    }
  }

  function markStepCompleted(stepId: string) {
    if (!completedSteps.value.includes(stepId)) {
      completedSteps.value.push(stepId)
    }
    // Remove from skipped if it was previously skipped
    const skippedIndex = skippedSteps.value.indexOf(stepId)
    if (skippedIndex > -1) {
      skippedSteps.value.splice(skippedIndex, 1)
    }
  }

  function markStepSkipped(stepId: string) {
    if (!skippedSteps.value.includes(stepId)) {
      skippedSteps.value.push(stepId)
    }
  }

  function skipCurrentStep() {
    const step = SETUP_STEPS[currentStep.value]
    if (step?.skippable) {
      markStepSkipped(step.id)
      nextStep()
    }
  }

  function nextStep(): boolean {
    if (currentStep.value < totalSteps.value - 1) {
      currentStep.value++
      error.value = null
      return true
    }
    return false
  }

  function prevStep(): boolean {
    if (currentStep.value > 0) {
      currentStep.value--
      error.value = null
      return true
    }
    return false
  }

  function goToStep(step: number): boolean {
    if (step >= 0 && step < totalSteps.value) {
      currentStep.value = step
      error.value = null
      return true
    }
    return false
  }

  async function completeSetup(): Promise<string | null> {
    isLoading.value = true
    error.value = null

    try {
      const result = await setupApi.completeSetup()
      if (result.success) {
        setupRequired.value = false
        return result.redirectUrl || '/login'
      }
      error.value = result.error || 'Failed to complete setup'
      return null
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to complete setup'
      return null
    } finally {
      isLoading.value = false
    }
  }

  function setStepData<K extends keyof SetupData>(key: K, data: SetupData[K]) {
    setupData.value[key] = data
  }

  function setError(message: string | null) {
    error.value = message
  }

  function clearError() {
    error.value = null
  }

  function reset() {
    currentStep.value = 0
    isLoading.value = false
    error.value = null
    completedSteps.value = []
    skippedSteps.value = []
    setupData.value = {
      systemCheck: null,
      language: null,
      admin: null,
      downloadMethod: null,
      assetsExtract: null,
      serverAuth: null,
      serverConfig: null,
      securitySettings: null,
      automation: null,
      performance: null,
      plugin: null,
      integrations: null,
      network: null,
    }
  }

  return {
    // State
    currentStep,
    totalSteps,
    isLoading,
    error,
    setupRequired,
    completedSteps,
    skippedSteps,
    setupData,

    // Getters
    currentStepConfig,
    isFirstStep,
    isLastStep,
    progress,
    currentStepSkippable,
    canGoNext,
    canGoBack,

    // Actions
    loadSetupStatus,
    runSystemCheck,
    saveLanguage,
    createAdmin,
    saveDownloadMethod,
    saveAssetsExtract,
    saveServerAuth,
    saveServerConfig,
    saveSecuritySettings,
    saveAutomation,
    savePerformance,
    savePluginInstall,
    saveIntegrations,
    saveNetwork,
    saveStep,
    markStepCompleted,
    markStepSkipped,
    skipCurrentStep,
    nextStep,
    prevStep,
    goToStep,
    completeSetup,
    setStepData,
    setError,
    clearError,
    reset,
    validateStep,
  }
})
