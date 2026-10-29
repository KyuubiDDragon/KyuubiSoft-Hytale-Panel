import type { AxiosError } from 'axios'
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
  /** Host folder the data directories live under (HOST_DATA_PATH). */
  hostDataPath?: string
  message?: string
}

export const healthApi = {
  async checkPermissions(): Promise<PermissionHealthResponse> {
    const response = await api.get<PermissionHealthResponse>('/health/permissions')
    return response.data
  },

  /**
   * The folder check for an account that may run it, else null. It names the
   * compose server's folders, so the panel answers only settings.view with
   * access to every server ('*' has both); other accounts ask nothing, and a
   * refusal (403, e.g. rights changed meanwhile) stays silent.
   */
  async checkPermissionsIfAllowed(permissions: string[]): Promise<PermissionHealthResponse | null> {
    const isAdmin = permissions.includes('*')
    if (!isAdmin && !permissions.includes('settings.view')) return null
    if (!isAdmin) {
      const { data } = await api.get<{ unrestricted?: boolean }>('/auth/me/servers')
      if (data.unrestricted !== true) return null
    }
    try {
      return await healthApi.checkPermissions()
    } catch (err) {
      if ((err as AxiosError)?.response?.status === 403) return null
      throw err
    }
  },
}
