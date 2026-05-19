/**
 * Canonical event catalog for the panel.
 *
 * Anything the panel emits to webhooks, notifications or the audit log
 * should be a member of PanelEventName. Adding an event here is the
 * single source of truth.
 */
import { z } from 'zod';

export const PanelEventNames = [
  'server.starting', 'server.started',
  'server.stopping', 'server.stopped', 'server.crashed',
  'player.joined', 'player.left', 'player.banned', 'player.kicked', 'player.death',
  'backup.started', 'backup.completed', 'backup.failed',
  'update.available', 'update.applied',
  'mod.installed', 'mod.uninstalled', 'mod.enabled', 'mod.disabled',
  'auth.login_success', 'auth.login_failed', 'auth.2fa_failed',
  'user.created', 'user.deleted', 'role.changed',
  'panel.update_available',
] as const;

export type PanelEventName = (typeof PanelEventNames)[number];

export const PanelEventSchema = z.object({
  name: z.enum(PanelEventNames),
  timestamp: z.string(),
  serverId: z.string().optional(),
  payload: z.record(z.unknown()),
});

export type PanelEvent = z.infer<typeof PanelEventSchema>;
