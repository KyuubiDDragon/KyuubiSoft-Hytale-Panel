/**
 * Which server a panel event is about.
 *
 * Most events concern one server: lifecycle, players, backups, worlds, mods,
 * updates. Callers that ran against the default server (legacy routes) may
 * publish them without an id; those mean the default server. Account and
 * panel events (logins, users, roles, panel updates) concern no server.
 */
import type { PanelEvent } from '../schemas/events.js';
import { resolveServerId } from './servers.js';

const PANEL_WIDE_PREFIXES = ['auth.', 'user.', 'role.', 'panel.'];

/** True for events about the panel itself rather than one server. */
export function isPanelWideEvent(name: string): boolean {
  return PANEL_WIDE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The server an event concerns (resolved), or null for a panel-wide event. */
export async function eventServerId(
  event: Pick<PanelEvent, 'name' | 'serverId'>,
): Promise<string | null> {
  if (event.serverId) return event.serverId;
  if (isPanelWideEvent(event.name)) return null;
  return resolveServerId(undefined);
}
