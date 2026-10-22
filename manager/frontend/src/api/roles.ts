import type { AxiosResponse } from 'axios'
import apiClient from './client'

export interface Role {
  id: string
  name: string
  description: string
  permissions: string[]
  isSystem: boolean
  color?: string
  createdAt: string
  updatedAt: string
}

export const rolesApi = {
  getAll: () =>
    apiClient
      .get<{ roles: Role[] }>('/roles')
      .then((r: AxiosResponse<{ roles: Role[] }>) => r.data),
  getPermissions: () =>
    apiClient
      .get<{ permissions: Record<string, string> }>('/roles/permissions')
      .then((r: AxiosResponse<{ permissions: Record<string, string> }>) => r.data),
  get: (id: string) => apiClient.get<Role>(`/roles/${id}`).then((r: AxiosResponse<Role>) => r.data),
  create: (data: { name: string; description: string; permissions: string[]; color?: string }) =>
    apiClient
      .post<{ success: boolean; role: Role }>('/roles', data)
      .then((r: AxiosResponse<{ success: boolean; role: Role }>) => r.data),
  update: (
    id: string,
    data: Partial<{ name: string; description: string; permissions: string[]; color?: string }>,
  ) =>
    apiClient
      .put<{ success: boolean; role: Role }>(`/roles/${id}`, data)
      .then((r: AxiosResponse<{ success: boolean; role: Role }>) => r.data),
  delete: (id: string) =>
    apiClient
      .delete<{ success: boolean }>(`/roles/${id}`)
      .then((r: AxiosResponse<{ success: boolean }>) => r.data),
}
