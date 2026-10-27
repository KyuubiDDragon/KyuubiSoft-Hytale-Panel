import { describe, it, expect, vi } from 'vitest';

vi.mock('./eventBus.js', () => ({ eventBus: { subscribe: vi.fn() } }));

import { tpsMetricsFromPlugin } from './pluginTps.js';
import type { PluginWorldPerf } from './kyuubiApi.js';

function world(name: string, tps: number, minuteAvg: number, targetTps = 30): PluginWorldPerf {
  return {
    world: name,
    targetTps,
    tickBudgetMs: 1000 / targetTps,
    tps,
    mspt: 2.5,
    windows: [
      {
        window: '10s',
        tpsAvg: tps,
        tpsMin: tps - 1,
        tpsMax: targetTps,
        tickMsAvg: 2.5,
        tickMsMin: 0.1,
        tickMsMax: 40,
      },
      {
        window: '1m',
        tpsAvg: minuteAvg,
        tpsMin: 12,
        tpsMax: targetTps,
        tickMsAvg: 3.1,
        tickMsMin: 0.1,
        tickMsMax: 80,
      },
      {
        window: '5m',
        tpsAvg: 29,
        tpsMin: 1,
        tpsMax: targetTps,
        tickMsAvg: 3.4,
        tickMsMin: 0.1,
        tickMsMax: 900,
      },
    ],
    players: 1,
    entities: 120,
    loadedChunks: 64,
  };
}

describe('tpsMetricsFromPlugin', () => {
  it('summarizes the headline world: 10 s now, 1 min average/min/max', () => {
    const data = {
      world: 'dungeon',
      tps: 21,
      mspt: 2.5,
      targetTps: 30,
      worlds: [world('default', 30, 30), world('dungeon', 21, 24)],
    };
    expect(tpsMetricsFromPlugin(data)).toMatchObject({
      current: 21,
      average: 24,
      min: 12,
      max: 30,
      target: 30,
      msptCurrent: 2.5,
      msptAverage: 3.1,
      world: 'dungeon',
    });
    expect(tpsMetricsFromPlugin(data)?.worlds).toHaveLength(2);
  });

  it('uses the target of the world, not a fixed 20', () => {
    const data = { world: 'arena', targetTps: 20, worlds: [world('arena', 20, 20, 20)] };
    expect(tpsMetricsFromPlugin(data)?.target).toBe(20);
  });

  it('reports nothing while no world runs (startup), instead of full speed', () => {
    expect(tpsMetricsFromPlugin({ targetTps: 30, worlds: [] })).toBeNull();
  });
});
