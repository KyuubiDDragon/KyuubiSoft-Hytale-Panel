import type {
  EventAction,
  EventActionInput,
  EventActionType,
  EventActionWarning,
} from '@/api/eventActions'

/** Limits the server enforces (services/eventActions.ts); checked here to fail before the request. */
export const MAX_RULE_NAME_LENGTH = 100
export const MAX_TEMPLATE_LENGTH = 500
export const MAX_EVENT_PATTERN_LENGTH = 64

/** Rules the panel keeps itself (the scheduler's welcome message); edited in the scheduler. */
const MANAGED_CREATORS: ReadonlySet<string> = new Set(['scheduler'])

export function isManagedRule(rule: Pick<EventAction, 'createdBy'>): boolean {
  return MANAGED_CREATORS.has(rule.createdBy)
}

export function emptyInput(): EventActionInput {
  return {
    name: '',
    serverId: '',
    eventPattern: '',
    actionType: 'announce',
    command: '',
    message: '',
    enabled: true,
  }
}

// ---------- validation ----------

export type FormField = 'name' | 'eventPattern' | 'command' | 'message'
/** Field -> i18n key of the problem. */
export type FormErrors = Partial<Record<FormField, string>>

function hasControlChars(value: string): boolean {
  return [...value].some((ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || code === 127
  })
}

/** Key of the template text problem, or null when the text is fine. */
function templateProblem(text: string, requiredKey: string): string | null {
  const value = text.trim()
  if (!value) return requiredKey
  if (value.length > MAX_TEMPLATE_LENGTH) return 'eventActions.validation.textTooLong'
  if (hasControlChars(value)) return 'eventActions.validation.textMultiline'
  return null
}

/** Mirrors the server's checks; `events` is the catalog the server sent. */
export function validateInput(input: EventActionInput, events: readonly string[]): FormErrors {
  const errors: FormErrors = {}
  const name = input.name.trim()
  if (!name) errors.name = 'eventActions.validation.nameRequired'
  else if (name.length > MAX_RULE_NAME_LENGTH) errors.name = 'eventActions.validation.nameTooLong'

  if (!input.eventPattern) errors.eventPattern = 'eventActions.validation.eventRequired'
  else if (!isKnownPattern(input.eventPattern, events))
    errors.eventPattern = 'eventActions.validation.eventUnknown'

  if (input.actionType === 'command') {
    const problem = templateProblem(input.command, 'eventActions.validation.commandRequired')
    if (problem) errors.command = problem
    else if (!input.command.trim().startsWith('/'))
      errors.command = 'eventActions.validation.commandSlash'
  } else if (input.actionType === 'announce') {
    const problem = templateProblem(input.message, 'eventActions.validation.messageRequired')
    if (problem) errors.message = problem
  }
  return errors
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0
}

// ---------- events ----------

export function isKnownPattern(pattern: string, events: readonly string[]): boolean {
  if (pattern.length > MAX_EVENT_PATTERN_LENGTH) return false
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1)
    return /^[a-z0-9_]+\.$/.test(prefix) && events.some((e) => e.startsWith(prefix))
  }
  return events.includes(pattern)
}

export interface EventGroup {
  /** The category, e.g. `player` */
  category: string
  /** `player.*` */
  wildcard: string
  events: string[]
}

/** The catalog grouped by category, in the order the server lists it. */
export function groupEvents(events: readonly string[]): EventGroup[] {
  const groups = new Map<string, EventGroup>()
  for (const name of events) {
    const category = name.split('.')[0]
    const group = groups.get(category) ?? { category, wildcard: `${category}.*`, events: [] }
    group.events.push(name)
    groups.set(category, group)
  }
  return [...groups.values()]
}

// ---------- placeholders ----------

/** Payload fields that carry a checked player or account name; any other placeholder carries free text. */
const NAME_PLACEHOLDERS = ['player', 'playerName', 'username', 'owner', 'initiator', 'target']
const FIXED_PLACEHOLDERS: ReadonlySet<string> = new Set([
  ...NAME_PLACEHOLDERS,
  'uuid',
  'serverId',
  'event',
])

/** Placeholders the panel fills in for every event. */
export const GENERIC_PLACEHOLDERS = ['event', 'serverId']

/**
 * Placeholders worth offering for a pattern. Only fields the panel always
 * sends: the player of join/leave events, the backup name.
 */
export function placeholdersFor(pattern: string): string[] {
  const out = [...GENERIC_PLACEHOLDERS]
  if (pattern === 'player.joined' || pattern === 'player.left' || pattern === 'player.*') {
    out.unshift('player', 'uuid')
  }
  if (pattern === 'backup.*' || pattern.startsWith('backup.')) out.unshift('name')
  return out
}

/** The `{name}` placeholders used in a text, without duplicates. */
export function placeholdersIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/\{(\w+)\}/g)) found.add(match[1])
  return [...found]
}

/** Placeholders in `text` that put free event text (chat, reasons) into it. */
export function freeTextPlaceholders(text: string): string[] {
  return placeholdersIn(text).filter((key) => !FIXED_PLACEHOLDERS.has(key))
}

/**
 * Warnings that can be known without the server: free text placeholders in a
 * command. The server adds its own (plugin connection) after saving.
 */
export function localWarnings(
  rule: Pick<EventActionInput, 'actionType' | 'command'>,
): EventActionWarning[] {
  if (rule.actionType !== 'command') return []
  const placeholders = freeTextPlaceholders(rule.command)
  if (placeholders.length === 0) return []
  return [{ code: 'free_text_placeholder', message: '', placeholders }]
}

/** Local and server warnings of one rule, one per code (the server's wins). */
export function mergeWarnings(
  local: EventActionWarning[],
  remote: EventActionWarning[],
): EventActionWarning[] {
  const byCode = new Map<string, EventActionWarning>()
  for (const w of [...local, ...remote]) byCode.set(w.code, w)
  return [...byCode.values()]
}

// ---------- templates ----------

export interface RuleTemplate {
  id: string
  eventPattern: string
  actionType: Exclude<EventActionType, 'command'>
  /** Has a message text (announce) */
  withMessage: boolean
}

/**
 * Starting points, built only from what the server knows: announcements and
 * backups. Name and text come from the translations (`eventActions.templates.<id>`).
 */
export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  { id: 'welcome', eventPattern: 'player.joined', actionType: 'announce', withMessage: true },
  { id: 'farewell', eventPattern: 'player.left', actionType: 'announce', withMessage: true },
  {
    id: 'backupAfterCrash',
    eventPattern: 'server.crashed',
    actionType: 'backup',
    withMessage: false,
  },
  {
    id: 'backupAfterModChange',
    eventPattern: 'mod.installed',
    actionType: 'backup',
    withMessage: false,
  },
  {
    id: 'announceBackupDone',
    eventPattern: 'backup.completed',
    actionType: 'announce',
    withMessage: true,
  },
]

/** Templates whose event the server offers. */
export function availableTemplates(events: readonly string[]): RuleTemplate[] {
  return RULE_TEMPLATES.filter((tpl) => isKnownPattern(tpl.eventPattern, events))
}

/** Editor state for a template; `translate` resolves the template's texts. */
export function inputFromTemplate(
  template: RuleTemplate,
  translate: (key: string) => string,
  serverId = '',
): EventActionInput {
  const base = `eventActions.templates.${template.id}`
  return {
    ...emptyInput(),
    name: translate(`${base}.name`),
    serverId,
    eventPattern: template.eventPattern,
    actionType: template.actionType,
    message: template.withMessage ? translate(`${base}.message`) : '',
  }
}
