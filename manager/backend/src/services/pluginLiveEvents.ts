/**
 * Forwards the plugin's live-data events (plugin 2.1+) to the panel event
 * bus, so webhooks, notifications and event actions can bind to them. The
 * panel event names are declared in schemas/events.ts.
 */

import { publish } from './eventBus.js';
import type {
  PermissionChangedEvent,
  PlayerGamemodeEvent,
  PlayerJoinDeniedEvent,
  PluginStateEvent,
  ServerShutdownEvent,
  WorldAddedEvent,
  WorldRemovedEvent,
} from '../schemas/pluginEvents.js';

export type LiveDataEvent =
  | PlayerGamemodeEvent
  | PlayerJoinDeniedEvent
  | WorldAddedEvent
  | WorldRemovedEvent
  | ServerShutdownEvent
  | PluginStateEvent
  | PermissionChangedEvent;

export function forwardLiveEvent(serverId: string, event: LiveDataEvent): void {
  switch (event.type) {
    case 'player_gamemode':
      publish(
        'player.gamemode_changed',
        {
          player: event.player,
          uuid: event.uuid,
          world: event.world,
          from: event.from,
          to: event.to,
        },
        serverId,
      );
      break;

    case 'player_join_denied':
      // The name comes from a refused connection: quote it so it cannot forge log lines.
      console.log(`[JoinDenied:${serverId}] ${JSON.stringify(event.player)} (${event.kind})`);
      publish(
        'player.join_denied',
        {
          player: event.player,
          uuid: event.uuid,
          kind: event.kind,
          reason: event.reason,
          reasonId: event.reasonId,
        },
        serverId,
      );
      break;

    case 'world_added':
      publish('world.added', { world: event.world }, serverId);
      break;

    case 'world_removed':
      publish(
        'world.removed',
        {
          world: event.world,
          reason: event.reason,
          serverShuttingDown: event.serverShuttingDown ?? false,
        },
        serverId,
      );
      break;

    case 'server_shutdown':
      console.log(`[Shutdown:${serverId}] ${event.reason ?? 'unknown reason'}`);
      publish(
        'server.shutdown',
        { reason: event.reason, exitCode: event.exitCode, message: event.message },
        serverId,
      );
      break;

    case 'plugin_state':
      if (event.to === 'FAILED') {
        console.warn(
          `[PluginState:${serverId}] ${event.plugin} failed${event.error?.message ? `: ${JSON.stringify(event.error.message)}` : ''}`,
        );
      }
      publish(
        'plugin.state_changed',
        {
          plugin: event.plugin,
          name: event.name,
          version: event.version,
          from: event.from,
          to: event.to,
          error: event.error?.message ?? event.error?.type,
        },
        serverId,
      );
      break;

    case 'permission_changed':
      publish(
        'permissions.changed',
        {
          scope: event.scope,
          action: event.action,
          uuid: event.uuid,
          player: event.player,
          group: event.group,
          permissions: event.permissions,
        },
        serverId,
      );
      break;
  }
}
