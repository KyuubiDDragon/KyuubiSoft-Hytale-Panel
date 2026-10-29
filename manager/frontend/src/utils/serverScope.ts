/**
 * Server scoping of API paths.
 *
 * Resources that belong to one game server are reachable as
 * `/api/servers/:id/<resource>/...`; the plain `/api/<resource>/...` form
 * acts on the default server. This module only rewrites paths and has no
 * dependencies, so it can be used (and tested) without the app.
 */

/** First path segments that belong to one game server. */
export const SERVER_BOUND_RESOURCES: ReadonlySet<string> = new Set([
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
])

/** First path segment of a path or URL (query and fragment ignored), lower-cased. */
function firstSegment(path: string): string {
  return (
    path
      .replace(/^\/+/, '')
      .split(/[/?#]/, 1)[0]
      .toLowerCase()
  )
}

/** Whether the path (relative to `/api`) addresses a server-bound resource. */
export function isServerBound(path: string): boolean {
  return SERVER_BOUND_RESOURCES.has(firstSegment(path))
}

/**
 * Rewrites a path relative to `/api` to the scoped form. Without a server id,
 * and for everything that is not server-bound, the path is returned as given.
 */
export function scopeUrl(path: string, serverId: string | null | undefined): string {
  if (!serverId || !isServerBound(path)) return path
  const rest = path.replace(/^\/+/, '')
  return `/servers/${encodeURIComponent(serverId)}/${rest}`
}

/** Absolute browser path (`/api/...`) of a path relative to `/api`. */
export function apiPath(path: string, serverId: string | null | undefined): string {
  return `/api${scopeUrl(path.startsWith('/') ? path : `/${path}`, serverId)}`
}

/**
 * Ticket-bound WebSocket URL for a socket resource below `/api`
 * (e.g. `console/ws`), scoped like any other path.
 */
export function wsPath(
  path: string,
  serverId: string | null | undefined,
  ticket: string,
  loc: { protocol: string; host: string },
): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}${apiPath(path, serverId)}?ticket=${encodeURIComponent(ticket)}`
}

/**
 * Picks the server to work on: the remembered one if still allowed, else the
 * default if allowed, else the first allowed one. `null` when none is left.
 */
export function resolveActiveId(
  allowedIds: readonly string[],
  defaultId: string | null,
  remembered: string | null,
): string | null {
  if (remembered && allowedIds.includes(remembered)) return remembered
  if (defaultId && allowedIds.includes(defaultId)) return defaultId
  return allowedIds[0] ?? null
}
