import api from './client'

// Types for system check results
export interface SystemCheckItem {
  id: string
  name: string
  description: string
  status: 'pass' | 'fail' | 'warning' | 'checking'
  required: boolean
  message?: string
  details?: string
}

export interface SystemCheckResponse {
  checks: SystemCheckItem[]
  canProceed: boolean
  errors: number
  warnings: number
}

// Types for setup status
export interface SetupStatus {
  setupComplete: boolean
  currentStep: number
  totalSteps: number
  completedSteps: string[]
  skippedSteps?: string[]
}

// Types for step data
export interface StepData {
  [key: string]: unknown
}

export interface SaveStepResponse {
  success: boolean
  nextStep: number
  error?: string
}

export interface CompleteSetupResponse {
  success: boolean
  redirectUrl: string
  error?: string
}

// Types for admin account creation
export interface AdminAccountData {
  username: string
  password: string
}

export interface CreateAdminResponse {
  success: boolean
  error?: string
}

// Types for language selection
export interface LanguageData {
  language: 'de' | 'en' | 'pt_br'
}

// Types for download method
export interface DownloadMethodData {
  method: 'automatic' | 'manual' | 'existing'
  patchline?: 'release' | 'pre-release'
  completed: boolean
  downloadPath?: string
}

// Types for server authentication
export interface ServerAuthData {
  authenticated: boolean
  authMethod?: 'browser' | 'token'
  persistent?: boolean
  expiresAt?: string
}

// Types for server configuration
export interface ServerConfigData {
  serverName: string
  motd?: string
  maxPlayers?: number
  password?: string
  viewRadius?: number
  defaultGamemode?: string
}

// Types for security settings
export interface SecuritySettingsData {
  enableWhitelist?: boolean
  enableOp?: boolean
  acceptEarlyPlugins?: boolean
  disableSentry?: boolean
  sessionTimeout?: number
  maxLoginAttempts?: number
}

// Types for automation settings
export interface AutomationSettingsData {
  enableAutoBackups?: boolean
  backupTime?: string
  backupRetentionDays?: number
  enableScheduledRestarts?: boolean
  restartTimes?: string[]
  restartWarningMinutes?: number[]
  enableAnnouncements?: boolean
  welcomeMessage?: string
}

// Types for performance settings
export interface PerformanceSettingsData {
  memoryAllocation?: string
  jvmFlags?: string[]
  enablePerformanceSaver?: boolean
  maxViewDistance?: number
  tickRate?: number
}

// Types for plugin installation
export interface PluginInstallData {
  installPlugin?: boolean
  installKyuubiPlugin?: boolean
  installWebServer?: boolean
  installQuery?: boolean
  installedPlugins?: string[]
  version?: string
}

// Types for integrations
export interface IntegrationsData {
  modtaleApiKey?: string | null
  stackmartApiKey?: string | null
  webmapEnabled?: boolean
  enableDiscord?: boolean
  discordWebhookUrl?: string
  enablePrometheus?: boolean
  prometheusPort?: number
  enableModtaleApi?: boolean
}

// Types for network configuration
export interface NetworkConfigData {
  accessMode?: 'localhost' | 'lan' | 'custom'
  customDomain?: string | null
  trustProxy?: boolean
  detectedIp?: string | null
  corsOrigins?: string[]
  serverPort?: number
  webPanelPort?: number
  enableWebMap?: boolean
  webMapPort?: number
  enableRcon?: boolean
  rconPort?: number
  rconPassword?: string
}

// SSE Progress event types
export interface ProgressEvent {
  type: 'progress' | 'complete' | 'error'
  percent?: number
  message?: string
  currentFile?: string
  filesTotal?: number
  filesDone?: number
  bytesTotal?: number
  bytesDone?: number
  bytesPerSecond?: number
  estimatedSeconds?: number
  error?: string
}

// Types for downloader authentication (separate from server auth)
export interface DownloaderAuthResponse {
  success: boolean
  deviceCode?: string
  verificationUrl?: string
  userCode?: string
  expiresIn?: number
  pollInterval?: number
  error?: string
}

export interface DownloaderAuthStatusResponse {
  authenticated: boolean
  expired?: boolean
  error?: string
}

// Types for download request
export interface DownloadRequest {
  method: 'official' | 'custom'
  serverUrl?: string
  assetsUrl?: string
}

// Types for download verification
export interface DownloadVerificationResponse {
  success: boolean
  serverJarSize?: string
  serverJarIntegrity?: boolean
  assetsZipSize?: string
  assetsZipIntegrity?: boolean
  version?: string
  patchline?: string
  error?: string
}

// Types for server first start
export interface ServerFirstStartResponse {
  success: boolean
  error?: string
}

// Types for server authentication (separate from downloader)
export interface ServerAuthResponse {
  success: boolean
  deviceCode?: string
  verificationUrl?: string
  userCode?: string
  expiresIn?: number
  pollInterval?: number
  error?: string
}

export interface ServerAuthStatusResponse {
  authenticated: boolean
  expired?: boolean
  error?: string
}

// Types for persistence setup
export interface PersistenceSetupResponse {
  success: boolean
  error?: string
}

// Types for auth status (all authentications)
export interface AuthStatusResponse {
  downloaderCredentials: boolean
  serverToken: boolean
  tokenPersistence: boolean
  machineId: boolean
}

// Types for asset extraction
export interface AssetExtractionResponse {
  success: boolean
  error?: string
}

// Server control types
export interface ServerStatus {
  status: 'stopped' | 'starting' | 'running' | 'stopping'
  needsAuth: boolean
  authExpired: boolean
}

export interface AuthInitResponse {
  success: boolean
  authUrl?: string
  userCode?: string
  deviceCode?: string
  expiresIn?: number
  error?: string
}

export interface AuthVerifyResponse {
  success: boolean
  authenticated: boolean
  error?: string
}

// Setup API client
export const setupApi = {
  /**
   * Check if setup is required
   */
  async getStatus(): Promise<SetupStatus> {
    const response = await api.get<SetupStatus>('/setup/status')
    return response.data
  },

  /**
   * Run system checks (Phase 0)
   */
  async runSystemCheck(): Promise<SystemCheckResponse> {
    const response = await api.get<SystemCheckResponse>('/setup/system-check')
    return response.data
  },

  /**
   * Save a setup step
   */
  async saveStep(stepId: string, data: StepData): Promise<SaveStepResponse> {
    const response = await api.post<SaveStepResponse>(`/setup/step/${stepId}`, data)
    return response.data
  },

  /**
   * Save language selection (Phase 1)
   */
  async saveLanguage(data: LanguageData): Promise<SaveStepResponse> {
    return this.saveStep('language', data)
  },

  /**
   * Create admin account (Phase 2)
   */
  async createAdmin(data: AdminAccountData): Promise<CreateAdminResponse> {
    const response = await api.post<CreateAdminResponse>('/setup/admin', data)
    return response.data
  },

  /**
   * Save download method selection
   */
  async saveDownloadMethod(data: DownloadMethodData): Promise<SaveStepResponse> {
    return this.saveStep('download-method', data)
  },

  /**
   * Get download status
   */
  async getDownloadStatus(): Promise<{ downloading: boolean; progress: number; error?: string }> {
    const response = await api.get('/setup/download/status')
    return response.data
  },

  /**
   * Save server authentication
   */
  async saveServerAuth(data: ServerAuthData): Promise<SaveStepResponse> {
    return this.saveStep('server-auth', data)
  },

  /**
   * Start server for authentication
   */
  async startServerForAuth(): Promise<{ success: boolean; error?: string }> {
    const response = await api.post('/setup/server/start')
    return response.data
  },

  /**
   * Stop server after authentication
   */
  async stopServerForAuth(): Promise<{ success: boolean; error?: string }> {
    const response = await api.post('/setup/server/stop')
    return response.data
  },

  /**
   * Get server status during setup
   */
  async getServerStatus(): Promise<ServerStatus> {
    const response = await api.get('/setup/server/status')
    return response.data
  },

  /**
   * Initiate server authentication
   */
  async initiateAuth(): Promise<AuthInitResponse> {
    const response = await api.post<AuthInitResponse>('/setup/auth/initiate')
    return response.data
  },

  /**
   * Verify server authentication
   */
  async verifyAuth(deviceCode: string): Promise<AuthVerifyResponse> {
    const response = await api.post<AuthVerifyResponse>('/setup/auth/verify', { deviceCode })
    return response.data
  },

  /**
   * Save server configuration
   */
  async saveServerConfig(data: ServerConfigData): Promise<SaveStepResponse> {
    return this.saveStep('server-config', data)
  },

  /**
   * Save security settings
   */
  async saveSecuritySettings(data: SecuritySettingsData): Promise<SaveStepResponse> {
    return this.saveStep('security-settings', data)
  },

  /**
   * Save automation settings
   */
  async saveAutomation(data: AutomationSettingsData): Promise<SaveStepResponse> {
    return this.saveStep('automation', data)
  },

  /**
   * Save performance settings
   */
  async savePerformance(data: PerformanceSettingsData): Promise<SaveStepResponse> {
    return this.saveStep('performance', data)
  },

  /**
   * Save plugin installation choices
   */
  async savePluginInstall(data: PluginInstallData): Promise<SaveStepResponse> {
    return this.saveStep('plugin', data)
  },

  /**
   * Install a plugin during setup
   */
  async installPlugin(pluginId: string): Promise<{ success: boolean; error?: string }> {
    const response = await api.post(`/setup/plugins/install/${pluginId}`)
    return response.data
  },

  /**
   * Save integrations
   */
  async saveIntegrations(data: IntegrationsData): Promise<SaveStepResponse> {
    return this.saveStep('integrations', data)
  },

  /**
   * Save network configuration
   */
  async saveNetwork(data: NetworkConfigData): Promise<SaveStepResponse> {
    return this.saveStep('network', data)
  },

  /**
   * Extract assets
   */
  async extractAssets(): Promise<{ success: boolean; error?: string }> {
    const response = await api.post('/setup/assets/extract')
    return response.data
  },

  /**
   * Get assets extraction status
   */
  async getAssetsStatus(): Promise<{ extracted: boolean; available: boolean; fileCount?: number }> {
    const response = await api.get('/setup/assets/status')
    return response.data
  },

  /**
   * Start asset extraction
   */
  async startAssetExtraction(): Promise<AssetExtractionResponse> {
    const response = await api.post<AssetExtractionResponse>('/setup/assets/extract')
    return response.data
  },

  // ==========================================
  // Phase 3: Server Download Methods
  // ==========================================

  /**
   * Start downloader OAuth device code flow
   */
  async startDownloaderAuth(): Promise<DownloaderAuthResponse> {
    const response = await api.post<DownloaderAuthResponse>('/setup/download/auth/start')
    return response.data
  },

  /**
   * Check downloader auth status (poll during device code flow)
   */
  async checkDownloaderAuthStatus(): Promise<DownloaderAuthStatusResponse> {
    const response = await api.get<DownloaderAuthStatusResponse>('/setup/download/auth/status')
    return response.data
  },

  /**
   * Start server files download
   */
  async startDownload(request: DownloadRequest): Promise<{ success: boolean; error?: string }> {
    const response = await api.post('/setup/download/start', request)
    return response.data
  },

  /**
   * Verify downloaded server files
   */
  async verifyDownload(): Promise<DownloadVerificationResponse> {
    const response = await api.get<DownloadVerificationResponse>('/setup/download/verify')
    return response.data
  },

  // ==========================================
  // Phase 4: Server Authentication Methods
  // ==========================================

  /**
   * Start server for the first time (Phase 4.1)
   */
  async startServerFirstTime(): Promise<ServerFirstStartResponse> {
    const response = await api.post<ServerFirstStartResponse>('/setup/server/start-first')
    return response.data
  },

  /**
   * Start server OAuth device code flow (Phase 4.2)
   * This is separate from the downloader auth!
   */
  async startServerAuth(): Promise<ServerAuthResponse> {
    const response = await api.post<ServerAuthResponse>('/setup/auth/server/start')
    return response.data
  },

  /**
   * Check server auth status (poll during device code flow)
   */
  async checkServerAuthStatus(): Promise<ServerAuthStatusResponse> {
    const response = await api.get<ServerAuthStatusResponse>('/setup/auth/server/status')
    return response.data
  },

  /**
   * Setup token persistence (Phase 4.3)
   */
  async setupPersistence(): Promise<PersistenceSetupResponse> {
    const response = await api.post<PersistenceSetupResponse>('/setup/auth/persistence')
    return response.data
  },

  /**
   * Get all auth statuses (Phase 4.4)
   */
  async getAuthStatus(): Promise<AuthStatusResponse> {
    const response = await api.get<AuthStatusResponse>('/setup/auth/status')
    return response.data
  },

  /**
   * Complete the setup process
   */
  async completeSetup(): Promise<CompleteSetupResponse> {
    const response = await api.post<CompleteSetupResponse>('/setup/complete')
    return response.data
  },

  /**
   * Skip setup (mark as complete without full configuration)
   * Only available in development mode
   */
  async skipSetup(): Promise<CompleteSetupResponse> {
    const response = await api.post<CompleteSetupResponse>('/setup/skip')
    return response.data
  },
}

// SSE Helper for progress streams
export function createProgressStream(
  url: string,
  onProgress: (event: ProgressEvent) => void,
  onComplete: () => void,
  onError: (error: string) => void
): () => void {
  const eventSource = new EventSource(`/api${url}`)

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as ProgressEvent

      if (data.type === 'complete') {
        onComplete()
        eventSource.close()
      } else if (data.type === 'error') {
        onError(data.error || 'Unknown error')
        eventSource.close()
      } else {
        onProgress(data)
      }
    } catch {
      console.error('Failed to parse SSE event:', event.data)
    }
  }

  eventSource.onerror = () => {
    onError('Connection lost')
    eventSource.close()
  }

  // Return cleanup function
  return () => {
    eventSource.close()
  }
}

// Download progress stream
export function subscribeToDownloadProgress(
  onProgress: (event: ProgressEvent) => void,
  onComplete: () => void,
  onError: (error: string) => void
): () => void {
  return createProgressStream('/setup/download/progress', onProgress, onComplete, onError)
}

// Asset extraction progress stream
export function subscribeToExtractionProgress(
  onProgress: (event: ProgressEvent) => void,
  onComplete: () => void,
  onError: (error: string) => void
): () => void {
  return createProgressStream('/setup/assets/progress', onProgress, onComplete, onError)
}

// Server console stream during setup
export function subscribeToServerConsole(
  onMessage: (message: string) => void,
  onError: (error: string) => void
): () => void {
  const eventSource = new EventSource('/api/setup/server/console')

  eventSource.onmessage = (event) => {
    onMessage(event.data)
  }

  eventSource.onerror = () => {
    onError('Console connection lost')
    eventSource.close()
  }

  return () => {
    eventSource.close()
  }
}

// Re-export all types for easy imports
export type {
  SystemCheckItem,
  SystemCheckResponse,
  SetupStatus,
  StepData,
  SaveStepResponse,
  CompleteSetupResponse,
  AdminAccountData,
  CreateAdminResponse,
  LanguageData,
  DownloadMethodData,
  ServerAuthData,
  ServerConfigData,
  SecuritySettingsData,
  AutomationSettingsData,
  PerformanceSettingsData,
  PluginInstallData,
  IntegrationsData,
  NetworkConfigData,
  ProgressEvent,
  ServerStatus,
  AuthInitResponse,
  AuthVerifyResponse,
  DownloaderAuthResponse,
  DownloaderAuthStatusResponse,
  DownloadRequest,
  DownloadVerificationResponse,
  ServerFirstStartResponse,
  ServerAuthResponse,
  ServerAuthStatusResponse,
  PersistenceSetupResponse,
  AuthStatusResponse,
  AssetExtractionResponse,
}
