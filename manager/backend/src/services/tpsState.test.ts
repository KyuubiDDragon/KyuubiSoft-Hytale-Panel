/**
 * Per-world TPS state fed by the plugin's tps_update frames, and the
 * low-TPS decision the watchdog makes on it (relative to the target rate).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./eventBus.js', () => ({ eventBus: { subscribe: vi.fn() } }));

import {
  clearTpsState,
  DEFAULT_TARGET_TPS,
  findLaggingWorld,
  getWorldTicks,
  recordServerTick,
  slowestWorld,
  tpsRatio,
} from './tpsState.js';
import { tpsFields } from './perfHistory.js';

vi.mock('./docker.js', () => ({ getStats: vi.fn() }));
vi.mock('./servers.js', () => ({ getDefaultId: vi.fn(async () => 'default') }));

const NOW = 1_000_000;
const FRESH = 60_000;

function tick(world: string, tps: number, extra: Record<string, unknown> = {}) {
  return { serverId: 'srv', world, tps, mspt: 1.5, targetTps: 30, ...extra };
}

beforeEach(() => clearTpsState());

describe('recordServerTick', () => {
  it('keeps the latest frame per server and world', () => {
    recordServerTick(tick('default', 29), NOW);
    recordServerTick(tick('default', 30), NOW + 1);
    recordServerTick(tick('dungeon-1', 12), NOW + 2);

    const worlds = getWorldTicks('srv', FRESH, NOW + 3);
    expect(worlds.map((w) => [w.world, w.tps])).toEqual([
      ['default', 30],
      ['dungeon-1', 12],
    ]);
  });

  it('reads the 1 min average from the windows', () => {
    recordServerTick(
      tick('default', 30, {
        windows: [
          { window: '10s', tpsAvg: 30 },
          { window: '1m', tpsAvg: 21.5 },
        ],
      }),
      NOW,
    );
    expect(getWorldTicks('srv', FRESH, NOW)[0].tps1m).toBe(21.5);
  });

  it('assumes the Hytale default target when a frame has none', () => {
    recordServerTick({ serverId: 'srv', tps: 30, mspt: 33.3 }, NOW);
    const [w] = getWorldTicks('srv', FRESH, NOW);
    expect(w.targetTps).toBe(DEFAULT_TARGET_TPS);
    expect(w.world).toBe('');
  });

  it('ignores frames without a numeric TPS', () => {
    recordServerTick({ serverId: 'srv', tps: 'fast' }, NOW);
    recordServerTick(null, NOW);
    expect(getWorldTicks('srv', FRESH, NOW)).toEqual([]);
  });

  it('keeps the servers apart and drops frames without a server id', () => {
    recordServerTick({ tps: 25, targetTps: 30 }, NOW);
    recordServerTick({ serverId: 'other', tps: 12, targetTps: 30 }, NOW);
    expect(getWorldTicks('srv', FRESH, NOW)).toEqual([]);
    expect(getWorldTicks('other', FRESH, NOW)).toHaveLength(1);
  });

  it('drops stale readings', () => {
    recordServerTick(tick('default', 30), NOW);
    expect(getWorldTicks('srv', FRESH, NOW + FRESH + 1)).toEqual([]);
    expect(slowestWorld('srv', FRESH, NOW + FRESH + 1)).toBeNull();
  });
});

describe('slowestWorld', () => {
  it('picks the world with the lowest TPS relative to its target', () => {
    recordServerTick(tick('default', 24, { targetTps: 30 }), NOW); // 80 %
    recordServerTick(tick('arena', 18, { targetTps: 20 }), NOW); // 90 %
    recordServerTick(tick('dungeon', 21, { targetTps: 30 }), NOW); // 70 %
    expect(slowestWorld('srv', FRESH, NOW)?.world).toBe('dungeon');
  });

  it('computes the ratio against the target, not against 20', () => {
    expect(tpsRatio({ tps: 30, targetTps: 30 })).toBe(1);
    expect(tpsRatio({ tps: 20, targetTps: 30 })).toBeCloseTo(0.667, 3);
  });
});

describe('findLaggingWorld', () => {
  const percent75 = { absolute: null, percent: 75 };

  it('does not alert at the full Hytale rate (the old 20-TPS bug)', () => {
    recordServerTick(tick('default', 30), NOW);
    expect(findLaggingWorld(getWorldTicks('srv', FRESH, NOW), percent75)).toBeNull();
  });

  it('alerts below 75 % of the target (22.5 of 30)', () => {
    recordServerTick(tick('default', 22), NOW);
    const lag = findLaggingWorld(getWorldTicks('srv', FRESH, NOW), percent75);
    expect(lag?.tick.world).toBe('default');
    expect(lag?.limit).toBe(22.5);
  });

  it('judges on the 1 min average when present, so one slow 10 s window is no alarm', () => {
    recordServerTick(tick('default', 10, { windows: [{ window: '1m', tpsAvg: 29 }] }), NOW);
    expect(findLaggingWorld(getWorldTicks('srv', FRESH, NOW), percent75)).toBeNull();

    recordServerTick(tick('default', 29, { windows: [{ window: '1m', tpsAvg: 15 }] }), NOW);
    expect(findLaggingWorld(getWorldTicks('srv', FRESH, NOW), percent75)?.tps).toBe(15);
  });

  it('reports the worst of several lagging worlds', () => {
    recordServerTick(tick('a', 20), NOW);
    recordServerTick(tick('b', 5), NOW);
    expect(findLaggingWorld(getWorldTicks('srv', FRESH, NOW), percent75)?.tick.world).toBe('b');
  });

  it('honors a legacy absolute threshold', () => {
    recordServerTick(tick('default', 16), NOW);
    const ticks = getWorldTicks('srv', FRESH, NOW);
    expect(findLaggingWorld(ticks, { absolute: 15, percent: 75 })).toBeNull();
    expect(findLaggingWorld(ticks, { absolute: 18, percent: 75 })?.limit).toBe(18);
  });
});

describe('perfHistory tpsFields', () => {
  it('stores the target with the TPS so charts can scale to it', () => {
    recordServerTick(tick('default', 28.66, { mspt: 0.437 }), NOW);
    expect(tpsFields(slowestWorld('srv', FRESH, NOW))).toEqual({
      tps: 28.7,
      targetTps: 30,
      world: 'default',
      mspt: 0.44,
    });
  });

  it('records a gap without a reading', () => {
    expect(tpsFields(null)).toEqual({ tps: null, targetTps: null, world: null, mspt: null });
  });
});
