/**
 * In-process event bus.
 *
 * Producers (docker watcher, plugin WS, scheduler, backup, auth, ...) call
 * publish(); consumers (webhook dispatcher, notifications, audit-sink)
 * subscribe with a list of event-name patterns. Patterns support an
 * optional trailing wildcard ('server.*' matches 'server.started' etc.).
 *
 * Listeners are invoked synchronously; expensive work should be pushed
 * to a queue inside the listener.
 */
import type { PanelEvent, PanelEventName } from '../schemas/events.js';

type Listener = (event: PanelEvent) => void;
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

export function publish(name: PanelEventName, payload: Record<string, unknown> = {}, serverId?: string): void {
  const event: PanelEvent = {
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
