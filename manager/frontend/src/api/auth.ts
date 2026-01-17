import api from './client'

export interface LoginRequest {
  username: string
  password: string
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface UserInfo {
  username: string
}

export interface HytaleAuthStatus {
  authenticated: boolean
  deviceCode?: string
  userCode?: string
  verificationUrl?: string
  expiresAt?: number
  lastChecked?: number
  persistent?: boolean
  persistenceType?: string // 'disk' or 'memory'
  serverAuthRequired?: boolean // True when server shows "No server tokens configured"
  authType?: 'none' | 'downloader' | 'server' // What type of auth is present
}

export interface HytaleDeviceCodeResponse {
  success: boolean
  deviceCode?: string
  userCode?: string
  verificationUrl?: string
  expiresIn?: number
  error?: string
}

export interface HytaleAuthCheckResponse {
  success: boolean
  message?: string
  error?: string
}

export const authApi = {
  async login(credentials: LoginRequest): Promise<TokenResponse> {
    const response = await api.post<TokenResponse>('/auth/login', credentials)
    return response.data
  },

  async refresh(refreshToken: string): Promise<TokenResponse> {
    const response = await api.post<TokenResponse>('/auth/refresh', {
      refresh_token: refreshToken,
    })
    return response.data
  },

  async logout(): Promise<void> {
    await api.post('/auth/logout')
  },

  async getMe(): Promise<UserInfo> {
    const response = await api.get<UserInfo>('/auth/me')
    return response.data
  },

  // Hytale Server Authentication
  async getHytaleAuthStatus(): Promise<HytaleAuthStatus> {
    const response = await api.get<HytaleAuthStatus>('/auth/hytale/status')
    return response.data
  },

  async initiateHytaleLogin(): Promise<HytaleDeviceCodeResponse> {
    const response = await api.post<HytaleDeviceCodeResponse>('/auth/hytale/initiate')
    return response.data
  },

  async checkHytaleAuthCompletion(): Promise<HytaleAuthCheckResponse> {
    const response = await api.post<HytaleAuthCheckResponse>('/auth/hytale/check')
    return response.data
  },

  async resetHytaleAuth(): Promise<HytaleAuthCheckResponse> {
    const response = await api.post<HytaleAuthCheckResponse>('/auth/hytale/reset')
    return response.data
  },

  async setHytalePersistence(type: 'Memory' | 'Encrypted'): Promise<HytaleAuthCheckResponse> {
    const response = await api.post<HytaleAuthCheckResponse>('/auth/hytale/persistence', { type })
    return response.data
  },
}
