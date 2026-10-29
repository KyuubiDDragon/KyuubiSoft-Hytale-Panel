import { describe, expect, it } from 'vitest'
import {
  NAV_ENTRIES,
  canOpen,
  firstOpenPath,
  quickEntries,
  routeNeedsAllServers,
  routePermission,
  visibleEntries,
} from './navigation'

const hasAll = () => true
const hasNone = () => false
const only =
  (...granted: string[]) =>
  (permission: string) =>
    granted.includes(permission)

describe('navigation list', () => {
  it('opens statistics with the permission its data needs', () => {
    expect(routePermission('statistics')).toBe('players.view')
    const names = (has: (p: string) => boolean) => visibleEntries(has).map((e) => e.name)
    expect(names(only('dashboard.stats'))).not.toContain('statistics')
    expect(names(only('players.view'))).toContain('statistics')
  })

  it('keeps pages with data of every server from accounts limited to some servers', () => {
    const has = only('activity.view', 'users.view')
    const open = (access: { hasServerList?: boolean }) =>
      visibleEntries(has, access).map((e) => e.name)
    expect(open({})).toContain('activity')
    expect(open({ hasServerList: false })).toContain('activity')
    expect(open({ hasServerList: true })).not.toContain('activity')
    expect(open({ hasServerList: true })).toContain('users')
    expect(routeNeedsAllServers('activity')).toBe(true)
    expect(routeNeedsAllServers('users')).toBe(false)
  })

  it('has unique route names and paths', () => {
    const names = NAV_ENTRIES.map((e) => e.name)
    const paths = NAV_ENTRIES.map((e) => e.path)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('looks up the permission of a route by name', () => {
    expect(routePermission('users')).toBe('users.view')
    expect(routePermission('eventActions')).toBe('scheduler.view')
    expect(routePermission('playerProfile')).toBe('players.view')
    // Open to every signed-in account.
    expect(routePermission('help')).toBeUndefined()
    expect(routePermission('security')).toBeUndefined()
    expect(routePermission('noSuchRoute')).toBeUndefined()
  })

  it('shows an account exactly the pages it may open', () => {
    const names = visibleEntries(only('users.view', 'console.view')).map((e) => e.name)
    expect(names).toContain('users')
    expect(names).toContain('console')
    expect(names).toContain('help')
    expect(names).not.toContain('roles')
    expect(names).not.toContain('dashboard')
  })

  it('shows everything to an account with every permission', () => {
    expect(visibleEntries(hasAll)).toHaveLength(NAV_ENTRIES.length)
  })

  it('keeps pages without a permission open for everyone', () => {
    expect(canOpen({ permission: undefined }, hasNone)).toBe(true)
    expect(canOpen({ permission: 'x.view' }, hasNone)).toBe(false)
  })

  it('orders the phone bar and drops pages the account may not open', () => {
    expect(quickEntries(hasAll).map((e) => e.name)).toEqual([
      'dashboard',
      'console',
      'players',
      'performance',
    ])
    expect(quickEntries(only('players.view', 'console.view')).map((e) => e.name)).toEqual([
      'console',
      'players',
    ])
  })

  it('finds a page to send someone to who may open nothing special', () => {
    expect(firstOpenPath(hasNone)).toBe('/help')
    expect(firstOpenPath(only('console.view'))).toBe('/console')
  })
})
