/**
 * Hytale Server API Adapter
 *
 * Stable façade for talking to a Hytale server. Hytale is still pre-1.0
 * (Early Access since 2026-01-13, frequent breaking updates), so the rest
 * of the panel should not depend on a specific transport (KyuubiSoft API
 * plugin today, native HTTP endpoints once Hytale ships them).
 *
 * Versioning strategy:
 *   - Read the server version from /opt/hytale/server/.hytale-version
 *     (written by scripts/entrypoint.sh during downloader runs).
 *   - HytaleAPIFactory.create() picks the adapter that matches the version
 *     range; today there is only one, but the dispatch point is in place.
 *   - getCapabilities() exposes feature flags so callers can branch on
 *     supportsNativeUpdates / supportsServerBrowser without re-detecting.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import {
  getPluginStatus,
  fetchFromPlugin,
  type PluginStatus,
} from './kyuubiApi.js';

export interface HytaleCapabilities {
  /** Hytale 0.24.01.2026+ has a built-in update mechanism (exit code 8). */
  supportsNativeUpdates: boolean;
  /** Hytale Update 5 (2026-05-28) adds a public server browser. */
  supportsServerBrowser: boolean;
  /** Config is JSON since Early Access. */
  configFormat: 'json' | 'properties';
  /** Java runtime required to host this build. */
  minJavaVersion: number;
}

export interface HytaleVersionInfo {
  version: string | null;
  source: 'version-file' | 'unknown';
}

export interface HytalePlayer {
  name: string;
  uuid?: string;
  world?: string;
}

export interface HytaleServerAPI {
  /** Returns the parsed server version, or null if unknown. */
  getVersion(): Promise<HytaleVersionInfo>;
  /** Capability matrix for the detected version. */
  getCapabilities(): HytaleCapabilities;
  /** Lightweight reachability check. */
  isReachable(): Promise<boolean>;
  /** Status of the transport (plugin / native endpoint / log fallback). */
  getTransportStatus(): Promise<{ transport: string; details: PluginStatus | null }>;
  /** Online players from the most authoritative source available. */
  getOnlinePlayers(): Promise<HytalePlayer[]>;
}

const VERSION_FILE = path.join(config.serverPath, '.hytale-version');

async function readVersionFile(): Promise<HytaleVersionInfo> {
  try {
    const raw = (await readFile(VERSION_FILE, 'utf-8')).trim();
    return raw ? { version: raw, source: 'version-file' } : { version: null, source: 'unknown' };
  } catch {
    return { version: null, source: 'unknown' };
  }
}

function parseSemver(v: string | null): { major: number; minor: number; patch: number } | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

function capabilitiesFor(v: string | null): HytaleCapabilities {
  const parsed = parseSemver(v);
  // Defaults assume the current Early Access build line (0.x.y, post-2026-01).
  const caps: HytaleCapabilities = {
    supportsNativeUpdates: true,
    supportsServerBrowser: false,
    configFormat: 'json',
    minJavaVersion: 25,
  };
  if (parsed && parsed.major === 0) {
    // Native update system landed with the 24.01.2026 build (0.x where x >= 24).
    caps.supportsNativeUpdates = parsed.minor >= 24;
    // Server browser shipped with Update 5 (2026-05-28).
    caps.supportsServerBrowser = parsed.minor >= 28 || (parsed.minor === 25 && parsed.patch >= 28);
  }
  return caps;
}

/**
 * Adapter that delegates to the KyuubiSoft API plugin. This is the only
 * transport available today — once Hytale ships native HTTP/RPC endpoints
 * we add a second adapter and let the factory pick.
 */
class KyuubiSoftPluginAdapter implements HytaleServerAPI {
  private cachedVersion: HytaleVersionInfo | null = null;

  async getVersion(): Promise<HytaleVersionInfo> {
    if (!this.cachedVersion) {
      this.cachedVersion = await readVersionFile();
    }
    return this.cachedVersion;
  }

  getCapabilities(): HytaleCapabilities {
    // Capabilities are derived from the cached version. If we haven't read
    // yet, fall back to "current build line" defaults — callers can call
    // getVersion() first if they need accuracy.
    return capabilitiesFor(this.cachedVersion?.version ?? null);
  }

  async isReachable(): Promise<boolean> {
    const status = await getPluginStatus();
    return status.running;
  }

  async getTransportStatus(): Promise<{ transport: string; details: PluginStatus | null }> {
    const status = await getPluginStatus();
    return { transport: 'kyuubisoft-plugin', details: status };
  }

  async getOnlinePlayers(): Promise<HytalePlayer[]> {
    const resp = await fetchFromPlugin<{ players?: HytalePlayer[] }>('/api/players/online');
    if (!resp.success || !resp.data?.players) return [];
    return resp.data.players;
  }
}

let singleton: HytaleServerAPI | null = null;

export class HytaleAPIFactory {
  /**
   * Return the adapter for the running server. Cached for the process
   * lifetime; call resetCachedAdapter() after a server update.
   */
  static get(): HytaleServerAPI {
    if (!singleton) {
      // Single adapter today. Once a second transport exists, branch on
      // version / available capabilities here before returning.
      singleton = new KyuubiSoftPluginAdapter();
    }
    return singleton;
  }

  static reset(): void {
    singleton = null;
  }
}

export function getHytaleApi(): HytaleServerAPI {
  return HytaleAPIFactory.get();
}
