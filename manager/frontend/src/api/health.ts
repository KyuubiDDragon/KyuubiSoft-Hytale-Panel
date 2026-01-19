import api from './client'

export interface PermissionCheckResult {
  path: string
  name: string
  readable: boolean
  writable: boolean
  error?: string
}

export interface PermissionHealthResponse {
  ok: boolean
  issues: PermissionCheckResult[]
  message?: string
}

export const healthApi = {
  async checkPermissions(): Promise<PermissionHealthResponse> {
    const response = await api.get<PermissionHealthResponse>('/health/permissions')
    return response.data
  },
}
