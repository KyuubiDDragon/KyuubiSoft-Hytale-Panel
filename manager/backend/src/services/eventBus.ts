/**
 * Simple in-process event bus.
 *
 * Used to decouple producers (plugin WebSocket, simulators) from
 * consumers (replay recorder, location service, future analytics).
 */
import { EventEmitter } from 'events';

// Centralised, typed-ish event names used across the panel.
// Listeners can subscribe to specific names or '*' for all events.
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
    // Allow many subscribers (replay + locations + chat log etc.)
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
