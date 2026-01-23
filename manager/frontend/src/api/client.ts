import axios from 'axios'
import type { AxiosInstance, AxiosError } from 'axios'
import { useAuthStore } from '@/stores/auth'

// Create axios instance
const api: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Create axios instance with extended timeout for long-running setup operations
export const setupApiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 120000, // 2 minutes for setup operations like server start
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor - add auth token
api.interceptors.request.use(
  (config) => {
    const authStore = useAuthStore()
    if (authStore.accessToken) {
      config.headers.Authorization = `Bearer ${authStore.accessToken}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Add same interceptors to setupApiClient
setupApiClient.interceptors.request.use(
  (config) => {
    const authStore = useAuthStore()
    if (authStore.accessToken) {
      config.headers.Authorization = `Bearer ${authStore.accessToken}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor - handle token refresh and forced logout
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ detail?: string; code?: string }>) => {
    const originalRequest = error.config
    const authStore = useAuthStore()
    const responseData = error.response?.data

    // Check for token invalidation codes - immediate logout, no refresh attempt
    if (error.response?.status === 401) {
      const invalidationCodes = ['USER_DELETED', 'TOKEN_INVALIDATED']
      if (responseData?.code && invalidationCodes.includes(responseData.code)) {
        authStore.logout()
        if (typeof window !== 'undefined') {
          // Show message based on code
          const message = responseData.code === 'USER_DELETED'
            ? 'Your account has been deleted.'
            : 'Your session has expired due to account changes. Please log in again.'

          // Store message for login page to display
          sessionStorage.setItem('logoutMessage', message)
          window.location.href = '/login'
        }
        return Promise.reject(error)
      }
    }

    // If 401 and we have a refresh token, try to refresh
    if (
      error.response?.status === 401 &&
      authStore.refreshToken &&
      originalRequest &&
      !(originalRequest as any)._retry
    ) {
      (originalRequest as any)._retry = true

      try {
        const response = await axios.post('/api/auth/refresh', {
          refresh_token: authStore.refreshToken,
        })

        const { access_token, refresh_token } = response.data
        authStore.setTokens(access_token, refresh_token)

        // Retry original request
        originalRequest.headers.Authorization = `Bearer ${access_token}`
        return api(originalRequest)
      } catch (refreshError) {
        // Refresh failed, logout
        authStore.logout()
        if (typeof window !== 'undefined') {
          window.location.href = '/login'
        }
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

export default api
