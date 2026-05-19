/**
 * Runtime-validated schemas for events emitted by the KyuubiSoft API plugin.
 *
 * The plugin is a Java JAR loaded into the Hytale server; its event payloads
 * are wire-format from a separate codebase that can drift out of sync with
 * the panel between Hytale updates. Validating with Zod gives us:
 *   - A typed handler surface (TypeScript types are inferred from the schemas)
 *   - Loud failure with the actual offending payload when the plugin's
 *     contract changes, instead of silently consuming malformed data
 */

import { z } from 'zod';

const baseEvent = {
  timestamp: z.string(),
};

export const PlayerChatEventSchema = z.object({
  ...baseEvent,
  type: z.literal('player_chat'),
  player: z.string(),
  uuid: z.string().optional(),
  message: z.string(),
});

export const PlayerDeathEventSchema = z.object({
  ...baseEvent,
  type: z.literal('player_death'),
  player: z.string(),
  cause: z.string(),
  world: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
});

export const PlayerJoinEventSchema = z.object({
  ...baseEvent,
  type: z.literal('player_join'),
  player: z.string(),
  uuid: z.string(),
});

export const PlayerLeaveEventSchema = z.object({
  ...baseEvent,
  type: z.literal('player_leave'),
  player: z.string(),
  uuid: z.string(),
});

export const PluginEventSchema = z.discriminatedUnion('type', [
  PlayerChatEventSchema,
  PlayerDeathEventSchema,
  PlayerJoinEventSchema,
  PlayerLeaveEventSchema,
]);

export type PlayerChatEvent = z.infer<typeof PlayerChatEventSchema>;
export type PlayerDeathEvent = z.infer<typeof PlayerDeathEventSchema>;
export type PlayerJoinEvent = z.infer<typeof PlayerJoinEventSchema>;
export type PlayerLeaveEvent = z.infer<typeof PlayerLeaveEventSchema>;
export type PluginEvent = z.infer<typeof PluginEventSchema>;

export function parsePluginEvent(raw: unknown):
  | { ok: true; event: PluginEvent }
  | { ok: false; error: string } {
  const result = PluginEventSchema.safeParse(raw);
  if (result.success) return { ok: true, event: result.data };
  return { ok: false, error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
