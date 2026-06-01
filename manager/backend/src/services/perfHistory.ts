/**
 * In-memory performance history ring buffer.
 *
 * Samples TPS/MSPT (from the plugin's server_tick events) plus CPU/memory
 * (from the container stats) every {@link SAMPLE_INTERVAL_MS} and keeps the
 * last {@link MAX_SAMPLES} so the panel can draw time-series charts without a
 * persistent store. Transient by design — history resets on restart.
 */
import { eventBus, type PanelEvent } from './eventBus.js';
import { getStats } from './docker.js';

export interface PerfSample {
  ts: number;
  tps: number | null;
  mspt: number | null;
  cpu: number | null;
  mem: number | null;
}

const MAX_SAMPLES = 360; // ~1 hour at 10s resolution
const SAMPLE_INTERVAL_MS = 10_000;

const buffer: PerfSample[] = [];
let latestTps: number | null = null;
let latestMspt: number | null = null;
let timer: NodeJS.Timeout | null = null;

const round1 = (n: number): number => Math.round(n * 10) / 10;

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
  buffer.push({ ts: Date.now(), tps: latestTps, mspt: latestMspt, cpu, mem });
  while (buffer.length > MAX_SAMPLES) buffer.shift();
}

export function startPerfHistory(): void {
  if (timer) return;
  eventBus.subscribe(['server_tick'], (evt: PanelEvent) => {
    const p = evt.payload as { tps?: number; mspt?: number };
    if (typeof p.tps === 'number') latestTps = round1(p.tps);
    if (typeof p.mspt === 'number') latestMspt = round1(p.mspt);
  });
  timer = setInterval(() => { sample().catch(() => {}); }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  console.log('[perf] history sampling started');
}

export function getPerfHistory(): { intervalMs: number; samples: PerfSample[] } {
  return { intervalMs: SAMPLE_INTERVAL_MS, samples: buffer.slice() };
}
