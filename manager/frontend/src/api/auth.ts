import api from './client'

export interface LoginRequest {
  username: string
  password: string
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
  role?: string
  permissions?: string[]
}

export interface UserInfo {
  username: string
  role?: string
  permissions?: string[]
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

export interface WsTicketResponse {
  ticket: string
  expiresIn: number
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
    const response = await api.get<HytaleAuthStatus>('/server/hytale-auth/status')
    return response.data
  },

  async initiateHytaleLogin(): Promise<HytaleDeviceCodeResponse> {
    const response = await api.post<HytaleDeviceCodeResponse>('/server/hytale-auth/initiate')
    return response.data
  },

  async checkHytaleAuthCompletion(): Promise<HytaleAuthCheckResponse> {
    const response = await api.post<HytaleAuthCheckResponse>('/server/hytale-auth/check')
    return response.data
  },

  async resetHytaleAuth(): Promise<HytaleAuthCheckResponse> {
    const response = await api.post<HytaleAuthCheckResponse>('/server/hytale-auth/reset')
    return response.data
  },

  async setHytalePersistence(type: 'Memory' | 'Encrypted'): Promise<HytaleAuthCheckResponse> {
    const response = await api.post<HytaleAuthCheckResponse>('/server/hytale-auth/persistence', { type })
    return response.data
  },

  // WebSocket Authentication
  // Get a single-use ticket for WebSocket connection (more secure than token in URL).
  // With a server id the ticket only opens that server's sockets.
  async getWsTicket(serverId?: string | null): Promise<WsTicketResponse> {
    const response = await api.post<WsTicketResponse>(
      '/auth/ws-ticket',
      serverId ? { serverId } : undefined,
    )
    return response.data
  },
}
