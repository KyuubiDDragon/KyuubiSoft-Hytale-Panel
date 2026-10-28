/**
 * In-memory performance history ring buffer.
 *
 * Samples TPS/MSPT (from the plugin's per-world server_tick events) plus
 * CPU/memory (from the container stats) every {@link SAMPLE_INTERVAL_MS} and
 * keeps the last {@link MAX_SAMPLES} so the panel can draw time-series charts
 * without a persistent store. Transient by design — history resets on restart.
 *
 * Every registered server has its own buffer. TPS is that server's slowest
 * world relative to its target, stored together with that target so the
 * chart can scale to it (Hytale: 30 TPS).
 */
import { getStats } from './docker.js';
import { listServers, onServerDeleted, resolveServerId } from './servers.js';
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

const buffers = new Map<string, PerfSample[]>();
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

/** Takes one sample of a server into its buffer. */
export async function sampleServer(serverId: string, now: number = Date.now()): Promise<void> {
  let cpu: number | null = null;
  let mem: number | null = null;
  try {
    const s = await getStats(serverId);
    if (typeof s.cpu_percent === 'number') cpu = round1(s.cpu_percent);
    if (typeof s.memory_percent === 'number') mem = round1(s.memory_percent);
  } catch {
    // Server may be down — record a gap (nulls) rather than dropping the tick.
  }
  const tick: WorldTick | null = slowestWorld(serverId, TPS_MAX_AGE_MS, now);
  let buffer = buffers.get(serverId);
  if (!buffer) {
    buffer = [];
    buffers.set(serverId, buffer);
  }
  buffer.push({ ts: now, ...tpsFields(tick), cpu, mem });
  while (buffer.length > MAX_SAMPLES) buffer.shift();
}

let sampling = false;

async function sampleAll(): Promise<void> {
  // A slow Docker answer must not stack up sampling rounds.
  if (sampling) return;
  sampling = true;
  try {
    const servers = await listServers();
    await Promise.all(servers.map((s) => sampleServer(s.id).catch(() => {})));
  } finally {
    sampling = false;
  }
}

export function startPerfHistory(): void {
  if (timer) return;
  startTpsState();
  onServerDeleted((serverId) => {
    buffers.delete(serverId);
  });
  timer = setInterval(() => {
    sampleAll().catch(() => {});
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  console.log('[perf] history sampling started');
}

/** A server's samples, oldest first; `undefined` is the default server. */
export async function getPerfHistory(
  serverId?: string,
): Promise<{ intervalMs: number; samples: PerfSample[] }> {
  const id = await resolveServerId(serverId);
  return { intervalMs: SAMPLE_INTERVAL_MS, samples: (buffers.get(id) ?? []).slice() };
}
