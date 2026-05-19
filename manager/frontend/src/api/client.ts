import axios from 'axios'
import type { AxiosInstance, AxiosError } from 'axios'
import { useAuthStore } from '@/stores/auth'

// Create axios instance.
// `withCredentials: true` makes the browser send the HttpOnly kp_refresh
// cookie back on /api/auth/refresh — the access token still rides as a
// Bearer header so XHR endpoints behind authMiddleware see it as before.
const api: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Create axios instance with extended timeout for long-running setup operations
export const setupApiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 120000, // 2 minutes for setup operations like server start
  withCredentials: true,
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
        const message = responseData.code === 'USER_DELETED'
          ? 'Your account has been deleted.'
          : 'Your session has expired due to account changes. Please log in again.'
        authStore.logout(message)
        if (typeof window !== 'undefined') {
          window.location.href = '/login'
        }
        return Promise.reject(error)
      }
    }

    // 401 → try a refresh. We rely on the HttpOnly kp_refresh cookie (sent
    // automatically because withCredentials: true) and fall back to the
    // stored refresh token from localStorage for installations that haven't
    // logged in yet under v2.2.
    if (
      error.response?.status === 401 &&
      originalRequest &&
      !(originalRequest as any)._retry
    ) {
      (originalRequest as any)._retry = true

      try {
        const payload = authStore.refreshToken ? { refresh_token: authStore.refreshToken } : {}
        const response = await axios.post('/api/auth/refresh', payload, {
          withCredentials: true,
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
