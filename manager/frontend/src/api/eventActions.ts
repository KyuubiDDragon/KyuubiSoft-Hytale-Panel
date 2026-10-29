import api from './client'

export type EventActionType = 'command' | 'announce' | 'backup'

/** Why a command rule would be skipped right now (the creator lost the console tier, ...). */
export type EventActionBlock = 'invalid_command' | 'no_creator' | 'creator_lacks_permission'

export interface EventActionPayload {
  command?: string
  message?: string
}

export interface EventAction {
  id: string
  name: string
  /** null = every server */
  serverId: string | null
  /** `*`, an exact event name or `<category>.*` */
  eventPattern: string
  actionType: EventActionType
  actionPayload: EventActionPayload
  enabled: boolean
  createdBy: string
  createdAt: string
  /** Set for command rules that need an explicit approval. */
  blockedReason: EventActionBlock | null
}

export interface EventActionWarning {
  code: 'free_text_placeholder' | 'log_events_run_no_commands'
  /** Backend text (English); the panel shows its own wording for known codes. */
  message: string
  placeholders?: string[]
  events?: string[]
}

export interface EventActionsOverview {
  rules: EventAction[]
  /** Every event a rule can bind to. */
  events: string[]
  actionTypes: EventActionType[]
}

/** What the editor produces. */
export interface EventActionInput {
  name: string
  /** '' = every server */
  serverId: string
  eventPattern: string
  actionType: EventActionType
  command: string
  message: string
  enabled: boolean
}

export interface EventActionSaved {
  rule: EventAction
  warnings: EventActionWarning[]
}

/** The payload object for the action type: only the field that type uses. */
export function toActionPayload(
  input: Pick<EventActionInput, 'actionType' | 'command' | 'message'>,
): EventActionPayload {
  if (input.actionType === 'command') return { command: input.command.trim() }
  if (input.actionType === 'announce') return { message: input.message.trim() }
  return {}
}

/**
 * Request body for POST /event-actions; a new rule is created with the
 * chosen `enabled` state in the same request.
 */
export function toCreateBody(input: EventActionInput) {
  return {
    name: input.name.trim(),
    serverId: input.serverId || null,
    eventPattern: input.eventPattern,
    actionType: input.actionType,
    actionPayload: toActionPayload(input),
    enabled: input.enabled,
  }
}

/** Request body for PUT /event-actions/:id (the server merges it into the stored rule). */
export function toUpdateBody(input: EventActionInput) {
  return toCreateBody(input)
}

/** The editor state for an existing rule. */
export function inputFromRule(rule: EventAction): EventActionInput {
  return {
    name: rule.name,
    serverId: rule.serverId ?? '',
    eventPattern: rule.eventPattern,
    actionType: rule.actionType,
    command: rule.actionPayload.command ?? '',
    message: rule.actionPayload.message ?? '',
    enabled: rule.enabled,
  }
}

export const eventActionsApi = {
  async list(): Promise<EventActionsOverview> {
    const { data } = await api.get<EventActionsOverview>('/event-actions')
    return data
  },

  async create(input: EventActionInput): Promise<EventActionSaved> {
    const { data } = await api.post<EventActionSaved>('/event-actions', toCreateBody(input))
    return data
  },

  async update(id: string, input: EventActionInput): Promise<EventActionSaved> {
    const { data } = await api.put<EventActionSaved>(
      `/event-actions/${encodeURIComponent(id)}`,
      toUpdateBody(input),
    )
    return data
  },

  /** Switch a rule on or off without touching anything else. */
  async setEnabled(id: string, enabled: boolean): Promise<EventActionSaved> {
    const { data } = await api.put<EventActionSaved>(`/event-actions/${encodeURIComponent(id)}`, {
      enabled,
    })
    return data
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/event-actions/${encodeURIComponent(id)}`)
  },

  /** Take over a blocked command rule as its creator. */
  async approve(id: string): Promise<EventAction> {
    const { data } = await api.post<{ rule: EventAction }>(
      `/event-actions/${encodeURIComponent(id)}/approve`,
    )
    return data.rule
  },
}
