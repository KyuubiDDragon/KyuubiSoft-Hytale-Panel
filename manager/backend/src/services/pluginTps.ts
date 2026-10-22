/**
 * The TPS summary the Performance page shows, from plugin 2.1's
 * GET /api/server/tps. Values describe the slowest world (lowest TPS relative
 * to its target); `worlds` carries every world for the per-world table.
 */
import type { PluginServerTps, PluginWorldPerf } from './kyuubiApi.js';
import { DEFAULT_TARGET_TPS } from './tpsState.js';

export interface TpsMetrics {
  /** 10 s average. */
  current: number;
  /** 1 min average. */
  average: number;
  /** Lowest / highest TPS within 1 min. */
  min: number;
  max: number;
  target: number;
  /** Tick compute time in ms: 10 s and 1 min average. */
  msptCurrent: number;
  msptAverage: number;
  /** World these values belong to (plugin 2.1+). */
  world?: string;
  /** Every running world (plugin 2.1+). */
  worlds?: PluginWorldPerf[];
}

/** Null while no world runs (startup): there is nothing to report yet. */
export function tpsMetricsFromPlugin(data: PluginServerTps): TpsMetrics | null {
  const worlds = Array.isArray(data.worlds) ? data.worlds : [];
  if (worlds.length === 0) return null;
  const headline = worlds.find((w) => w.world === data.world) ?? worlds[0];
  const target = headline?.targetTps ?? data.targetTps ?? DEFAULT_TARGET_TPS;
  const shortest = headline?.windows?.[0];
  const minute = headline?.windows?.find((w) => w.window === '1m') ?? shortest;
  const current = headline?.tps ?? data.tps ?? target;
  return {
    current,
    average: minute?.tpsAvg ?? current,
    min: minute?.tpsMin ?? current,
    max: minute?.tpsMax ?? current,
    target,
    msptCurrent: headline?.mspt ?? data.mspt ?? 0,
    msptAverage: minute?.tickMsAvg ?? headline?.mspt ?? 0,
    world: headline?.world ?? data.world,
    worlds,
  };
}
