/**
 * Canonical event catalog for the panel.
 *
 * Anything the panel emits to webhooks, notifications or the audit log
 * should be a member of PanelEventName. Adding an event here is the
 * single source of truth.
 */
import { z } from 'zod';

export const PanelEventNames = [
  'server.starting',
  'server.started',
  'server.stopping',
  'server.stopped',
  'server.crashed',
  'server.restarted',
  'server.alert',
  // Sent by the plugin when the server begins shutting down, with its reason.
  'server.shutdown',
  'player.joined',
  'player.left',
  'player.banned',
  'player.kicked',
  'player.death',
  'player.gamemode_changed',
  'player.join_denied',
  'world.added',
  'world.removed',
  'plugin.state_changed',
  'permissions.changed',
  'backup.started',
  'backup.completed',
  'backup.failed',
  'update.available',
  'update.applied',
  'mod.installed',
  'mod.uninstalled',
  'mod.enabled',
  'mod.disabled',
  // An event a KS mod sent through the plugin (services/modEvents.ts): payload
  // { modId, event, payload, ...top-level scalar payload fields }.
  'mod.event',
  'auth.login_success',
  'auth.login_failed',
  'auth.2fa_failed',
  'user.created',
  'user.deleted',
  'role.changed',
  'panel.update_available',
] as const;

export type PanelEventName = (typeof PanelEventNames)[number];

/**
 * Events anyone can cause from outside, without an account: a refused join
 * carries whatever name the connecting client chose. Wildcard subscriptions
 * (`*`, `player.*`) never match them; only the exact name does, so rules and
 * webhooks written for signed-in players do not start firing for strangers.
 */
export const EXPLICIT_ONLY_EVENTS: ReadonlySet<string> = new Set<PanelEventName>([
  'player.join_denied',
]);

/**
 * Does a webhook or event-action subscription (`*`, `<category>.*` or an exact
 * name) cover the event `name`? Plain string comparison, no RegExp.
 */
export function eventPatternMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (EXPLICIT_ONLY_EVENTS.has(name)) return false;
  if (pattern === '*') return true;
  return pattern.endsWith('.*') && name.startsWith(pattern.slice(0, -1));
}

export const PanelEventSchema = z.object({
  name: z.enum(PanelEventNames),
  timestamp: z.string(),
  serverId: z.string().optional(),
  payload: z.record(z.unknown()),
});

export type PanelEvent = z.infer<typeof PanelEventSchema>;
