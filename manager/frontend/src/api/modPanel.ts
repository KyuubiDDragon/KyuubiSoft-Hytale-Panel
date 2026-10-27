import api from './client'

/**
 * Mod status pages: snapshots and admin actions KS mods register with the
 * KyuubiSoft API plugin (backend routes/modPanel.ts). All text comes from mod
 * code on the game server; render it as plain text only.
 */

export type ModPanelValue = string | number | boolean | null
export type ModPanelTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export interface ModPanelParam {
  id: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'choice'
  required: boolean
  defaultValue?: ModPanelValue
  hint?: string | null
  maxLength?: number
  min?: number | null
  max?: number | null
  integer?: boolean
  choices?: string[]
}

export interface ModPanelAction {
  id: string
  label: string
  description?: string | null
  confirmation?: string | null
  requiresConfirmation: boolean
  dangerous: boolean
  params: ModPanelParam[]
}

export interface ModPanelProvider {
  id: string
  displayName: string
  description?: string | null
  version?: string | null
  actions: ModPanelAction[]
}

export type ModPanelUnavailableReason = 'offline' | 'auth' | 'unsupported' | 'unavailable' | 'error'

export interface ModPanelList {
  available: boolean
  reason?: ModPanelUnavailableReason
  error?: string
  apiVersion?: number
  providers: ModPanelProvider[]
}

export interface ModPanelMetric {
  label: string
  value: ModPanelValue
  unit?: string | null
  hint?: string | null
  tone: ModPanelTone
}

export interface ModPanelTable {
  title?: string | null
  columns: string[]
  rows: ModPanelValue[][]
  totalRows?: number
  truncated?: boolean
  emptyText?: string | null
}

export interface ModPanelSection {
  title: string
  description?: string | null
  metrics: ModPanelMetric[]
  tables: ModPanelTable[]
}

export interface ModPanelSnapshot {
  notices: { tone: ModPanelTone; text: string }[]
  sections: ModPanelSection[]
  truncated?: boolean
}

export interface ModPanelSnapshotResponse extends ModPanelProvider {
  status: 'ok' | 'error' | 'timeout' | 'busy'
  error?: string | null
  generatedAt?: string
  durationMs?: number
  snapshot?: ModPanelSnapshot
}

export interface ModPanelActionResult {
  success: boolean
  status: 'ok' | 'failed' | 'error' | 'timeout' | 'busy'
  message?: string | null
  data?: Record<string, ModPanelValue>
  durationMs?: number
}

export const modPanelApi = {
  async list(locale?: string): Promise<ModPanelList> {
    const { data } = await api.get<ModPanelList>('/mod-panel', { params: { locale } })
    return data
  },

  async snapshot(id: string, locale?: string): Promise<ModPanelSnapshotResponse> {
    const { data } = await api.get<ModPanelSnapshotResponse>(
      `/mod-panel/${encodeURIComponent(id)}`,
      {
        params: { locale },
      },
    )
    return data
  },

  async runAction(
    id: string,
    actionId: string,
    params: Record<string, ModPanelValue>,
    confirmed: boolean,
    locale?: string,
  ): Promise<ModPanelActionResult> {
    const { data } = await api.post<ModPanelActionResult>(
      `/mod-panel/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`,
      { params, confirmed, locale },
    )
    return data
  },
}
