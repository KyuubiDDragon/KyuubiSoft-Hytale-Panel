/**
 * Replay Recorder (V3.1.2)
 *
 * Records every event passing through {@link eventBus} plus the latest
 * player-location snapshot into gzip-compressed NDJSON segments rotated
 * every 30 minutes.
 *
 * Storage layout:
 *   <dataPath>/replay/<segmentId>/ticks.ndjson.gz
 *   <dataPath>/replay/<segmentId>/manifest.json
 *
 * The recorder is OPT-IN via `config.json.replay.recordingEnabled` and is
 * idempotent — calling `applyReplayConfig` while running re-evaluates the
 * desired state.
 */

import { gzipSync, createGunzip } from 'zlib';
import { mkdir, readFile, writeFile, readdir, stat, rm } from 'fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { eventBus, type PanelEvent } from './eventBus.js';
import * as locations from './playerLocations.js';
import { getConfig, updateConfig } from './configService.js';

const DATA_PATH = process.env.MANAGER_DATA_PATH || '/app/data';
const REPLAY_ROOT = path.join(DATA_PATH, 'replay');
const SEGMENT_DURATION_MS = 30 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5 * 1000;
const TICK_INTERVAL_MS = 5 * 1000;

export interface ReplayManifest {
  id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  playerCount: number;
  eventCount: number;
  sizeBytes: number;
}

interface ReplayConfigSlice {
  recordingEnabled: boolean;
  retentionDays: number;
}

interface ActiveSegment {
  id: string;
  dir: string;
  filePath: string;
  manifestPath: string;
  startedAt: number;
  endsAt: number;
  bufferedEvents: PanelEvent[];
  totalEvents: number;
  uniquePlayers: Set<string>;
  flushTimer: NodeJS.Timeout | null;
  tickTimer: NodeJS.Timeout | null;
  unsubscribeBus: (() => void) | null;
}

let active: ActiveSegment | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
const exportTokens = new Map<string, { segmentId: string; expiresAt: number; zipPath: string }>();

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function defaultReplayConfig(): ReplayConfigSlice {
  return { recordingEnabled: false, retentionDays: 7 };
}

interface ConfigWithReplay {
  replay?: Partial<ReplayConfigSlice>;
}

export async function getReplayConfig(): Promise<ReplayConfigSlice> {
  try {
    const cfg = (await getConfig()) as unknown as ConfigWithReplay;
    const r = cfg.replay ?? {};
    return {
      recordingEnabled: r.recordingEnabled ?? false,
      retentionDays: typeof r.retentionDays === 'number' && r.retentionDays > 0 ? r.retentionDays : 7,
    };
  } catch {
    return defaultReplayConfig();
  }
}

export async function setReplayConfig(next: Partial<ReplayConfigSlice>): Promise<ReplayConfigSlice> {
  const current = await getReplayConfig();
  const merged: ReplayConfigSlice = {
    recordingEnabled: next.recordingEnabled ?? current.recordingEnabled,
    retentionDays: typeof next.retentionDays === 'number' && next.retentionDays > 0
      ? next.retentionDays
      : current.retentionDays,
  };
  try {
    // We attach the slice to the full panel config but do not declare it in
    // PanelConfig.replay (kept loosely typed for forward compatibility).
    await updateConfig({ replay: merged } as unknown as Parameters<typeof updateConfig>[0]);
  } catch (err) {
    console.error('[replay] failed to persist config:', err);
  }
  await applyReplayConfig();
  return merged;
}

// ---------------------------------------------------------------------------
// Segment lifecycle
// ---------------------------------------------------------------------------

function newSegmentId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${randomBytes(3).toString('hex')}`;
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function appendGz(filePath: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  // gzip is a streamable format — concatenating gzip members produces a valid
  // gzip stream that decompressors handle transparently.
  const data = lines.join('\n') + '\n';
  const gz = gzipSync(Buffer.from(data, 'utf-8'));
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(filePath, { flags: 'a' });
    ws.on('error', reject);
    ws.on('finish', resolve);
    ws.end(gz);
  });
}

async function writeManifest(seg: ActiveSegment): Promise<void> {
  let sizeBytes = 0;
  try { sizeBytes = (await stat(seg.filePath)).size; } catch { /* not yet flushed */ }
  const manifest: ReplayManifest = {
    id: seg.id,
    startedAt: new Date(seg.startedAt).toISOString(),
    endedAt: new Date(Math.min(Date.now(), seg.endsAt)).toISOString(),
    durationMs: Math.min(Date.now(), seg.endsAt) - seg.startedAt,
    playerCount: seg.uniquePlayers.size,
    eventCount: seg.totalEvents,
    sizeBytes,
  };
  await writeFile(seg.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

async function startSegment(): Promise<ActiveSegment> {
  const id = newSegmentId();
  const dir = path.join(REPLAY_ROOT, id);
  await ensureDir(dir);
  const filePath = path.join(dir, 'ticks.ndjson.gz');
  const manifestPath = path.join(dir, 'manifest.json');
  const startedAt = Date.now();

  const seg: ActiveSegment = {
    id,
    dir,
    filePath,
    manifestPath,
    startedAt,
    endsAt: startedAt + SEGMENT_DURATION_MS,
    bufferedEvents: [],
    totalEvents: 0,
    uniquePlayers: new Set(),
    flushTimer: null,
    tickTimer: null,
    unsubscribeBus: null,
  };

  seg.unsubscribeBus = eventBus.subscribe('*', (evt: PanelEvent) => {
    seg.bufferedEvents.push(evt);
    seg.totalEvents++;
    const player = (evt.payload as { player?: string; playerName?: string }).player
      ?? (evt.payload as { playerName?: string }).playerName;
    if (player) seg.uniquePlayers.add(player);
  });

  seg.flushTimer = setInterval(() => { flushSegment(seg).catch((err) => console.error('[replay] flush error:', err)); }, FLUSH_INTERVAL_MS);
  seg.flushTimer.unref?.();

  // Snapshot all player positions every TICK_INTERVAL_MS even when the bus is
  // quiet — this is the data layer the player will scrub on.
  seg.tickTimer = setInterval(() => {
    const snap = locations.getLatestSnapshot();
    for (const s of snap) {
      seg.bufferedEvents.push({ name: 'player_position', ts: Date.now(), payload: s as unknown as Record<string, unknown> });
      seg.totalEvents++;
      seg.uniquePlayers.add(s.playerName);
    }
  }, TICK_INTERVAL_MS);
  seg.tickTimer.unref?.();

  await writeManifest(seg);
  console.log(`[replay] segment started: ${id}`);
  return seg;
}

async function flushSegment(seg: ActiveSegment): Promise<void> {
  if (seg.bufferedEvents.length === 0) return;
  const lines = seg.bufferedEvents.map((e) => JSON.stringify(e));
  seg.bufferedEvents = [];
  await appendGz(seg.filePath, lines);
  await writeManifest(seg);
}

async function stopSegment(seg: ActiveSegment): Promise<void> {
  if (seg.flushTimer) clearInterval(seg.flushTimer);
  if (seg.tickTimer) clearInterval(seg.tickTimer);
  if (seg.unsubscribeBus) seg.unsubscribeBus();
  await flushSegment(seg);
  await writeManifest(seg);
  console.log(`[replay] segment closed: ${seg.id} (events=${seg.totalEvents}, players=${seg.uniquePlayers.size})`);
}

async function rotateIfNeeded(): Promise<void> {
  if (!active) return;
  if (Date.now() >= active.endsAt) {
    const oldSeg = active;
    active = await startSegment();
    await stopSegment(oldSeg);
  }
}

// Drives both rotation checks and retention pruning.
function startBackgroundLoop(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    rotateIfNeeded().catch((err) => console.error('[replay] rotate error:', err));
    pruneRetention().catch((err) => console.error('[replay] prune error:', err));
  }, 60 * 1000);
  pruneTimer.unref?.();
}

function stopBackgroundLoop(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function applyReplayConfig(): Promise<void> {
  const cfg = await getReplayConfig();

  if (cfg.recordingEnabled && !active) {
    await ensureDir(REPLAY_ROOT);
    active = await startSegment();
    startBackgroundLoop();
  } else if (!cfg.recordingEnabled && active) {
    const seg = active;
    active = null;
    await stopSegment(seg);
    stopBackgroundLoop();
  }
}

export async function initializeReplay(): Promise<void> {
  await applyReplayConfig();
}

export async function shutdownReplay(): Promise<void> {
  if (active) {
    const seg = active;
    active = null;
    await stopSegment(seg);
  }
  stopBackgroundLoop();
}

export async function listSegments(): Promise<ReplayManifest[]> {
  try {
    await ensureDir(REPLAY_ROOT);
    const dirs = await readdir(REPLAY_ROOT);
    const out: ReplayManifest[] = [];
    for (const d of dirs) {
      const mp = path.join(REPLAY_ROOT, d, 'manifest.json');
      try {
        const content = await readFile(mp, 'utf-8');
        out.push(JSON.parse(content) as ReplayManifest);
      } catch { /* skip incomplete segments */ }
    }
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return out;
  } catch (err) {
    console.error('[replay] listSegments error:', err);
    return [];
  }
}

export async function getManifest(id: string): Promise<ReplayManifest | null> {
  const safe = sanitiseId(id);
  if (!safe) return null;
  try {
    const content = await readFile(path.join(REPLAY_ROOT, safe, 'manifest.json'), 'utf-8');
    return JSON.parse(content) as ReplayManifest;
  } catch {
    return null;
  }
}

export function streamSegment(id: string): NodeJS.ReadableStream | null {
  const safe = sanitiseId(id);
  if (!safe) return null;
  const fp = path.join(REPLAY_ROOT, safe, 'ticks.ndjson.gz');
  if (!existsSync(fp)) return null;
  return createReadStream(fp);
}

export async function deleteSegment(id: string): Promise<boolean> {
  const safe = sanitiseId(id);
  if (!safe) return false;
  const dir = path.join(REPLAY_ROOT, safe);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error('[replay] deleteSegment error:', err);
    return false;
  }
}

export interface ExportToken { token: string; expiresAt: number; }

export async function createExportToken(id: string): Promise<ExportToken | null> {
  const safe = sanitiseId(id);
  if (!safe) return null;
  const fp = path.join(REPLAY_ROOT, safe, 'ticks.ndjson.gz');
  if (!existsSync(fp)) return null;
  const token = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + 5 * 60 * 1000;
  exportTokens.set(token, { segmentId: safe, expiresAt, zipPath: fp });
  return { token, expiresAt };
}

export function consumeExportToken(token: string): { filePath: string; downloadName: string } | null {
  const entry = exportTokens.get(token);
  if (!entry) return null;
  exportTokens.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return { filePath: entry.zipPath, downloadName: `replay-${entry.segmentId}.ndjson.gz` };
}

// Optional: open a Node stream that re-emits each NDJSON tick. Used by the SSE
// route. We decompress on the fly so the client doesn't have to.
export function openTicksStream(id: string): NodeJS.ReadableStream | null {
  const safe = sanitiseId(id);
  if (!safe) return null;
  const fp = path.join(REPLAY_ROOT, safe, 'ticks.ndjson.gz');
  if (!existsSync(fp)) return null;
  const raw = createReadStream(fp);
  const gunzip = createGunzip();
  raw.pipe(gunzip);
  return gunzip;
}

async function pruneRetention(): Promise<void> {
  const cfg = await getReplayConfig();
  const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
  try {
    await ensureDir(REPLAY_ROOT);
    const dirs = await readdir(REPLAY_ROOT);
    for (const d of dirs) {
      // Don't touch the active segment.
      if (active && active.id === d) continue;
      const mp = path.join(REPLAY_ROOT, d, 'manifest.json');
      try {
        const content = await readFile(mp, 'utf-8');
        const m = JSON.parse(content) as ReplayManifest;
        if (new Date(m.endedAt).getTime() < cutoff) {
          await rm(path.join(REPLAY_ROOT, d), { recursive: true, force: true });
          console.log(`[replay] pruned segment ${d}`);
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    console.error('[replay] retention error:', err);
  }
}

function sanitiseId(id: string): string | null {
  if (!id) return null;
  // Allow only timestamp-ish ids: digits, letters, dashes.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

