/**
 * Server update history + JAR rollback.
 *
 * The native Hytale update system (`/update apply`) swaps HytaleServer.jar in
 * place and restarts. That's convenient but one-way: a bad release leaves no
 * easy way back. This service adds two safety nets around it:
 *
 *   1. An append-only history log of every update the panel applied
 *      (from→to version, who, success) at <dataPath>/update-history.json.
 *   2. JAR snapshots: before applying an update the panel copies the current
 *      HytaleServer.jar (+ .hytale-version) into <serverPath>/.jar-snapshots/,
 *      keeping the last few. `rollbackToSnapshot` copies one back so a broken
 *      update can be reverted with a restart.
 *
 * The manager container bind-mounts the server dir (same UID 9999 as the game
 * container), so plain fs operations are enough — no docker exec needed.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getServer, getDefaultId } from './servers.js';
import { logger } from '../utils/logger.js';

const HISTORY_FILE = path.join(config.dataPath, 'update-history.json');
const SNAPSHOT_DIRNAME = '.jar-snapshots';
const MAX_HISTORY = 100;
const MAX_SNAPSHOTS = 5;
const JAR_NAME = 'HytaleServer.jar';
const VERSION_FILE = '.hytale-version';

export interface UpdateHistoryEntry {
  id: string;
  at: string;
  fromVersion: string | null;
  toVersion: string | null;
  action: 'apply' | 'rollback';
  by: string | null;
  success: boolean;
  note?: string;
}

export interface JarSnapshot {
  id: string;
  version: string | null;
  createdAt: string;
  sizeBytes: number;
  file: string;
}

async function serverPathFor(serverId?: string): Promise<string> {
  try {
    const id = serverId ?? (await getDefaultId());
    const srv = await getServer(id);
    if (srv) return srv.paths.server;
  } catch {
    // registry not ready
  }
  return config.serverPath;
}

// ---------- history ----------

export function getUpdateHistory(): UpdateHistoryEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as UpdateHistoryEntry[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function recordUpdate(entry: Omit<UpdateHistoryEntry, 'id' | 'at'>): UpdateHistoryEntry {
  const full: UpdateHistoryEntry = {
    id: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...entry,
  };
  const list = getUpdateHistory();
  list.unshift(full);
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, MAX_HISTORY), null, 2), 'utf-8');
  } catch (err) {
    logger.error('[UpdateHistory] Failed to write history:', err);
  }
  return full;
}

// ---------- JAR snapshots ----------

function readVersion(serverPath: string): string | null {
  try {
    return fs.readFileSync(path.join(serverPath, VERSION_FILE), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export async function listJarSnapshots(serverId?: string): Promise<JarSnapshot[]> {
  const serverPath = await serverPathFor(serverId);
  const dir = path.join(serverPath, SNAPSHOT_DIRNAME);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const snapshots: JarSnapshot[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as JarSnapshot;
      // Only list snapshots whose JAR is still present.
      if (meta.file && fs.existsSync(path.join(dir, meta.file))) {
        snapshots.push(meta);
      }
    } catch {
      // corrupt sidecar — skip
    }
  }
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return snapshots;
}

/**
 * Copy the current HytaleServer.jar into the snapshots dir. Best-effort:
 * returns null (with a logged reason) if there's no JAR yet. Prunes old
 * snapshots beyond MAX_SNAPSHOTS.
 */
export async function snapshotCurrentJar(serverId?: string): Promise<JarSnapshot | null> {
  const serverPath = await serverPathFor(serverId);
  const jarPath = path.join(serverPath, JAR_NAME);
  if (!fs.existsSync(jarPath)) {
    logger.info('[UpdateHistory] No HytaleServer.jar to snapshot yet — skipping.');
    return null;
  }
  const version = readVersion(serverPath);
  const dir = path.join(serverPath, SNAPSHOT_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `snap-${ts}`;
  const jarFile = `HytaleServer-${version ?? 'unknown'}-${ts}.jar`;
  fs.copyFileSync(jarPath, path.join(dir, jarFile));
  const size = fs.statSync(path.join(dir, jarFile)).size;

  const meta: JarSnapshot = {
    id,
    version,
    createdAt: new Date().toISOString(),
    sizeBytes: size,
    file: jarFile,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2), 'utf-8');
  logger.info(`[UpdateHistory] Snapshotted JAR (version=${version ?? 'unknown'}, ${Math.round(size / 1024 / 1024)} MB)`);

  // Prune oldest beyond the cap.
  const all = await listJarSnapshots(serverId);
  for (const old of all.slice(MAX_SNAPSHOTS)) {
    try {
      fs.rmSync(path.join(dir, old.file), { force: true });
      fs.rmSync(path.join(dir, `${old.id}.json`), { force: true });
    } catch { /* ignore */ }
  }
  return meta;
}

/**
 * Restore a snapshot over the live JAR. Does NOT restart the server — the
 * caller decides when (so it can announce/disconnect players first).
 */
export async function rollbackToSnapshot(snapshotId: string, serverId?: string): Promise<{ success: boolean; error?: string; restoredVersion?: string | null }> {
  const serverPath = await serverPathFor(serverId);
  const dir = path.join(serverPath, SNAPSHOT_DIRNAME);
  const snapshots = await listJarSnapshots(serverId);
  const snap = snapshots.find(s => s.id === snapshotId);
  if (!snap) return { success: false, error: 'Snapshot not found' };

  const snapJar = path.join(dir, snap.file);
  if (!fs.existsSync(snapJar)) return { success: false, error: 'Snapshot file missing' };

  try {
    // Snapshot the CURRENT jar first so a rollback is itself reversible.
    await snapshotCurrentJar(serverId).catch(() => null);

    fs.copyFileSync(snapJar, path.join(serverPath, JAR_NAME));
    if (snap.version) {
      fs.writeFileSync(path.join(serverPath, VERSION_FILE), snap.version, 'utf-8');
    }
    return { success: true, restoredVersion: snap.version };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Rollback failed' };
  }
}
