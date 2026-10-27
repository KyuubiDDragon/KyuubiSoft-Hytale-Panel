/**
 * In-memory performance history ring buffer.
 *
 * Samples TPS/MSPT (from the plugin's per-world server_tick events) plus
 * CPU/memory (from the container stats) every {@link SAMPLE_INTERVAL_MS} and
 * keeps the last {@link MAX_SAMPLES} so the panel can draw time-series charts
 * without a persistent store. Transient by design — history resets on restart.
 *
 * TPS is the default server's slowest world relative to its target, stored
 * together with that target so the chart can scale to it (Hytale: 30 TPS).
 */
import { getStats } from './docker.js';
import { getDefaultId } from './servers.js';
import { slowestWorld, startTpsState, type WorldTick } from './tpsState.js';

export interface PerfSample {
  ts: number;
  tps: number | null;
  /** Target TPS of the world `tps` belongs to; null when there was no reading. */
  targetTps: number | null;
  /** World `tps` belongs to; null when there was no reading or no world name. */
  world: string | null;
  mspt: number | null;
  cpu: number | null;
  mem: number | null;
}

const MAX_SAMPLES = 360; // ~1 hour at 10s resolution
const SAMPLE_INTERVAL_MS = 10_000;
// A world that sent nothing for this long counts as "no reading" (gap).
const TPS_MAX_AGE_MS = 30_000;

const buffer: PerfSample[] = [];
let timer: NodeJS.Timeout | null = null;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The TPS part of a sample, from the slowest fresh world (or a gap). */
export function tpsFields(
  tick: WorldTick | null,
): Pick<PerfSample, 'tps' | 'targetTps' | 'world' | 'mspt'> {
  if (!tick) return { tps: null, targetTps: null, world: null, mspt: null };
  return {
    tps: round1(tick.tps),
    targetTps: tick.targetTps,
    world: tick.world || null,
    // Real tick times are often well below 1 ms; keep two decimals.
    mspt: tick.mspt !== null ? round2(tick.mspt) : null,
  };
}

async function sample(): Promise<void> {
  let cpu: number | null = null;
  let mem: number | null = null;
  try {
    const s = await getStats();
    if (typeof s.cpu_percent === 'number') cpu = round1(s.cpu_percent);
    if (typeof s.memory_percent === 'number') mem = round1(s.memory_percent);
  } catch {
    // Server may be down — record a gap (nulls) rather than dropping the tick.
  }
  let tick: WorldTick | null = null;
  try {
    tick = slowestWorld(await getDefaultId(), TPS_MAX_AGE_MS);
  } catch {
    // Registry not ready: no TPS for this sample.
  }
  buffer.push({ ts: Date.now(), ...tpsFields(tick), cpu, mem });
  while (buffer.length > MAX_SAMPLES) buffer.shift();
}

export function startPerfHistory(): void {
  if (timer) return;
  startTpsState();
  timer = setInterval(() => {
    sample().catch(() => {});
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  console.log('[perf] history sampling started');
}

export function getPerfHistory(): { intervalMs: number; samples: PerfSample[] } {
  return { intervalMs: SAMPLE_INTERVAL_MS, samples: buffer.slice() };
}
