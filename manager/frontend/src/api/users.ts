import api from './client'

export interface User {
  username: string
  // Reference to a Role id. Custom roles are allowed alongside the four
  // built-in ones so this is a free-form string rather than a fixed union.
  roleId: string
  createdAt: string
  lastLogin?: string
  tokenVersion?: number
  /** Servers the account may use; missing = every server. */
  allowedServers?: string[]
}

export const usersApi = {
  async getAll(): Promise<{ users: User[] }> {
    const response = await api.get<{ users: User[] }>('/auth/users')
    return response.data
  },

  async create(
    username: string,
    password: string,
    roleId: string = 'viewer',
    allowedServers?: string[],
  ): Promise<{ success: boolean; user: User }> {
    const response = await api.post<{ success: boolean; user: User }>('/auth/users', {
      username,
      password,
      roleId,
      ...(allowedServers ? { allowedServers } : {}),
    })
    return response.data
  },

  async update(
    username: string,
    data: { password?: string; roleId?: string },
  ): Promise<{ success: boolean; user: User }> {
    const response = await api.put<{ success: boolean; user: User }>(
      `/auth/users/${encodeURIComponent(username)}`,
      data,
    )
    return response.data
  },

  /** `null` = every server. */
  async setServers(
    username: string,
    allowedServers: string[] | null,
  ): Promise<{ success: boolean; username: string; allowedServers: string[] | null }> {
    const response = await api.put<{
      success: boolean
      username: string
      allowedServers: string[] | null
    }>(`/auth/users/${encodeURIComponent(username)}/servers`, { allowedServers })
    return response.data
  },

  async delete(username: string): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>(
      `/auth/users/${encodeURIComponent(username)}`,
    )
    return response.data
  },
}
