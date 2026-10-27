import { describe, it, expect, afterEach } from 'vitest';
import { forwardModEvent } from './modEvents.js';
import { eventBus, subscribe, type PanelEvent as PluginSignal } from './eventBus.js';
import { parsePluginEvent, type ModEvent } from '../schemas/pluginEvents.js';
import type { PanelEvent } from '../schemas/events.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function capture() {
  const domain: PanelEvent[] = [];
  const signals: PluginSignal[] = [];
  cleanups.push(subscribe(['mod.*'], (e) => domain.push(e)));
  cleanups.push(eventBus.subscribe(['mod_event'], (e) => signals.push(e)));
  return { domain, signals };
}

const levelUp: ModEvent = {
  type: 'mod_event',
  timestamp: '2026-10-22T12:00:00Z',
  modId: 'kyuubisoft:pets',
  event: 'pet_level_up',
  payload: {
    player: 'Steve',
    level: 10,
    shiny: false,
    modId: 'spoofed',
    'bad key': 'x',
    stats: { atk: 3 },
  },
};

describe('mod_event wire format', () => {
  it('parses a mod event from the plugin', () => {
    const parsed = parsePluginEvent({ ...levelUp });
    expect(parsed.ok).toBe(true);
  });

  it('accepts a mod event without payload', () => {
    const { payload: _payload, ...bare } = levelUp;
    expect(parsePluginEvent(bare).ok).toBe(true);
  });

  it('rejects a malformed mod id or event type', () => {
    expect(parsePluginEvent({ ...levelUp, modId: 'Pets!' }).ok).toBe(false);
    expect(parsePluginEvent({ ...levelUp, event: 'Level Up' }).ok).toBe(false);
  });
});

describe('forwardModEvent', () => {
  it('publishes mod.event with scalar fields as placeholders and the full payload', () => {
    const { domain } = capture();
    forwardModEvent('default', levelUp);
    expect(domain).toHaveLength(1);
    const evt = domain[0];
    expect(evt.name).toBe('mod.event');
    expect(evt.serverId).toBe('default');
    expect(evt.payload).toMatchObject({
      modId: 'kyuubisoft:pets',
      event: 'pet_level_up',
      player: 'Steve',
      level: 10,
      shiny: false,
    });
    // a mod cannot overwrite the panel's own fields; unusable keys and objects stay nested only
    expect(evt.payload).not.toHaveProperty('bad key');
    expect(evt.payload).not.toHaveProperty('stats');
    expect(evt.payload.payload).toEqual(levelUp.payload);
    expect(Object.keys(evt.payload).slice(0, 2)).toEqual(['modId', 'event']);
  });

  it('publishes the mod_event signal for the replay recorder', () => {
    const { signals } = capture();
    forwardModEvent('second', levelUp);
    expect(signals).toHaveLength(1);
    expect(signals[0].payload).toEqual({
      modId: 'kyuubisoft:pets',
      event: 'pet_level_up',
      payload: levelUp.payload,
      serverId: 'second',
    });
  });
});
