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

// Sent by plugin 2.1+ from an ECS death system. cause is the damage cause id
// (e.g. "Physical", "Fall"); the killer fields are omitted when unknown.
export const PlayerDeathEventSchema = z.object({
  ...baseEvent,
  type: z.literal('player_death'),
  player: z.string(),
  uuid: z.string().optional(),
  cause: z.string(),
  killer: z.string().optional(),
  killerUuid: z.string().optional(),
  killerType: z.enum(['player', 'entity', 'environment', 'command']).optional(),
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

// Periodic per-player position frame used by LiveMap + Replay. The plugin emits
// one every `positionBroadcastIntervalMs` (default 2 s) while a WS client is
// connected. Optional fields are omitted by the plugin's Gson when unknown
// (world during transitions, ping before the first sample, etc.), so they are
// optional+nullable here.
export const PlayerPositionEventSchema = z.object({
  ...baseEvent,
  type: z.literal('player_position'),
  player: z.string(),
  uuid: z.string().optional(),
  world: z.string().nullable().optional(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  yaw: z.number().nullable().optional(),
  pitch: z.number().nullable().optional(),
  latencyMs: z.number().nullable().optional(),
});

// Tick metrics of one window ("10s", "1m", "5m"). tickMs is the time a tick
// took to compute, not the interval between ticks.
export const TpsWindowSchema = z.object({
  window: z.string(),
  tpsAvg: z.number(),
  tpsMin: z.number(),
  tpsMax: z.number(),
  tickMsAvg: z.number(),
  tickMsMin: z.number(),
  tickMsMax: z.number(),
});

// Plugin 2.1+ sends one per running world every 5 s while the panel listens.
// tps/mspt are the 10 s averages; Hytale ticks at 30 TPS by default, so
// thresholds must be relative to targetTps. World and the extra fields are
// optional so a frame without them (older plugin builds) still parses.
export const TpsUpdateEventSchema = z.object({
  ...baseEvent,
  type: z.literal('tps_update'),
  world: z.string().optional(),
  tps: z.number(),
  mspt: z.number(),
  targetTps: z.number().positive().optional(),
  tickBudgetMs: z.number().optional(),
  windows: z.array(TpsWindowSchema).optional(),
  players: z.number().int().optional(),
  entities: z.number().int().optional(),
  loadedChunks: z.number().int().optional(),
});

// ---- Live-data events (plugin 2.1+). Optional fields are omitted when unknown. ----

// Confirmed game mode change; cancelled changes are never sent.
export const PlayerGamemodeEventSchema = z.object({
  ...baseEvent,
  type: z.literal('player_gamemode'),
  player: z.string(),
  uuid: z.string().optional(),
  world: z.string().optional(),
  from: z.string().optional(),
  to: z.string(),
});

// A connection refused during setup. kind: banned / whitelist (join
// permission) / other (refused by a plugin).
export const PlayerJoinDeniedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('player_join_denied'),
  player: z.string(),
  uuid: z.string().optional(),
  kind: z.enum(['banned', 'whitelist', 'other']),
  reason: z.string().optional(),
  reasonId: z.string().optional(),
});

export const WorldAddedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('world_added'),
  world: z.string(),
});

// reason: GENERAL (normal unload) or EXCEPTIONAL (the world failed). During a
// server shutdown the server reports EXCEPTIONAL too; serverShuttingDown marks that.
export const WorldRemovedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('world_removed'),
  world: z.string(),
  reason: z.string().optional(),
  serverShuttingDown: z.boolean().optional(),
});

// Sent first when the server begins shutting down (reason e.g. SHUTDOWN,
// SIGINT, CRASH, UPDATE), so a planned stop can be told apart from a crash.
export const ServerShutdownEventSchema = z.object({
  ...baseEvent,
  type: z.literal('server_shutdown'),
  reason: z.string().optional(),
  exitCode: z.number().int().optional(),
  message: z.string().optional(),
});

// A plugin/mod changed its load state (ENABLED, FAILED, DISABLED, ...;
// NOT_LOADED and UNLOADED for plugins appearing or disappearing).
export const PluginStateEventSchema = z.object({
  ...baseEvent,
  type: z.literal('plugin_state'),
  plugin: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
  from: z.string(),
  to: z.string(),
  error: z
    .object({
      type: z.string(),
      message: z.string().optional(),
      wrapperType: z.string().optional(),
      wrapperMessage: z.string().optional(),
    })
    .optional(),
});

export const PermissionChangedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('permission_changed'),
  scope: z.enum(['user', 'group']),
  action: z.enum(['group_added', 'group_removed', 'permissions_added', 'permissions_removed']),
  uuid: z.string().optional(),
  player: z.string().optional(),
  group: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

// The set of registered commands changed (a plugin loaded, unloaded or
// reloaded its commands); revision is the plugin's command registry revision.
export const CommandsChangedEventSchema = z.object({
  ...baseEvent,
  type: z.literal('commands_changed'),
  revision: z.string(),
  count: z.number().int(),
});

// An event a KS mod sent through the plugin's PanelRegistry.publishEvent.
// The plugin already checked the ids and trimmed the payload (4 levels, 50
// entries, 1000 characters per text); the shape of `payload` is up to the mod.
export const ModEventSchema = z.object({
  ...baseEvent,
  type: z.literal('mod_event'),
  modId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/),
  event: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  payload: z.record(z.unknown()).optional(),
});

export const PluginEventSchema = z.discriminatedUnion('type', [
  PlayerChatEventSchema,
  PlayerDeathEventSchema,
  PlayerJoinEventSchema,
  PlayerLeaveEventSchema,
  PlayerPositionEventSchema,
  TpsUpdateEventSchema,
  PlayerGamemodeEventSchema,
  PlayerJoinDeniedEventSchema,
  WorldAddedEventSchema,
  WorldRemovedEventSchema,
  ServerShutdownEventSchema,
  PluginStateEventSchema,
  PermissionChangedEventSchema,
  CommandsChangedEventSchema,
  ModEventSchema,
]);

export type PlayerChatEvent = z.infer<typeof PlayerChatEventSchema>;
export type PlayerDeathEvent = z.infer<typeof PlayerDeathEventSchema>;
export type PlayerJoinEvent = z.infer<typeof PlayerJoinEventSchema>;
export type PlayerLeaveEvent = z.infer<typeof PlayerLeaveEventSchema>;
export type PlayerPositionEvent = z.infer<typeof PlayerPositionEventSchema>;
export type TpsUpdateEvent = z.infer<typeof TpsUpdateEventSchema>;
export type PlayerGamemodeEvent = z.infer<typeof PlayerGamemodeEventSchema>;
export type PlayerJoinDeniedEvent = z.infer<typeof PlayerJoinDeniedEventSchema>;
export type WorldAddedEvent = z.infer<typeof WorldAddedEventSchema>;
export type WorldRemovedEvent = z.infer<typeof WorldRemovedEventSchema>;
export type ServerShutdownEvent = z.infer<typeof ServerShutdownEventSchema>;
export type PluginStateEvent = z.infer<typeof PluginStateEventSchema>;
export type PermissionChangedEvent = z.infer<typeof PermissionChangedEventSchema>;
export type CommandsChangedEvent = z.infer<typeof CommandsChangedEventSchema>;
export type ModEvent = z.infer<typeof ModEventSchema>;
export type PluginEvent = z.infer<typeof PluginEventSchema>;

export function parsePluginEvent(
  raw: unknown,
): { ok: true; event: PluginEvent } | { ok: false; error: string } {
  const result = PluginEventSchema.safeParse(raw);
  if (result.success) return { ok: true, event: result.data };
  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}
