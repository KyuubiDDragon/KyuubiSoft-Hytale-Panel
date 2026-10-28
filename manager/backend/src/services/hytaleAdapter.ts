/**
 * Hytale Server API Adapter
 *
 * Stable façade for talking to a Hytale server. Hytale is still pre-1.0
 * (Early Access since 2026-01-13, frequent breaking updates), so the rest
 * of the panel should not depend on a specific transport (KyuubiSoft API
 * plugin today, native HTTP endpoints once Hytale ships them).
 *
 * Versioning strategy:
 *   - Read the server version from the manifest of HytaleServer.jar, falling
 *     back to /opt/hytale/server/.hytale-version (stamped by start-server.sh
 *     from `java -jar HytaleServer.jar --version` on every start).
 *   - HytaleAPIFactory.get(serverId) picks the adapter that matches the
 *     version range; today there is only one, but the dispatch point is in
 *     place. Every server has its own adapter.
 *   - getCapabilities() exposes feature flags so callers can branch on
 *     supportsNativeUpdates / supportsServerBrowser without re-detecting.
 */

import { getPluginStatus, fetchFromPlugin, type PluginStatus } from './kyuubiApi.js';
import { getServerContext } from './serverContext.js';
import { readInstalledVersion } from './serverInstall.js';

export interface HytaleCapabilities {
  /** Built-in update mechanism (`/update`, exit code 8), since the 2026-01-24 build. */
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
  source: 'jar' | 'version-file' | 'unknown';
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

async function readServerVersion(serverId: string): Promise<HytaleVersionInfo> {
  const { paths } = await getServerContext(serverId);
  const installed = await readInstalledVersion(paths.server);
  return { version: installed.version, source: installed.source };
}

function parseSemver(v: string | null): { major: number; minor: number; patch: number } | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

// Hytale used build dates as versions (2026.01.24-<hash>) until Update 5
// switched to semantic versions (0.5.0); every 0.x release has both features.
const NATIVE_UPDATES_SINCE = '2026.01.24';
const SERVER_BROWSER_SINCE = '2026.05.28';
const SERVER_BROWSER_SINCE_MINOR = 5;

export function capabilitiesFor(v: string | null): HytaleCapabilities {
  const parsed = parseSemver(v);
  // Defaults assume the current Early Access build line (0.x.y).
  const caps: HytaleCapabilities = {
    supportsNativeUpdates: true,
    supportsServerBrowser: true,
    configFormat: 'json',
    minJavaVersion: 25,
  };
  if (!parsed) return caps;
  if (parsed.major === 0) {
    caps.supportsServerBrowser = parsed.minor >= SERVER_BROWSER_SINCE_MINOR;
  } else if (parsed.major >= 2000) {
    const date = `${parsed.major}.${String(parsed.minor).padStart(2, '0')}.${String(parsed.patch).padStart(2, '0')}`;
    caps.supportsNativeUpdates = date >= NATIVE_UPDATES_SINCE;
    caps.supportsServerBrowser = date >= SERVER_BROWSER_SINCE;
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

  constructor(private readonly serverId: string) {}

  async getVersion(): Promise<HytaleVersionInfo> {
    // Re-read every time (a few KB of the JAR): updates, rollbacks and
    // manual copies change the version while the panel keeps running.
    this.cachedVersion = await readServerVersion(this.serverId);
    return this.cachedVersion;
  }

  getCapabilities(): HytaleCapabilities {
    // Capabilities are derived from the last read version. If we haven't read
    // yet, fall back to "current build line" defaults — callers can call
    // getVersion() first if they need accuracy.
    return capabilitiesFor(this.cachedVersion?.version ?? null);
  }

  async isReachable(): Promise<boolean> {
    const status = await getPluginStatus(this.serverId);
    return status.running;
  }

  async getTransportStatus(): Promise<{ transport: string; details: PluginStatus | null }> {
    const status = await getPluginStatus(this.serverId);
    return { transport: 'kyuubisoft-plugin', details: status };
  }

  async getOnlinePlayers(): Promise<HytalePlayer[]> {
    const resp = await fetchFromPlugin<{ players?: HytalePlayer[] }>(
      '/api/players/online',
      this.serverId,
    );
    if (!resp.success || !resp.data?.players) return [];
    return resp.data.players;
  }
}

const adapters = new Map<string, HytaleServerAPI>();

export class HytaleAPIFactory {
  /**
   * Return the adapter for a server (registry id). Cached for the process
   * lifetime; call reset(serverId) after a server update.
   */
  static get(serverId: string): HytaleServerAPI {
    let adapter = adapters.get(serverId);
    if (!adapter) {
      // Single adapter today. Once a second transport exists, branch on
      // version / available capabilities here before returning.
      adapter = new KyuubiSoftPluginAdapter(serverId);
      adapters.set(serverId, adapter);
    }
    return adapter;
  }

  /** Forget the adapter of one server, or of every server. */
  static reset(serverId?: string): void {
    if (serverId === undefined) adapters.clear();
    else adapters.delete(serverId);
  }
}

export function getHytaleApi(serverId: string): HytaleServerAPI {
  return HytaleAPIFactory.get(serverId);
}
