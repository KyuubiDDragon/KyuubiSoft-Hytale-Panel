import api from './client'

export interface User {
  username: string
  role: 'admin' | 'moderator' | 'operator' | 'viewer'
  createdAt: string
  lastLogin?: string
}

export const usersApi = {
  async getAll(): Promise<{ users: User[] }> {
    const response = await api.get<{ users: User[] }>('/auth/users')
    return response.data
  },

  async create(username: string, password: string, role: User['role'] = 'viewer'): Promise<{ success: boolean; user: User }> {
    const response = await api.post<{ success: boolean; user: User }>('/auth/users', { username, password, role })
    return response.data
  },

  async update(username: string, data: { password?: string; role?: User['role'] }): Promise<{ success: boolean; user: User }> {
    const response = await api.put<{ success: boolean; user: User }>(`/auth/users/${encodeURIComponent(username)}`, data)
    return response.data
  },

  async delete(username: string): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>(`/auth/users/${encodeURIComponent(username)}`)
    return response.data
  },
}
