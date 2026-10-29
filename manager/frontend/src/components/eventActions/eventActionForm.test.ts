import { describe, it, expect } from 'vitest'
import eventCatalogSource from '../../../../backend/src/schemas/events.ts?raw'
import type { EventActionInput } from '@/api/eventActions'
import {
  RULE_TEMPLATES,
  availableTemplates,
  emptyInput,
  freeTextPlaceholders,
  groupEvents,
  hasErrors,
  inputFromTemplate,
  isKnownPattern,
  isManagedRule,
  localWarnings,
  mergeWarnings,
  placeholdersFor,
  placeholdersIn,
  validateInput,
} from './eventActionForm'

const EVENTS = [
  'player.joined',
  'player.left',
  'backup.completed',
  'server.crashed',
  'mod.installed',
]

const valid = (over: Partial<EventActionInput> = {}): EventActionInput => ({
  ...emptyInput(),
  name: 'Welcome',
  eventPattern: 'player.joined',
  message: 'Hello {player}',
  ...over,
})

describe('validateInput', () => {
  it('accepts a complete announce rule', () => {
    expect(hasErrors(validateInput(valid(), EVENTS))).toBe(false)
  })

  it('requires a name of at most 100 characters', () => {
    expect(validateInput(valid({ name: '  ' }), EVENTS).name).toBe(
      'eventActions.validation.nameRequired',
    )
    expect(validateInput(valid({ name: 'x'.repeat(101) }), EVENTS).name).toBe(
      'eventActions.validation.nameTooLong',
    )
    expect(validateInput(valid({ name: 'x'.repeat(100) }), EVENTS).name).toBeUndefined()
  })

  it('requires a known event, wildcard or *', () => {
    expect(validateInput(valid({ eventPattern: '' }), EVENTS).eventPattern).toBe(
      'eventActions.validation.eventRequired',
    )
    expect(validateInput(valid({ eventPattern: 'player.fly' }), EVENTS).eventPattern).toBe(
      'eventActions.validation.eventUnknown',
    )
    expect(validateInput(valid({ eventPattern: 'ghost.*' }), EVENTS).eventPattern).toBe(
      'eventActions.validation.eventUnknown',
    )
    expect(validateInput(valid({ eventPattern: 'player.*' }), EVENTS).eventPattern).toBeUndefined()
    expect(validateInput(valid({ eventPattern: '*' }), EVENTS).eventPattern).toBeUndefined()
  })

  it('checks the text of the chosen action type only', () => {
    expect(validateInput(valid({ message: ' ' }), EVENTS).message).toBe(
      'eventActions.validation.messageRequired',
    )
    expect(validateInput(valid({ actionType: 'command', command: '' }), EVENTS).command).toBe(
      'eventActions.validation.commandRequired',
    )
    // an empty message is irrelevant for a command rule, and nothing is needed for a backup
    expect(
      validateInput(valid({ actionType: 'command', command: '/say hi', message: '' }), EVENTS)
        .message,
    ).toBeUndefined()
    expect(hasErrors(validateInput(valid({ actionType: 'backup', message: '' }), EVENTS))).toBe(
      false,
    )
  })

  it('requires a command to start with a slash', () => {
    const rule = (command: string) => valid({ actionType: 'command', command })
    expect(validateInput(rule('say hi'), EVENTS).command).toBe(
      'eventActions.validation.commandSlash',
    )
    expect(validateInput(rule(' /say hi {player}'), EVENTS).command).toBeUndefined()
    expect(validateInput(rule(''), EVENTS).command).toBe('eventActions.validation.commandRequired')
  })

  it('rejects over-long and multi-line text', () => {
    expect(validateInput(valid({ message: 'x'.repeat(501) }), EVENTS).message).toBe(
      'eventActions.validation.textTooLong',
    )
    expect(validateInput(valid({ message: 'line one\nline two' }), EVENTS).message).toBe(
      'eventActions.validation.textMultiline',
    )
  })
})

describe('events', () => {
  it('matches the server rules for patterns', () => {
    expect(isKnownPattern('player.joined', EVENTS)).toBe(true)
    expect(isKnownPattern('backup.*', EVENTS)).toBe(true)
    expect(isKnownPattern('Backup.*', EVENTS)).toBe(false)
    expect(isKnownPattern('x'.repeat(65), EVENTS)).toBe(false)
  })

  it('groups the catalog by category in server order', () => {
    expect(groupEvents(EVENTS)).toEqual([
      { category: 'player', wildcard: 'player.*', events: ['player.joined', 'player.left'] },
      { category: 'backup', wildcard: 'backup.*', events: ['backup.completed'] },
      { category: 'server', wildcard: 'server.*', events: ['server.crashed'] },
      { category: 'mod', wildcard: 'mod.*', events: ['mod.installed'] },
    ])
  })
})

describe('placeholders', () => {
  it('offers the player for join and leave events, the backup name for backup events', () => {
    expect(placeholdersFor('player.joined')).toEqual(['player', 'uuid', 'event', 'serverId'])
    expect(placeholdersFor('backup.completed')).toEqual(['name', 'event', 'serverId'])
    expect(placeholdersFor('server.crashed')).toEqual(['event', 'serverId'])
  })

  it('finds each placeholder once', () => {
    expect(placeholdersIn('{player} and {player} on {serverId}')).toEqual(['player', 'serverId'])
  })

  it('flags placeholders that carry free event text', () => {
    expect(freeTextPlaceholders('say {player} {message} {reason}')).toEqual(['message', 'reason'])
    expect(freeTextPlaceholders('say {player} {uuid} {serverId} {event}')).toEqual([])
  })

  it('warns about free text only for command rules', () => {
    expect(localWarnings({ actionType: 'command', command: 'kick {player} {reason}' })).toEqual([
      { code: 'free_text_placeholder', message: '', placeholders: ['reason'] },
    ])
    expect(localWarnings({ actionType: 'command', command: 'kick {player}' })).toEqual([])
    expect(localWarnings({ actionType: 'announce', command: '{reason}' })).toEqual([])
  })

  it('keeps one warning per code and prefers the server one', () => {
    const merged = mergeWarnings(
      [{ code: 'free_text_placeholder', message: '', placeholders: ['a'] }],
      [
        { code: 'free_text_placeholder', message: 'server', placeholders: ['a', 'b'] },
        { code: 'log_events_run_no_commands', message: 'x', events: ['player.joined'] },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ code: 'free_text_placeholder', message: 'server' })
  })
})

describe('templates', () => {
  it('only uses action types and events the server knows', () => {
    for (const tpl of RULE_TEMPLATES) {
      expect(['announce', 'backup']).toContain(tpl.actionType)
      expect(isKnownPattern(tpl.eventPattern, EVENTS), tpl.id).toBe(true)
    }
  })

  it('hides templates whose event the server does not offer', () => {
    const ids = availableTemplates(['player.joined']).map((tpl) => tpl.id)
    expect(ids).toEqual(['welcome'])
  })

  it('builds a valid editor state from a template', () => {
    const welcome = RULE_TEMPLATES.find((tpl) => tpl.id === 'welcome')!
    const input = inputFromTemplate(welcome, (key) => `[${key}]`, 'srv-b')
    expect(input).toMatchObject({
      name: '[eventActions.templates.welcome.name]',
      message: '[eventActions.templates.welcome.message]',
      serverId: 'srv-b',
      eventPattern: 'player.joined',
      actionType: 'announce',
      enabled: true,
    })
    expect(hasErrors(validateInput(input, EVENTS))).toBe(false)
  })

  it('leaves the message empty for backup templates', () => {
    const backup = RULE_TEMPLATES.find((tpl) => tpl.actionType === 'backup')!
    const input = inputFromTemplate(backup, (key) => key)
    expect(input.message).toBe('')
    expect(hasErrors(validateInput(input, EVENTS))).toBe(false)
  })

  // Guards against the event catalog dropping a name a template relies on.
  it('uses events that exist in the backend catalog', () => {
    for (const tpl of RULE_TEMPLATES)
      expect(eventCatalogSource, tpl.id).toContain(`'${tpl.eventPattern}'`)
  })
})

describe('isManagedRule', () => {
  it('recognizes the rule the scheduler keeps', () => {
    expect(isManagedRule({ createdBy: 'scheduler' })).toBe(true)
    expect(isManagedRule({ createdBy: 'alice' })).toBe(false)
  })
})
