/**
 * Forwards `mod_event` frames (events KS mods send through the plugin's
 * PanelRegistry.publishEvent) to both event buses:
 *
 *  - panel domain event `mod.event` for webhooks, notifications and event
 *    actions. Top-level scalar payload fields are copied next to `modId` and
 *    `event`, so a rule can use {player} or {level} as placeholders; the
 *    full payload stays under `payload`.
 *  - plugin signal `mod_event` for the replay recorder.
 */
import { eventBus, publish } from './eventBus.js';
import type { ModEvent } from '../schemas/pluginEvents.js';

// Keys the panel sets itself; a mod field with the same name is not copied.
const RESERVED_KEYS = new Set(['modId', 'event', 'payload', 'serverId']);
// Event-action placeholders are {\w+}; other keys could never be used.
const PLACEHOLDER_KEY = /^\w{1,64}$/;

export function forwardModEvent(serverId: string, event: ModEvent): void {
  const payload = event.payload ?? {};
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED_KEYS.has(key) || !PLACEHOLDER_KEY.test(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      fields[key] = value;
    }
  }
  // modId/event first: Discord/Slack webhooks show the first ten fields.
  publish('mod.event', { modId: event.modId, event: event.event, ...fields, payload }, serverId);
  eventBus.publish('mod_event', { modId: event.modId, event: event.event, payload, serverId });
}
