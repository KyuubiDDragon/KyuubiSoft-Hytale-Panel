// Shared helpers, types, and state for the server routes submodules.
//
// Extracted from the previously monolithic routes/server.ts to keep behavior
// identical while splitting the router into smaller, focused modules.
import { readFile, writeFile, access, constants } from 'fs/promises';
import * as dockerService from '../../services/docker.js';
import { escapeShellArg } from '../../utils/sanitize.js';

// Allowed config file extensions
export const CONFIG_EXTENSIONS = ['.json', '.properties', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini'];

// Quick settings interface
export interface QuickSettings {
  serverName: string;
  motd: string;
  password: string;
  maxPlayers: number;
  maxViewRadius: number;
  defaultGameMode: string;
}

// Panel config file path (for patchline + related toggles)
export const PANEL_CONFIG_PATH = '/opt/hytale/data/panel-config.json';

// Panel config interface
export interface PanelConfig {
  patchline: string;
  acceptEarlyPlugins: boolean;
  disableSentry: boolean;
  allowOp: boolean;
  // Optional JVM/startup tuning. When unset, start-server.sh falls back to the
  // container's env-var defaults (JAVA_MIN_RAM/JAVA_MAX_RAM/EXTRA_*_ARGS).
  javaMinRam?: string;
  javaMaxRam?: string;
  extraJavaArgs?: string;
  extraServerArgs?: string;
}

// Helper to read panel config
export async function readPanelConfig(): Promise<PanelConfig> {
  try {
    const content = await readFile(PANEL_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(content);
    // Ensure all fields have defaults
    return {
      patchline: cfg.patchline || process.env.HYTALE_PATCHLINE || 'release',
      acceptEarlyPlugins: cfg.acceptEarlyPlugins ?? false,
      disableSentry: cfg.disableSentry ?? false,
      allowOp: cfg.allowOp ?? false,
      javaMinRam: typeof cfg.javaMinRam === 'string' ? cfg.javaMinRam : undefined,
      javaMaxRam: typeof cfg.javaMaxRam === 'string' ? cfg.javaMaxRam : undefined,
      extraJavaArgs: typeof cfg.extraJavaArgs === 'string' ? cfg.extraJavaArgs : undefined,
      extraServerArgs: typeof cfg.extraServerArgs === 'string' ? cfg.extraServerArgs : undefined,
    };
  } catch {
    // Return defaults if file doesn't exist
    return {
      patchline: process.env.HYTALE_PATCHLINE || 'release',
      acceptEarlyPlugins: false,
      disableSentry: false,
      allowOp: false,
    };
  }
}

// Helper to write panel config
export async function writePanelConfig(cfg: PanelConfig): Promise<void> {
  await writeFile(PANEL_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// Helper to check if downloader credentials exist
export async function checkDownloaderCredentials(): Promise<{ exists: boolean; error?: string }> {
  // Check multiple possible locations for downloader credentials
  const credentialPaths = [
    '/opt/hytale/downloader/.hytale-downloader-credentials.json',
    '/opt/hytale/auth/credentials.json',
    '/opt/hytale/auth/oauth_credentials.json',
  ];

  for (const credPath of credentialPaths) {
    try {
      await access(credPath, constants.R_OK);
      console.log(`[Server] Found downloader credentials at: ${credPath}`);
      return { exists: true };
    } catch {
      // Continue checking
    }
  }

  console.log('[Server] No downloader credentials found');
  return { exists: false, error: 'Downloader credentials not found. Re-authentication required.' };
}

// SECURITY: Defense-in-depth validation - even though callers use hardcoded values
export const VALID_PATCHLINES = ['release', 'pre-release'] as const;

export interface VersionCheckResult {
  version: string;
  authRequired?: boolean;
  error?: string;
}

export async function getLatestVersion(patchline: string): Promise<VersionCheckResult> {
  // SECURITY: Validate patchline to prevent command injection
  if (!VALID_PATCHLINES.includes(patchline as typeof VALID_PATCHLINES[number])) {
    console.error(`Invalid patchline attempted: ${patchline}`);
    return { version: 'unknown', error: 'Invalid patchline' };
  }

  // Run downloader and capture both stdout and stderr to detect auth issues.
  // IMPORTANT: run as the `hytale` user (uid 9999), not root. The container's
  // default exec user is root, but the actual server download in entrypoint.sh
  // runs via `gosu hytale`. If we probe the version as root we (a) read a
  // different credential store than the real download and can report a version
  // the hytale-user download can't actually fetch, and (b) leave root-owned
  // cache/credential files in /opt/hytale/downloader that then block the
  // hytale-user download. Running as hytale keeps probe and download in sync.
  const checkResult = await dockerService.execInContainer(
    `cd /opt/hytale/downloader && gosu hytale ./hytale-downloader-linux-amd64 -patchline ${escapeShellArg(patchline)} -print-version 2>&1`
  );

  if (!checkResult.success) {
    console.error('[Server] Downloader exec failed:', checkResult.error);
    return { version: 'unknown', error: checkResult.error };
  }

  const output = checkResult.output || '';

  // Check for authentication errors in output
  const authErrorPatterns = [
    /unauthorized/i,
    /authentication.*required/i,
    /invalid.*token/i,
    /token.*expired/i,
    /login.*required/i,
    /401/,
    /403/,
    /no.*credentials/i,
    /credentials.*not.*found/i,
    /please.*authenticate/i,
  ];

  for (const pattern of authErrorPatterns) {
    if (pattern.test(output)) {
      console.log('[Server] Downloader auth error detected:', output.substring(0, 200));
      return { version: 'unknown', authRequired: true, error: 'Authentication required' };
    }
  }

  // Extract version number from output. The downloader prints labeled prose
  // that can contain BOTH the real version (newer Hytale builds use a semver
  // like "0.5.0") and a YYYY.MM.DD build-date stamp. The old first-match regex
  // grabbed the date (e.g. "2026.05.13") instead of the version. Prefer a real,
  // non-date version; only fall back to a date-style stamp when that's all the
  // output contains (the older date-based naming scheme).
  // A build-date stamp is YYYY.MM.DD, optionally followed by a build/commit
  // suffix like "-99ade04" (Hytale ships "2026.05.13-99ade04"). The suffix must
  // be matched too, otherwise the stamp is mistaken for a real semver and wins
  // over the actual version (e.g. "0.5.3"), causing a phantom "update available".
  const isDateStamp = (v: string): boolean =>
    /^(19|20)\d{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(?:[-.][0-9A-Za-z]+)?$/.test(v);
  const versionTokens = output.match(/[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z]+)?/g) || [];
  // A "version: X" label is the strongest signal — prefer it when present and
  // not itself a date stamp.
  const labeled = output.match(/version[^0-9]*([0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z]+)?)/i);
  const labeledVersion = labeled && !isDateStamp(labeled[1]) ? labeled[1] : undefined;
  const chosenVersion = labeledVersion
    ?? versionTokens.find((v) => !isDateStamp(v))
    ?? versionTokens[0];
  if (chosenVersion) {
    return { version: chosenVersion };
  }

  // If no version found but also no auth error, credentials might be missing
  // Check if credentials exist
  const credCheck = await checkDownloaderCredentials();
  if (!credCheck.exists) {
    return { version: 'unknown', authRequired: true, error: credCheck.error };
  }

  // No version found, but credentials exist - might be a network issue
  console.log('[Server] No version found in output:', output.substring(0, 200));
  return { version: 'unknown', error: 'Could not fetch version. Check network connection.' };
}

// In-memory state for downloader OAuth flow - shared across auth endpoints
export const downloaderOAuthState: {
  active: boolean;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: Date;
} = { active: false };

// Helpers for resetting/updating shared OAuth state from auth submodule
export function setDownloaderOAuthState(next: {
  active: boolean;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: Date;
}): void {
  downloaderOAuthState.active = next.active;
  downloaderOAuthState.verificationUrl = next.verificationUrl;
  downloaderOAuthState.userCode = next.userCode;
  downloaderOAuthState.expiresAt = next.expiresAt;
}

// UpdateConfig interface
export interface UpdateConfig {
  enabled: boolean;
  checkIntervalSeconds: number;
  notifyPlayersOnAvailable: boolean;
  patchline: 'release' | 'pre-release';
  runBackupBeforeUpdate: boolean;
  backupConfigBeforeUpdate: boolean;
  autoApplyMode: 'DISABLED' | 'WHEN_EMPTY' | 'SCHEDULED';
  autoApplyDelayMinutes: number;
}

// Default UpdateConfig values
export function getDefaultUpdateConfig(): UpdateConfig {
  return {
    enabled: true,
    checkIntervalSeconds: 3600,
    notifyPlayersOnAvailable: true,
    patchline: 'release',
    runBackupBeforeUpdate: true,
    backupConfigBeforeUpdate: true,
    autoApplyMode: 'DISABLED',
    autoApplyDelayMinutes: 5,
  };
}

// Native update status interface
export interface NativeUpdateStatus {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  state: 'IDLE' | 'CHECKING' | 'DOWNLOADING' | 'READY' | 'APPLYING' | 'ERROR';
  progress?: number;
  message?: string;
  error?: string;
}

// Helper to parse /update status output
export function parseUpdateStatusOutput(output: string): NativeUpdateStatus {
  if (!output || typeof output !== 'string') {
    return {
      available: false,
      currentVersion: 'unknown',
      latestVersion: 'unknown',
      state: 'IDLE',
      error: 'No output from server'
    };
  }

  const lower = output.toLowerCase();

  // Detect state
  let state: NativeUpdateStatus['state'] = 'IDLE';
  if (lower.includes('error') || lower.includes('failed')) state = 'ERROR';
  else if (lower.includes('applying') || lower.includes('installing')) state = 'APPLYING';
  else if (lower.includes('ready') || lower.includes('staged') || lower.includes('downloaded')) state = 'READY';
  else if (lower.includes('downloading') || lower.includes('download')) state = 'DOWNLOADING';
  else if (lower.includes('checking')) state = 'CHECKING';

  // Extract versions using multiple patterns
  const versionPatterns = [
    /(?:current|installed).*?([0-9]+\.[0-9]+\.[0-9]+)/i,
    /version[:\s]+([0-9]+\.[0-9]+\.[0-9]+)/i,
  ];

  let currentVersion = 'unknown';
  for (const pattern of versionPatterns) {
    const match = output.match(pattern);
    if (match) {
      currentVersion = match[1];
      break;
    }
  }

  // Extract latest version
  const latestPatterns = [
    /(?:latest|available|new).*?([0-9]+\.[0-9]+\.[0-9]+)/i,
  ];

  let latestVersion = 'unknown';
  for (const pattern of latestPatterns) {
    const match = output.match(pattern);
    if (match) {
      latestVersion = match[1];
      break;
    }
  }

  // Extract progress
  const progressMatch = output.match(/(\d+)\s*%/);
  const progress = progressMatch ? parseInt(progressMatch[1]) : undefined;

  return {
    available: state === 'READY' || (latestVersion !== 'unknown' && currentVersion !== latestVersion),
    currentVersion,
    latestVersion,
    state,
    progress,
    message: output.substring(0, 200)
  };
}

// Helper function to parse Prometheus text format
export function parsePrometheusMetrics(raw: string): Record<string, unknown> {
  const lines = raw.split('\n').filter(line => line && !line.startsWith('#'));
  const metrics: Record<string, number> = {};
  const labeledMetrics: Record<string, Record<string, number>> = {};

  for (const line of lines) {
    // Match metrics with labels: metric_name{label="value"} 123.45
    const labelMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\{([^}]+)\}\s+([\d.eE+-]+)/);
    if (labelMatch) {
      const metricName = labelMatch[1];
      const labelStr = labelMatch[2];
      const value = parseFloat(labelMatch[3]);

      // Parse label (e.g., pool="G1 Eden Space" or gc="G1 Young Generation")
      const labelValueMatch = labelStr.match(/(?:pool|gc|world)="([^"]+)"/);
      if (labelValueMatch) {
        if (!labeledMetrics[metricName]) {
          labeledMetrics[metricName] = {};
        }
        labeledMetrics[metricName][labelValueMatch[1]] = value;
      }
      continue;
    }

    // Match simple metrics: metric_name 123.45
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+([\d.eE+-]+)/);
    if (match) {
      metrics[match[1]] = parseFloat(match[2]);
    }
  }

  // Parse memory pools
  const memoryPools: Array<{ name: string; used: number; max: number; percent: number }> = [];
  const poolUsed = labeledMetrics['jvm_memory_pool_used_bytes'] || {};
  const poolMax = labeledMetrics['jvm_memory_pool_max_bytes'] || {};
  for (const poolName of Object.keys(poolUsed)) {
    const used = poolUsed[poolName] || 0;
    const max = poolMax[poolName] || 0;
    memoryPools.push({
      name: poolName,
      used,
      max,
      percent: max > 0 ? (used / max) * 100 : 0,
    });
  }

  // Parse GC stats
  const gcStats: Array<{ name: string; count: number; timeSeconds: number }> = [];
  const gcCount = labeledMetrics['jvm_gc_collection_count_total'] || {};
  const gcTime = labeledMetrics['jvm_gc_collection_time_seconds_total'] || {};
  for (const gcName of Object.keys(gcCount)) {
    gcStats.push({
      name: gcName,
      count: gcCount[gcName] || 0,
      timeSeconds: gcTime[gcName] || 0,
    });
  }

  // Parse players per world
  const playersPerWorld: Record<string, number> = labeledMetrics['hytale_players_world'] || {};

  return {
    tps: {
      current: metrics['hytale_tps_current'] ?? 20,
      average: metrics['hytale_tps_average'] ?? 20,
      min: metrics['hytale_tps_min'] ?? 20,
      max: metrics['hytale_tps_max'] ?? 20,
      target: metrics['hytale_tps_target'] ?? 20,
      msptCurrent: metrics['hytale_mspt_current'] ?? 50,
      msptAverage: metrics['hytale_mspt_average'] ?? 50,
    },
    players: {
      online: metrics['hytale_players_online'] ?? 0,
      max: metrics['hytale_players_max'] ?? 100,
      joins: metrics['hytale_player_joins_total'] ?? 0,
      leaves: metrics['hytale_player_leaves_total'] ?? 0,
      perWorld: playersPerWorld,
    },
    memory: {
      heapUsed: metrics['jvm_memory_heap_used_bytes'] ?? 0,
      heapMax: metrics['jvm_memory_heap_max_bytes'] ?? 0,
      heapCommitted: metrics['jvm_memory_heap_committed_bytes'] ?? 0,
      heapPercent: metrics['jvm_memory_heap_max_bytes']
        ? (metrics['jvm_memory_heap_used_bytes'] / metrics['jvm_memory_heap_max_bytes']) * 100
        : 0,
      nonHeapUsed: metrics['jvm_memory_nonheap_used_bytes'] ?? 0,
      nonHeapCommitted: metrics['jvm_memory_nonheap_committed_bytes'] ?? 0,
      pools: memoryPools,
    },
    threads: {
      current: metrics['jvm_threads_current'] ?? 0,
      daemon: metrics['jvm_threads_daemon'] ?? 0,
      peak: metrics['jvm_threads_peak'] ?? 0,
    },
    gc: gcStats,
    cpu: {
      process: (metrics['process_cpu_usage'] ?? 0) * 100,
      system: (metrics['system_cpu_usage'] ?? 0) * 100,
    },
    uptime: metrics['hytale_uptime_seconds'] ?? 0,
    worlds: metrics['hytale_worlds_loaded'] ?? 0,
  };
}

// Helper function to parse TPS metrics
export function parseTpsMetrics(raw: string): Record<string, number> {
  const lines = raw.split('\n').filter(line => line && !line.startsWith('#'));
  const metrics: Record<string, number> = {};

  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{[^}]*\})?\s+([\d.eE+-]+)/);
    if (match) {
      metrics[match[1]] = parseFloat(match[2]);
    }
  }

  return {
    current: metrics['hytale_tps_current'] ?? 20,
    average: metrics['hytale_tps_average'] ?? 20,
    min: metrics['hytale_tps_min'] ?? 20,
    max: metrics['hytale_tps_max'] ?? 20,
    target: metrics['hytale_tps_target'] ?? 20,
    msptCurrent: metrics['hytale_mspt_current'] ?? 50,
    msptAverage: metrics['hytale_mspt_average'] ?? 50,
  };
}
