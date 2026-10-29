import { logger } from '../utils/logger.js';
/**
 * Replay Recorder (V3.1.2)
 *
 * Records every plugin signal of a server passing through {@link eventBus}
 * plus that server's latest player-location snapshot into gzip-compressed
 * NDJSON segments rotated every 30 minutes. Each server records on its own:
 * a segment only holds events of its server.
 *
 * Storage layout (the server's folder from services/perServerData.ts; for
 * the compose server the manager data folder as before):
 *   <serverDir>/replay/<segmentId>/ticks.ndjson.gz
 *   <serverDir>/replay/<segmentId>/manifest.json
 *
 * The recorder is OPT-IN via `config.json.replay.recordingEnabled` (for every
 * server) and is idempotent — calling `applyReplayConfig` while running
 * re-evaluates the desired state.
 */

import { gzipSync, createGunzip } from 'zlib';
import { mkdir, readFile, writeFile, readdir, stat, rm } from 'fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { eventBus, type PanelEvent } from './eventBus.js';
import * as locations from './playerLocations.js';
import { getConfig, updateConfig } from './configService.js';
import { listServers, onServerAdded, onServerDeleted } from './servers.js';
import { managerDataDir } from './perServerData.js';

const SEGMENT_DURATION_MS = 30 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5 * 1000;
const TICK_INTERVAL_MS = 5 * 1000;

export interface ReplayManifest {
  id: string;
  /** Server the segment was recorded on; missing in segments from before per-server replays. */
  serverId?: string;
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
  serverId: string;
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

// Recording segment per server id, and starts still under way.
const active = new Map<string, ActiveSegment>();
const starting = new Map<string, Promise<void>>();
let pruneTimer: NodeJS.Timeout | null = null;
let lifecycleHooksRegistered = false;
const exportTokens = new Map<string, { segmentId: string; expiresAt: number; zipPath: string }>();

/** Folder of a server's segments. */
function replayRoot(serverId: string): string {
  return path.join(managerDataDir(serverId), 'replay');
}

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
      retentionDays:
        typeof r.retentionDays === 'number' && r.retentionDays > 0 ? r.retentionDays : 7,
    };
  } catch {
    return defaultReplayConfig();
  }
}

export async function setReplayConfig(
  next: Partial<ReplayConfigSlice>,
): Promise<ReplayConfigSlice> {
  const current = await getReplayConfig();
  const merged: ReplayConfigSlice = {
    recordingEnabled: next.recordingEnabled ?? current.recordingEnabled,
    retentionDays:
      typeof next.retentionDays === 'number' && next.retentionDays > 0
        ? next.retentionDays
        : current.retentionDays,
  };
  try {
    // We attach the slice to the full panel config but do not declare it in
    // PanelConfig.replay (kept loosely typed for forward compatibility).
    await updateConfig({ replay: merged } as unknown as Parameters<typeof updateConfig>[0]);
  } catch (err) {
    logger.error('[replay] failed to persist config:', err);
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
  try {
    sizeBytes = (await stat(seg.filePath)).size;
  } catch {
    /* not yet flushed */
  }
  const manifest: ReplayManifest = {
    id: seg.id,
    serverId: seg.serverId,
    startedAt: new Date(seg.startedAt).toISOString(),
    endedAt: new Date(Math.min(Date.now(), seg.endsAt)).toISOString(),
    durationMs: Math.min(Date.now(), seg.endsAt) - seg.startedAt,
    playerCount: seg.uniquePlayers.size,
    eventCount: seg.totalEvents,
    sizeBytes,
  };
  await writeFile(seg.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

async function startSegment(serverId: string): Promise<ActiveSegment> {
  const id = newSegmentId();
  const dir = path.join(replayRoot(serverId), id);
  await ensureDir(dir);
  const filePath = path.join(dir, 'ticks.ndjson.gz');
  const manifestPath = path.join(dir, 'manifest.json');
  const startedAt = Date.now();

  const seg: ActiveSegment = {
    id,
    serverId,
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

  // Every plugin signal carries its server (pluginEvents.ts, playerPresence.ts).
  seg.unsubscribeBus = eventBus.subscribe('*', (evt: PanelEvent) => {
    if (evt.payload.serverId !== serverId) return;
    seg.bufferedEvents.push(evt);
    seg.totalEvents++;
    const player =
      (evt.payload as { player?: string; playerName?: string }).player ??
      (evt.payload as { playerName?: string }).playerName;
    if (player) seg.uniquePlayers.add(player);
  });

  seg.flushTimer = setInterval(() => {
    flushSegment(seg).catch((err) => logger.error('[replay] flush error:', err));
  }, FLUSH_INTERVAL_MS);
  seg.flushTimer.unref?.();

  // Snapshot the server's player positions every TICK_INTERVAL_MS even when
  // the bus is quiet — this is the data layer the player will scrub on.
  seg.tickTimer = setInterval(() => {
    const snap = locations.getLatestSnapshot(serverId);
    for (const s of snap) {
      seg.bufferedEvents.push({
        name: 'player_position',
        ts: Date.now(),
        payload: s as unknown as Record<string, unknown>,
      });
      seg.totalEvents++;
      seg.uniquePlayers.add(s.playerName);
    }
  }, TICK_INTERVAL_MS);
  seg.tickTimer.unref?.();

  await writeManifest(seg);
  logger.info(`[replay:${serverId}] segment started: ${id}`);
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
  logger.info(
    `[replay:${seg.serverId}] segment closed: ${seg.id} (events=${seg.totalEvents}, players=${seg.uniquePlayers.size})`,
  );
}

async function startRecording(serverId: string): Promise<void> {
  if (active.has(serverId)) return;
  // A start already under way for this server: wait for it, never open a second segment.
  const pending = starting.get(serverId);
  if (pending) return pending;
  const start = (async () => {
    await ensureDir(replayRoot(serverId));
    active.set(serverId, await startSegment(serverId));
  })().finally(() => starting.delete(serverId));
  starting.set(serverId, start);
  return start;
}

async function stopRecording(serverId: string): Promise<void> {
  await starting.get(serverId)?.catch(() => undefined);
  const seg = active.get(serverId);
  if (!seg) return;
  active.delete(serverId);
  await stopSegment(seg);
}

async function rotateServer(serverId: string, seg: ActiveSegment): Promise<void> {
  const next = await startSegment(serverId);
  if (active.get(serverId) !== seg) {
    // Stopped meanwhile: the new segment is not wanted.
    await stopSegment(next);
    return;
  }
  active.set(serverId, next);
  await stopSegment(seg);
}

async function rotateIfNeeded(): Promise<void> {
  for (const [serverId, seg] of [...active]) {
    if (Date.now() < seg.endsAt) continue;
    // One server failing (full disk, no access) must not keep the others from rotating.
    try {
      await rotateServer(serverId, seg);
    } catch (err) {
      logger.error(`[replay:${serverId}] rotate error:`, err);
    }
  }
}

// Drives both rotation checks and retention pruning.
function startBackgroundLoop(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    rotateIfNeeded().catch((err) => logger.error('[replay] rotate error:', err));
    pruneRetention().catch((err) => logger.error('[replay] prune error:', err));
  }, 60 * 1000);
  pruneTimer.unref?.();
}

function stopBackgroundLoop(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

function registerLifecycleHooks(): void {
  if (lifecycleHooksRegistered) return;
  lifecycleHooksRegistered = true;
  onServerAdded(async (server) => {
    if ((await getReplayConfig()).recordingEnabled) await startRecording(server.id);
  });
  onServerDeleted((serverId) => stopRecording(serverId));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function applyReplayConfig(): Promise<void> {
  const cfg = await getReplayConfig();
  registerLifecycleHooks();

  if (cfg.recordingEnabled) {
    const servers = await listServers().catch((err) => {
      logger.error('[replay] could not list the servers:', err);
      return [];
    });
    for (const s of servers) {
      try {
        await startRecording(s.id);
      } catch (err) {
        logger.error(`[replay:${s.id}] could not start recording:`, err);
      }
    }
    startBackgroundLoop();
  } else if (active.size > 0) {
    for (const serverId of [...active.keys()]) await stopRecording(serverId);
    stopBackgroundLoop();
  }
}

export async function initializeReplay(): Promise<void> {
  await applyReplayConfig();
}

export async function shutdownReplay(): Promise<void> {
  for (const serverId of [...active.keys()]) await stopRecording(serverId);
  stopBackgroundLoop();
}

/** A server's segments, newest first. */
export async function listSegments(serverId: string): Promise<ReplayManifest[]> {
  const root = replayRoot(serverId);
  try {
    await ensureDir(root);
    const dirs = await readdir(root);
    const out: ReplayManifest[] = [];
    for (const d of dirs) {
      const mp = path.join(root, d, 'manifest.json');
      try {
        const content = await readFile(mp, 'utf-8');
        out.push({ serverId, ...(JSON.parse(content) as ReplayManifest) });
      } catch {
        /* skip incomplete segments */
      }
    }
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return out;
  } catch (err) {
    logger.error('[replay] listSegments error:', err);
    return [];
  }
}

export async function getManifest(id: string, serverId: string): Promise<ReplayManifest | null> {
  const safe = sanitiseId(id);
  if (!safe) return null;
  try {
    const content = await readFile(path.join(replayRoot(serverId), safe, 'manifest.json'), 'utf-8');
    return { serverId, ...(JSON.parse(content) as ReplayManifest) };
  } catch {
    return null;
  }
}

/** The recorded file of one of a server's segments, or null. */
function segmentFile(id: string, serverId: string): { safe: string; file: string } | null {
  const safe = sanitiseId(id);
  if (!safe) return null;
  const file = path.join(replayRoot(serverId), safe, 'ticks.ndjson.gz');
  return existsSync(file) ? { safe, file } : null;
}

export function streamSegment(id: string, serverId: string): NodeJS.ReadableStream | null {
  const found = segmentFile(id, serverId);
  return found ? createReadStream(found.file) : null;
}

export async function deleteSegment(id: string, serverId: string): Promise<boolean> {
  const safe = sanitiseId(id);
  if (!safe) return false;
  const dir = path.join(replayRoot(serverId), safe);
  if (!existsSync(dir)) return false;
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    logger.error('[replay] deleteSegment error:', err);
    return false;
  }
}

export interface ExportToken {
  token: string;
  expiresAt: number;
}

export async function createExportToken(id: string, serverId: string): Promise<ExportToken | null> {
  const found = segmentFile(id, serverId);
  if (!found) return null;
  const token = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + 5 * 60 * 1000;
  exportTokens.set(token, { segmentId: found.safe, expiresAt, zipPath: found.file });
  return { token, expiresAt };
}

export function consumeExportToken(
  token: string,
): { filePath: string; downloadName: string } | null {
  const entry = exportTokens.get(token);
  if (!entry) return null;
  exportTokens.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return { filePath: entry.zipPath, downloadName: `replay-${entry.segmentId}.ndjson.gz` };
}

// Optional: open a Node stream that re-emits each NDJSON tick. Used by the SSE
// route. We decompress on the fly so the client doesn't have to.
export function openTicksStream(id: string, serverId: string): NodeJS.ReadableStream | null {
  const found = segmentFile(id, serverId);
  if (!found) return null;
  const raw = createReadStream(found.file);
  const gunzip = createGunzip();
  raw.pipe(gunzip);
  return gunzip;
}

async function pruneServer(serverId: string, cutoff: number): Promise<void> {
  const root = replayRoot(serverId);
  if (!existsSync(root)) return;
  const dirs = await readdir(root);
  for (const d of dirs) {
    // Don't touch the active segment.
    if (active.get(serverId)?.id === d) continue;
    const mp = path.join(root, d, 'manifest.json');
    try {
      const content = await readFile(mp, 'utf-8');
      const m = JSON.parse(content) as ReplayManifest;
      if (new Date(m.endedAt).getTime() < cutoff) {
        await rm(path.join(root, d), { recursive: true, force: true });
        logger.info(`[replay:${serverId}] pruned segment ${d}`);
      }
    } catch {
      /* skip */
    }
  }
}

async function pruneRetention(): Promise<void> {
  const cfg = await getReplayConfig();
  const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
  const servers = await listServers().catch(() => []);
  for (const s of servers) {
    try {
      await pruneServer(s.id, cutoff);
    } catch (err) {
      logger.error(`[replay:${s.id}] retention error:`, err);
    }
  }
}

function sanitiseId(id: string): string | null {
  if (!id) return null;
  // Allow only timestamp-ish ids: digits, letters, dashes.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}
