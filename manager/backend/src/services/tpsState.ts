/**
 * Latest TPS per server and world, fed by the plugin's tps_update frames
 * (republished as `server_tick` by pluginEvents.ts).
 *
 * Plugin 2.1+ sends one frame per world every 5 s with the world's target
 * rate. Hytale ticks at 30 TPS by default and every world runs on its own
 * thread, so "server TPS" is judged per world and relative to its target:
 * the world with the lowest ratio is the one whose players feel lag first.
 */
import { eventBus, type PanelEvent } from './eventBus.js';
import { onServerDeleted } from './servers.js';

/** Hytale's default tick rate; used when a frame carries no target. */
export const DEFAULT_TARGET_TPS = 30;
/** Key for frames without a world name (plugin builds before 2.1). */
const UNNAMED_WORLD = '';

export interface WorldTick {
  world: string;
  /** 10 s average. */
  tps: number;
  /** 10 s average tick time in ms (compute time). */
  mspt: number | null;
  targetTps: number;
  /** 1 min average, when the plugin sends windows. */
  tps1m: number | null;
  /** Epoch ms when the panel received it. */
  at: number;
}

interface TickPayload {
  serverId?: unknown;
  world?: unknown;
  tps?: unknown;
  mspt?: unknown;
  targetTps?: unknown;
  windows?: unknown;
}

const latest = new Map<string, Map<string, WorldTick>>();
let subscribed = false;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function minuteAverage(windows: unknown): number | null {
  if (!Array.isArray(windows)) return null;
  for (const w of windows as Array<{ window?: unknown; tpsAvg?: unknown }>) {
    if (w && w.window === '1m' && finite(w.tpsAvg)) return w.tpsAvg;
  }
  return null;
}

/**
 * Store one server_tick payload. Frames without a numeric TPS are ignored, and
 * so are frames without a server id: pluginEvents.ts adds it to every frame,
 * and one that cannot be placed must not count for any server.
 */
export function recordServerTick(payload: unknown, now: number = Date.now()): void {
  const p = (payload ?? {}) as TickPayload;
  if (!finite(p.tps)) return;
  if (typeof p.serverId !== 'string' || !p.serverId) return;
  const serverId = p.serverId;
  const world = typeof p.world === 'string' ? p.world : UNNAMED_WORLD;
  const targetTps = finite(p.targetTps) && p.targetTps > 0 ? p.targetTps : DEFAULT_TARGET_TPS;
  let worlds = latest.get(serverId);
  if (!worlds) {
    worlds = new Map();
    latest.set(serverId, worlds);
  }
  worlds.set(world, {
    world,
    tps: p.tps,
    mspt: finite(p.mspt) ? p.mspt : null,
    targetTps,
    tps1m: minuteAverage(p.windows),
    at: now,
  });
}

/** TPS as a fraction of the world's target (1 = full speed). */
export function tpsRatio(tick: Pick<WorldTick, 'tps' | 'targetTps'>): number {
  return tick.targetTps > 0 ? tick.tps / tick.targetTps : 1;
}

/** Fresh readings of a server's worlds (younger than maxAgeMs). */
export function getWorldTicks(
  serverId: string,
  maxAgeMs: number,
  now: number = Date.now(),
): WorldTick[] {
  const worlds = latest.get(serverId);
  if (!worlds) return [];
  return [...worlds.values()].filter((t) => now - t.at < maxAgeMs);
}

/** The fresh world with the lowest TPS relative to its target, or null. */
export function slowestWorld(
  serverId: string,
  maxAgeMs: number,
  now: number = Date.now(),
): WorldTick | null {
  let slowest: WorldTick | null = null;
  for (const tick of getWorldTicks(serverId, maxAgeMs, now)) {
    if (!slowest || tpsRatio(tick) < tpsRatio(slowest)) slowest = tick;
  }
  return slowest;
}

export interface LowTpsThreshold {
  /** Absolute TPS (legacy WATCHDOG_TPS_ALERT); wins over percent when set. */
  absolute: number | null;
  /** Percent of the world's target TPS. */
  percent: number;
}

/**
 * The world that lags most, or null. Judged on the 1 min average when the
 * plugin sends it (one slow 10 s window is not sustained lag), else on the
 * 10 s value. Returns the TPS the decision was based on and the limit.
 */
export function findLaggingWorld(
  ticks: WorldTick[],
  threshold: LowTpsThreshold,
): { tick: WorldTick; tps: number; limit: number } | null {
  let worst: { tick: WorldTick; tps: number; limit: number; ratio: number } | null = null;
  for (const tick of ticks) {
    const tps = tick.tps1m ?? tick.tps;
    const limit =
      threshold.absolute !== null ? threshold.absolute : (tick.targetTps * threshold.percent) / 100;
    if (limit <= 0 || tps >= limit) continue;
    const ratio = tpsRatio({ tps, targetTps: tick.targetTps });
    if (!worst || ratio < worst.ratio) worst = { tick, tps, limit, ratio };
  }
  return worst ? { tick: worst.tick, tps: worst.tps, limit: worst.limit } : null;
}

/** Forget a server's readings (server deleted, tests). Without id: all. */
export function clearTpsState(serverId?: string): void {
  if (serverId === undefined) latest.clear();
  else latest.delete(serverId);
}

/** Subscribe to server_tick once; safe to call from every consumer. */
export function startTpsState(): void {
  if (subscribed) return;
  subscribed = true;
  eventBus.subscribe(['server_tick'], (evt: PanelEvent) => recordServerTick(evt.payload));
  onServerDeleted((serverId) => clearTpsState(serverId));
}
