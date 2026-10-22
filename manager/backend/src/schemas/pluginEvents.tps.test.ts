/**
 * Contract of tps_update and player_death as plugin 2.1 sends them. The tps
 * frame is a real one captured from the plugin on a 0.7.3 server.
 */
import { describe, it, expect } from 'vitest';
import { parsePluginEvent } from './pluginEvents.js';

const realTpsFrame = {
  type: 'tps_update',
  world: 'default',
  tps: 30.0,
  mspt: 0.649,
  targetTps: 30,
  tickBudgetMs: 33.333,
  windows: [
    {
      window: '10s',
      tpsAvg: 30.0,
      tpsMin: 16.84,
      tpsMax: 30.0,
      tickMsAvg: 0.649,
      tickMsMin: 0.069,
      tickMsMax: 59.369,
    },
    {
      window: '1m',
      tpsAvg: 30.0,
      tpsMin: 16.84,
      tpsMax: 30.0,
      tickMsAvg: 0.442,
      tickMsMin: 0.06,
      tickMsMax: 59.369,
    },
    {
      window: '5m',
      tpsAvg: 30.0,
      tpsMin: 5.95,
      tpsMax: 30.0,
      tickMsAvg: 3.1,
      tickMsMin: 0.05,
      tickMsMax: 168.0,
    },
  ],
  players: 0,
  entities: 1,
  loadedChunks: 0,
  timestamp: '2026-10-22T12:14:01.123Z',
};

describe('tps_update', () => {
  it('accepts the per-world frame of plugin 2.1', () => {
    const parsed = parsePluginEvent(realTpsFrame);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.event.type === 'tps_update') {
      expect(parsed.event.world).toBe('default');
      expect(parsed.event.targetTps).toBe(30);
      expect(parsed.event.windows?.[1].window).toBe('1m');
    }
  });

  it('still accepts a frame with only tps and mspt', () => {
    const parsed = parsePluginEvent({ type: 'tps_update', tps: 20, mspt: 50, timestamp: 'x' });
    expect(parsed.ok).toBe(true);
  });

  it('rejects a non-positive target', () => {
    expect(parsePluginEvent({ ...realTpsFrame, targetTps: 0 }).ok).toBe(false);
  });
});

describe('player_death', () => {
  it('accepts cause, killer and position', () => {
    const parsed = parsePluginEvent({
      type: 'player_death',
      player: 'Steve',
      uuid: '00000000-0000-0000-0000-000000000001',
      cause: 'Physical',
      killer: 'Alex',
      killerUuid: '00000000-0000-0000-0000-000000000002',
      killerType: 'player',
      world: 'default',
      x: 1.5,
      y: 64,
      z: -3.25,
      timestamp: '2026-10-22T12:00:00Z',
    });
    expect(parsed.ok).toBe(true);
  });

  it('accepts a death without a known killer', () => {
    const parsed = parsePluginEvent({
      type: 'player_death',
      player: 'Steve',
      cause: 'Fall',
      killerType: 'environment',
      timestamp: '2026-10-22T12:00:00Z',
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects an unknown killer type', () => {
    const parsed = parsePluginEvent({
      type: 'player_death',
      player: 'Steve',
      cause: 'Fall',
      killerType: 'meteor',
      timestamp: '2026-10-22T12:00:00Z',
    });
    expect(parsed.ok).toBe(false);
  });
});
