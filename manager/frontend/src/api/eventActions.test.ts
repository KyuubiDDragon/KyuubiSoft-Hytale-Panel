import { describe, it, expect, vi, beforeEach } from 'vitest'

const { get, post, put, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))
vi.mock('./client', () => ({ default: { get, post, put, delete: del } }))

import {
  eventActionsApi,
  inputFromRule,
  toActionPayload,
  toCreateBody,
  toUpdateBody,
  type EventAction,
  type EventActionInput,
} from './eventActions'

const input = (over: Partial<EventActionInput> = {}): EventActionInput => ({
  name: '  Welcome  ',
  serverId: '',
  eventPattern: 'player.joined',
  actionType: 'announce',
  command: 'ignored',
  message: ' Hello {player}! ',
  enabled: true,
  ...over,
})

const rule = (over: Partial<EventAction> = {}): EventAction => ({
  id: 'r1',
  name: 'Welcome',
  serverId: null,
  eventPattern: 'player.joined',
  actionType: 'announce',
  actionPayload: { message: 'Hello {player}!' },
  enabled: true,
  createdBy: 'alice',
  createdAt: '2026-10-01T00:00:00.000Z',
  blockedReason: null,
  ...over,
})

describe('request bodies', () => {
  it('sends only the payload field of the chosen action type, trimmed', () => {
    expect(toActionPayload(input())).toEqual({ message: 'Hello {player}!' })
    expect(toActionPayload(input({ actionType: 'command', command: ' say hi ' }))).toEqual({
      command: 'say hi',
    })
    expect(toActionPayload(input({ actionType: 'backup' }))).toEqual({})
  })

  it('turns "every server" into null and trims the name', () => {
    expect(toCreateBody(input())).toEqual({
      name: 'Welcome',
      serverId: null,
      eventPattern: 'player.joined',
      actionType: 'announce',
      actionPayload: { message: 'Hello {player}!' },
      enabled: true,
    })
    expect(toCreateBody(input({ serverId: 'srv-b' })).serverId).toBe('srv-b')
  })

  it('sends the enabled flag with both create and update', () => {
    expect(toCreateBody(input())).toMatchObject({ enabled: true })
    expect(toCreateBody(input({ enabled: false }))).toMatchObject({ enabled: false })
    expect(toUpdateBody(input({ enabled: false }))).toMatchObject({ enabled: false })
  })
})

describe('inputFromRule', () => {
  it('maps a stored rule back to editor values', () => {
    expect(inputFromRule(rule({ serverId: 'srv-b', enabled: false }))).toEqual({
      name: 'Welcome',
      serverId: 'srv-b',
      eventPattern: 'player.joined',
      actionType: 'announce',
      command: '',
      message: 'Hello {player}!',
      enabled: false,
    })
  })

  it('maps a rule for every server to an empty server id', () => {
    expect(inputFromRule(rule()).serverId).toBe('')
  })
})

describe('eventActionsApi', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    put.mockReset()
    del.mockReset()
  })

  it('lists rules, events and action types', async () => {
    const overview = { rules: [rule()], events: ['player.joined'], actionTypes: ['announce'] }
    get.mockResolvedValue({ data: overview })
    await expect(eventActionsApi.list()).resolves.toEqual(overview)
    expect(get).toHaveBeenCalledWith('/event-actions')
  })

  it('creates an enabled rule with one request', async () => {
    post.mockResolvedValue({ data: { rule: rule(), warnings: [] } })
    await eventActionsApi.create(input())
    expect(post).toHaveBeenCalledTimes(1)
    expect(put).not.toHaveBeenCalled()
  })

  it('creates a disabled rule with a single request that carries the flag', async () => {
    post.mockResolvedValue({ data: { rule: rule({ enabled: false }), warnings: [] } })
    const saved = await eventActionsApi.create(input({ enabled: false }))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/event-actions', expect.objectContaining({ enabled: false }))
    expect(put).not.toHaveBeenCalled()
    expect(saved.rule.enabled).toBe(false)
  })

  it('toggles with a body of only the flag', async () => {
    put.mockResolvedValue({ data: { rule: rule(), warnings: [] } })
    await eventActionsApi.setEnabled('r1', false)
    expect(put).toHaveBeenCalledWith('/event-actions/r1', { enabled: false })
  })

  it('approves and unwraps the rule', async () => {
    post.mockResolvedValue({ data: { rule: rule({ createdBy: 'bob' }) } })
    await expect(eventActionsApi.approve('r1')).resolves.toMatchObject({ createdBy: 'bob' })
    expect(post).toHaveBeenCalledWith('/event-actions/r1/approve')
  })

  it('deletes by id', async () => {
    del.mockResolvedValue({ data: { success: true } })
    await eventActionsApi.remove('r1')
    expect(del).toHaveBeenCalledWith('/event-actions/r1')
  })
})
