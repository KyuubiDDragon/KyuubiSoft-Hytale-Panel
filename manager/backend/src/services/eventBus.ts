/**
 * In-process event bus.
 *
 * Two consumer styles share the same bus:
 *  - Webhooks / notifications / audit sinks use the panel-event taxonomy
 *    declared in schemas/events.ts (`server.started`, `backup.completed`, ...)
 *    via `publish()` + `subscribe()`.
 *  - Replay recorder and live-player-map need raw Hytale plugin signals
 *    (`player_join`, `player_position`, ...) and use the named
 *    `eventBus.publish('player_position', {...})` shape exposed through
 *    the EventEmitter-based `eventBus` object.
 *
 * The two paths are intentionally independent — the panel-event names and
 * the Hytale plugin signals do not overlap, and each consumer subscribes
 * to the names it cares about.
 */
import { EventEmitter } from 'events';
import type { PanelEvent as PanelDomainEvent, PanelEventName as PanelDomainEventName } from '../schemas/events.js';

// ---------- Panel domain events (webhooks/notifications/audit) ----------

type Listener = (event: PanelDomainEvent) => void;
interface Subscription {
  patterns: string[];
  listener: Listener;
}

const subs: Subscription[] = [];

function matches(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

export function subscribe(patterns: string[], listener: Listener): () => void {
  const sub: Subscription = { patterns, listener };
  subs.push(sub);
  return () => {
    const i = subs.indexOf(sub);
    if (i >= 0) subs.splice(i, 1);
  };
}

export function publish(name: PanelDomainEventName, payload: Record<string, unknown> = {}, serverId?: string): void {
  const event: PanelDomainEvent = {
    name,
    timestamp: new Date().toISOString(),
    serverId,
    payload,
  };
  for (const sub of subs) {
    if (sub.patterns.some(p => matches(p, name))) {
      try {
        sub.listener(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[eventBus] listener threw for', name, err);
      }
    }
  }
}

// ---------- Hytale plugin signals (live-map, replay recorder) ----------

export type PanelEventName =
  | 'player_join'
  | 'player_leave'
  | 'player_chat'
  | 'player_death'
  | 'player_position'
  | 'server_tick';

export interface PanelEvent {
  name: PanelEventName;
  ts: number;
  payload: Record<string, unknown>;
}

class PanelEventBus extends EventEmitter {
  constructor() {
    super();
    // Replay + locations + chat log + future analytics
    this.setMaxListeners(50);
  }

  publish(name: PanelEventName, payload: Record<string, unknown>): void {
    const evt: PanelEvent = { name, ts: Date.now(), payload };
    this.emit(name, evt);
    this.emit('*', evt);
  }

  subscribe(names: PanelEventName[] | '*', handler: (evt: PanelEvent) => void): () => void {
    if (names === '*') {
      this.on('*', handler);
      return () => this.off('*', handler);
    }
    for (const n of names) this.on(n, handler);
    return () => {
      for (const n of names) this.off(n, handler);
    };
  }
}

export const eventBus = new PanelEventBus();
