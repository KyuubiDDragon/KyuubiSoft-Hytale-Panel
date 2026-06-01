import api from './client'

/** Web Push (PWA) subscription management. */

export interface VapidInfo {
  enabled: boolean
  key: string | null
  devices: number
}

export interface WebPushSettings {
  enabled: boolean
  subject: string
  vapidConfigured: boolean
}

export const pushApi = {
  async getVapidKey(): Promise<VapidInfo> {
    const { data } = await api.get<VapidInfo>('/push/vapid-public-key')
    return data
  },

  async subscribe(subscription: PushSubscriptionJSON): Promise<{ success: boolean; devices: number }> {
    const { data } = await api.post('/push/subscribe', { subscription })
    return data
  },

  async unsubscribe(endpoint: string): Promise<{ success: boolean; devices: number }> {
    const { data } = await api.post('/push/unsubscribe', { endpoint })
    return data
  },

  async test(): Promise<{ success: boolean }> {
    const { data } = await api.post('/push/test')
    return data
  },

  // Admin settings (enable/disable push server-side).
  async getSettings(): Promise<WebPushSettings> {
    const { data } = await api.get<WebPushSettings>('/settings/web-push')
    return data
  },

  async saveSettings(payload: { enabled?: boolean; subject?: string }): Promise<{ success: boolean; data: WebPushSettings }> {
    const { data } = await api.put('/settings/web-push', payload)
    return data
  },
}
