import { useServersStore } from '@/stores/servers'
import { apiPath, wsPath } from '@/utils/serverScope'

/** `/api/...` path of a resource on the server the panel currently works on. */
export function scopedApiUrl(path: string): string {
  return apiPath(path, useServersStore().scopeId)
}

/** WebSocket URL of a socket resource (e.g. `console/ws`) on the current server. */
export function scopedWsUrl(path: string, ticket: string): string {
  return wsPath(path, useServersStore().scopeId, ticket, window.location)
}
