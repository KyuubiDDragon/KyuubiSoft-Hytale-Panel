import api from './client'

/**
 * Panel settings the admin manages from the UI (instead of env vars).
 * Secrets are never returned in full — only whether they are configured,
 * where the value comes from, and a short masked preview.
 */

export type IntegrationSource = 'config' | 'env' | 'unset'

export interface IntegrationFieldStatus {
  configured: boolean
  source: IntegrationSource
  masked: string | null
}

export interface IntegrationsStatus {
  curseforge: IntegrationFieldStatus & { gameId: number }
  modtale: IntegrationFieldStatus
  stackmart: IntegrationFieldStatus
}

/** Payload for PUT — every field optional; only provided fields change. */
export interface IntegrationsUpdate {
  curseforgeApiKey?: string
  curseforgeGameId?: number
  modtaleApiKey?: string
  stackmartApiKey?: string
}

export type AutoModAction = 'warn' | 'mute' | 'kick'

export interface AutoModConfig {
  enabled: boolean
  bannedWords: string[]
  blockLinks: boolean
  maxCapsPercent: number
  maxMessageLength: number
  floodCount: number
  floodWindowSec: number
  action: AutoModAction
  muteDurationSec: number
}

export const settingsApi = {
  async getIntegrations(): Promise<IntegrationsStatus> {
    const { data } = await api.get<IntegrationsStatus>('/settings/integrations')
    return data
  },

  async saveIntegrations(payload: IntegrationsUpdate): Promise<{ success: boolean; message?: string; data: IntegrationsStatus }> {
    const { data } = await api.put('/settings/integrations', payload)
    return data
  },

  async getAutoMod(): Promise<AutoModConfig> {
    const { data } = await api.get<AutoModConfig>('/settings/automod')
    return data
  },

  async saveAutoMod(payload: AutoModConfig): Promise<{ success: boolean; message?: string; data: AutoModConfig }> {
    const { data } = await api.put('/settings/automod', payload)
    return data
  },

  async getDiscord(): Promise<DiscordStatus> {
    const { data } = await api.get<DiscordStatus>('/settings/discord')
    return data
  },

  async saveDiscord(payload: DiscordUpdate): Promise<{ success: boolean; message?: string; data: DiscordStatus }> {
    const { data } = await api.put('/settings/discord', payload)
    return data
  },

  async getOffsiteBackup(): Promise<OffsiteBackupStatus> {
    const { data } = await api.get<OffsiteBackupStatus>('/settings/offsite-backup')
    return data
  },

  async saveOffsiteBackup(payload: OffsiteBackupUpdate): Promise<{ success: boolean; message?: string }> {
    const { data } = await api.put('/settings/offsite-backup', payload)
    return data
  },

  async testOffsiteBackup(): Promise<{ success: boolean; message?: string; error?: string }> {
    const { data } = await api.post('/settings/offsite-backup/test')
    return data
  },
}

export interface OffsiteBackupStatus {
  enabled: boolean
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  uploadOnBackup: boolean
  secretConfigured: boolean
  secretMasked: string | null
}

export interface OffsiteBackupUpdate {
  enabled?: boolean
  endpoint?: string
  region?: string
  bucket?: string
  prefix?: string
  accessKeyId?: string
  secretAccessKey?: string
  uploadOnBackup?: boolean
}

export interface DiscordStatus {
  enabled: boolean
  channelId: string
  guildId: string
  tokenConfigured: boolean
  tokenMasked: string | null
  running: boolean
}

/** PUT payload — token optional; provide '' to clear, omit to keep. */
export interface DiscordUpdate {
  enabled?: boolean
  token?: string
  channelId?: string
  guildId?: string
}
