/**
 * Player Locations Service
 *
 * Maintains an in-memory 10 minute ring buffer of player positions per
 * server. Every sample carries its server; snapshots and history are always
 * read for one server.
 *
 * Data sources (priority order):
 *  1. `player_position` plugin events via {@link eventBus}. The KyuubiSoft Java
 *     plugin (v1.4.3+) emits these every ~2 s/player; services/pluginEvents.ts
 *     validates and republishes them onto the bus.
 *  2. Simulated movement when {@link isDemoMode} is true OR when no real
 *     position events arrive for a few seconds (graceful fallback so the
 *     LiveMap view always has something to render).
 */

import { eventBus, type PanelEvent } from './eventBus.js';
import { isDemoMode } from './demoData.js';
import { onServerDeleted } from './servers.js';
import { COMPOSE_SERVER_ID } from './perServerData.js';

export interface PlayerLocationSample {
  /** Registry id of the server the player is on. */
  serverId: string;
  playerName: string;
  uuid: string;
  x: number;
  y: number;
  z: number;
  world: string;
  latencyMs: number;
  ts: number; // epoch ms
}

interface SimulatedPlayerState {
  uuid: string;
  playerName: string;
  world: string;
  x: number;
  y: number;
  z: number;
  // movement vector (per tick)
  dx: number;
  dz: number;
  baseLatency: number;
}

const BUFFER_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const SIMULATION_TICK_MS = 1500;

// Ring buffer per server: uuid -> samples (sorted ascending by ts)
const buffers = new Map<string, Map<string, PlayerLocationSample[]>>();

// Listeners that get every new sample (used by WS route).
type Listener = (s: PlayerLocationSample) => void;
const listeners = new Set<Listener>();

let simTimer: NodeJS.Timeout | null = null;
const simPlayers: SimulatedPlayerState[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function pushSample(sample: PlayerLocationSample): void {
  let buffer = buffers.get(sample.serverId);
  if (!buffer) {
    buffer = new Map();
    buffers.set(sample.serverId, buffer);
  }
  let arr = buffer.get(sample.uuid);
  if (!arr) {
    arr = [];
    buffer.set(sample.uuid, arr);
  }
  arr.push(sample);

  // Trim entries older than the buffer window.
  const cutoff = Date.now() - BUFFER_DURATION_MS;
  while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();

  // Notify listeners.
  for (const l of listeners) {
    try {
      l(sample);
    } catch (err) {
      console.error('[playerLocations] listener error:', err);
    }
  }
}

/** The latest position of every player on one server. */
export function getLatestSnapshot(serverId: string): PlayerLocationSample[] {
  const out: PlayerLocationSample[] = [];
  for (const samples of buffers.get(serverId)?.values() ?? []) {
    if (samples.length > 0) out.push(samples[samples.length - 1]);
  }
  return out;
}

export interface HistoryQuery {
  serverId: string;
  from?: number;
  to?: number;
  playerUuid?: string;
}

export function getHistory(q: HistoryQuery): PlayerLocationSample[] {
  const from = q.from ?? Date.now() - BUFFER_DURATION_MS;
  const to = q.to ?? Date.now();
  const result: PlayerLocationSample[] = [];
  for (const [uuid, samples] of buffers.get(q.serverId)?.entries() ?? []) {
    if (q.playerUuid && uuid !== q.playerUuid) continue;
    for (const s of samples) {
      if (s.ts >= from && s.ts <= to) result.push(s);
    }
  }
  result.sort((a, b) => a.ts - b.ts);
  return result;
}

/** Called for every new sample of every server; listeners filter by `serverId`. */
export function addListener(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Forget a server's positions (server removed, tests). */
export function clearPlayerLocations(serverId: string): void {
  buffers.delete(serverId);
}

// ---------------------------------------------------------------------------
// Simulation (demo mode and fallback)
// ---------------------------------------------------------------------------

function seedSimulatedPlayers(): void {
  if (simPlayers.length > 0) return;
  const demoSeed: Array<Omit<SimulatedPlayerState, 'dx' | 'dz' | 'baseLatency'>> = [
    {
      uuid: '550e8400-e29b-41d4-a716-446655440001',
      playerName: 'KyuubiDDragon',
      world: 'Orbis',
      x: 120,
      y: 64,
      z: 80,
    },
    {
      uuid: '550e8400-e29b-41d4-a716-446655440002',
      playerName: 'DragonSlayer99',
      world: 'Orbis',
      x: -40,
      y: 70,
      z: 130,
    },
    {
      uuid: '550e8400-e29b-41d4-a716-446655440003',
      playerName: 'CrystalMiner',
      world: 'Orbis',
      x: 200,
      y: 55,
      z: -60,
    },
    {
      uuid: '550e8400-e29b-41d4-a716-446655440004',
      playerName: 'SkyBuilder',
      world: 'Orbis',
      x: 0,
      y: 90,
      z: 0,
    },
    {
      uuid: '550e8400-e29b-41d4-a716-446655440005',
      playerName: 'NightExplorer',
      world: 'Orbis',
      x: -180,
      y: 62,
      z: -150,
    },
  ];
  for (const p of demoSeed) {
    simPlayers.push({
      ...p,
      dx: (Math.random() - 0.5) * 4,
      dz: (Math.random() - 0.5) * 4,
      baseLatency: 25 + Math.random() * 120,
    });
  }
}

function simulationTick(): void {
  // Simulated players are a DEMO-ONLY convenience. On a real server an empty
  // map must honestly mean "no live position data" — we never render fake
  // players. Real positions require the KyuubiSoft plugin (v1.4.3+) running and
  // emitting player_position events.
  if (!isDemoMode()) return;

  seedSimulatedPlayers();
  const now = Date.now();
  for (const p of simPlayers) {
    // Random walk with occasional direction change
    if (Math.random() < 0.1) {
      p.dx = (Math.random() - 0.5) * 4;
      p.dz = (Math.random() - 0.5) * 4;
    }
    p.x += p.dx;
    p.z += p.dz;
    // Keep inside a soft bounding box.
    if (Math.abs(p.x) > 400) p.dx *= -1;
    if (Math.abs(p.z) > 400) p.dz *= -1;
    p.y = 60 + Math.sin((p.x + p.z) / 40) * 8;

    // Latency jitters in a band around its base value.
    const latency = Math.max(5, p.baseLatency + (Math.random() - 0.5) * 30);

    pushSample({
      // Demo players walk on the compose server.
      serverId: COMPOSE_SERVER_ID,
      playerName: p.playerName,
      uuid: p.uuid,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      z: Math.round(p.z * 10) / 10,
      world: p.world,
      latencyMs: Math.round(latency),
      ts: now,
    });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let initialized = false;

export function initializePlayerLocations(): void {
  if (initialized) return;
  initialized = true;
  // Subscribe to player_position plugin events (emitted by the KyuubiSoft
  // plugin v1.4.3+ and republished by services/pluginEvents.ts, which adds
  // the server id). A frame without one cannot be placed and is dropped.
  eventBus.subscribe(['player_position'], (evt: PanelEvent) => {
    const p = evt.payload as Partial<PlayerLocationSample>;
    // uuid is optional in the plugin schema — fall back to playerName as a
    // stable id rather than dropping the frame (which would hide the player).
    if (!p.playerName || p.x === undefined || p.y === undefined || p.z === undefined) {
      return;
    }
    if (typeof p.serverId !== 'string' || !p.serverId) return;
    pushSample({
      serverId: p.serverId,
      playerName: String(p.playerName),
      uuid: String(p.uuid ?? p.playerName),
      x: Number(p.x),
      y: Number(p.y),
      z: Number(p.z),
      world: String(p.world ?? 'Orbis'),
      latencyMs: typeof p.latencyMs === 'number' ? p.latencyMs : 0,
      ts: evt.ts,
    });
  });

  // Also harvest death positions as one-shot samples (useful while we have
  // no continuous position stream).
  eventBus.subscribe(['player_death'], (evt: PanelEvent) => {
    const p = evt.payload as {
      player?: string;
      uuid?: string;
      world?: string;
      x?: number;
      y?: number;
      z?: number;
      serverId?: string;
    };
    if (!p.player || p.x === undefined || p.y === undefined || p.z === undefined) return;
    if (typeof p.serverId !== 'string' || !p.serverId) return;
    pushSample({
      serverId: p.serverId,
      playerName: p.player,
      // Plugin 2.1+ sends the UUID; older ones only the name.
      uuid: p.uuid ?? p.player,
      x: Number(p.x),
      y: Number(p.y),
      z: Number(p.z),
      world: String(p.world ?? 'Orbis'),
      latencyMs: 0,
      ts: evt.ts,
    });
  });

  onServerDeleted((serverId) => clearPlayerLocations(serverId));

  if (!simTimer) {
    simTimer = setInterval(simulationTick, SIMULATION_TICK_MS);
    // Don't keep the event loop alive just for the simulator.
    simTimer.unref?.();
  }
  console.log('[playerLocations] initialised (demoMode=' + isDemoMode() + ')');
}

export function stopPlayerLocations(): void {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
}
