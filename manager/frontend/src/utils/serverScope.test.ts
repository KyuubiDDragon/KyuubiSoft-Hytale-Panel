import { describe, expect, it } from 'vitest'
import { apiPath, isServerBound, resolveActiveId, scopeUrl, wsPath } from './serverScope'

describe('scopeUrl', () => {
  it.each([
    'server',
    'console',
    'backups',
    'players',
    'management',
    'scheduler',
    'files',
    'assets',
    'mod-panel',
    'replay',
    'webmap',
    'wiki',
  ])('rewrites %s to the scoped form', (resource) => {
    expect(scopeUrl(`/${resource}/x`, 'srv-2')).toBe(`/servers/srv-2/${resource}/x`)
  })

  it('rewrites players/locations along with players', () => {
    expect(scopeUrl('/players/locations', 'b')).toBe('/servers/b/players/locations')
  })

  it.each([
    'auth',
    'setup',
    'servers',
    'settings',
    'webhooks',
    'event-actions',
    'roles',
    'users',
    'api-keys',
    'audit',
    'health',
    'metrics',
  ])('never rewrites %s', (resource) => {
    expect(scopeUrl(`/${resource}/x`, 'srv-2')).toBe(`/${resource}/x`)
  })

  it('keeps the legacy URL without an active server', () => {
    expect(scopeUrl('/server/status', null)).toBe('/server/status')
    expect(scopeUrl('/server/status', undefined)).toBe('/server/status')
  })

  it('handles paths without a leading slash, a query and a bare resource', () => {
    expect(scopeUrl('backups', 'a')).toBe('/servers/a/backups')
    expect(scopeUrl('/files/download?rootId=r&path=%2Fa', 'a')).toBe(
      '/servers/a/files/download?rootId=r&path=%2Fa',
    )
    expect(scopeUrl('/server?x=1', 'a')).toBe('/servers/a/server?x=1')
  })

  it('does not rewrite an already scoped URL again', () => {
    const once = scopeUrl('/console/logs', 'a')
    expect(scopeUrl(once, 'a')).toBe(once)
  })

  it('does not mistake a longer name for a bound resource', () => {
    expect(isServerBound('/servers-extra/x')).toBe(false)
    expect(isServerBound('/server-info')).toBe(false)
  })

  it('encodes the server id', () => {
    expect(scopeUrl('/server/status', 'a/b')).toBe('/servers/a%2Fb/server/status')
  })
})

describe('apiPath and wsPath', () => {
  it('builds browser paths below /api', () => {
    expect(apiPath('/backups/1/download', 'b')).toBe('/api/servers/b/backups/1/download')
    expect(apiPath('backups/1/download', null)).toBe('/api/backups/1/download')
  })

  it('builds ticket-bound socket URLs, scoped and legacy', () => {
    const loc = { protocol: 'https:', host: 'panel.test' }
    expect(wsPath('console/ws', 'b', 't k', loc)).toBe(
      'wss://panel.test/api/servers/b/console/ws?ticket=t%20k',
    )
    expect(wsPath('players/locations/ws', null, 't', { protocol: 'http:', host: 'h' })).toBe(
      'ws://h/api/players/locations/ws?ticket=t',
    )
  })
})

describe('resolveActiveId', () => {
  it('prefers the remembered server, then the default, then the first allowed', () => {
    expect(resolveActiveId(['a', 'b', 'c'], 'b', 'c')).toBe('c')
    expect(resolveActiveId(['a', 'b', 'c'], 'b', 'zzz')).toBe('b')
    expect(resolveActiveId(['a', 'c'], 'b', null)).toBe('a')
    expect(resolveActiveId([], 'b', 'c')).toBeNull()
  })
})
