// Shared helpers, types, and state for the server routes submodules.
//
// Extracted from the previously monolithic routes/server.ts to keep behavior
// identical while splitting the router into smaller, focused modules.
import { readFile, access, constants } from 'fs/promises';
import path from 'path';
import { config } from '../../config.js';
import * as dockerService from '../../services/docker.js';
import { escapeShellArg } from '../../utils/sanitize.js';
import { withFileLock, writeJsonAtomic } from '../../utils/jsonStore.js';

// Allowed config file extensions
export const CONFIG_EXTENSIONS = [
  '.json',
  '.properties',
  '.yml',
  '.yaml',
  '.toml',
  '.cfg',
  '.conf',
  '.ini',
];

// Quick settings interface
export interface QuickSettings {
  serverName: string;
  motd: string;
  password: string;
  maxPlayers: number;
  maxViewRadius: number;
  defaultGameMode: string;
}

// Panel config file (patchline, start flags, JVM tuning). Read by the game
// container's entrypoint.sh / start-server.sh at every start.
export const PANEL_CONFIG_PATH = path.join(config.dataPath, 'panel-config.json');

// Defaults for the native backup retention flags (same as the server's own).
export const DEFAULT_NATIVE_BACKUP_MAX_COUNT = 5;
export const DEFAULT_NATIVE_BACKUP_ARCHIVE_MAX_COUNT = 5;

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
  // One `--boot-command` per entry (Hytale splits every value at commas).
  bootCommands?: string[];
  // -XX:AOTCache=HytaleServer.aot; off unless chosen (the shipped cache rarely
  // matches the container's JVM build).
  aotCache?: boolean;
  // Downloader version check on every container start; overrides AUTO_UPDATE.
  autoUpdate?: boolean;
  // --backup-max-count / --backup-archive-max-count for native backups.
  nativeBackupMaxCount?: number;
  nativeBackupArchiveMaxCount?: number;
}

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optionalBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const optionalInt = (v: unknown): number | undefined =>
  Number.isInteger(v) ? (v as number) : undefined;

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
      javaMinRam: optionalString(cfg.javaMinRam),
      javaMaxRam: optionalString(cfg.javaMaxRam),
      extraJavaArgs: optionalString(cfg.extraJavaArgs),
      extraServerArgs: optionalString(cfg.extraServerArgs),
      bootCommands: Array.isArray(cfg.bootCommands)
        ? cfg.bootCommands.filter((c: unknown): c is string => typeof c === 'string')
        : undefined,
      aotCache: optionalBool(cfg.aotCache),
      autoUpdate: optionalBool(cfg.autoUpdate),
      nativeBackupMaxCount: optionalInt(cfg.nativeBackupMaxCount),
      nativeBackupArchiveMaxCount: optionalInt(cfg.nativeBackupArchiveMaxCount),
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

// Helper to write panel config. Merges into the file so keys this version of
// the panel does not model are kept; `undefined` values leave a key as it is.
// Atomic (tmp + rename) under a per-file lock: the start scripts read the file
// at any moment and must never see it half-written.
export async function writePanelConfig(cfg: PanelConfig): Promise<void> {
  await withFileLock(PANEL_CONFIG_PATH, async () => {
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(PANEL_CONFIG_PATH, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
      // missing or unreadable: start from the given values
    }
    const defined = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined));
    await writeJsonAtomic(PANEL_CONFIG_PATH, { ...existing, ...defined }, { mode: 0o644 });
  });
}

export const DOWNLOADER_CREDENTIALS_PATH =
  '/opt/hytale/downloader/.hytale-downloader-credentials.json';

// Helper to check if downloader credentials exist. The token lives in the
// downloader volume of the game container. The default compose mounts that
// volume read-only into the manager; setups without the mount are answered
// by the game container itself. (The game entrypoint no longer copies the
// token into the auth volume.)
export async function checkDownloaderCredentials(): Promise<{ exists: boolean; error?: string }> {
  try {
    await access(DOWNLOADER_CREDENTIALS_PATH, constants.R_OK);
    return { exists: true };
  } catch {
    // Not visible from the manager - ask the game container.
  }

  const probe = await dockerService.execInContainer(
    `test -f ${escapeShellArg(DOWNLOADER_CREDENTIALS_PATH)} && echo present || echo missing`,
  );
  if (probe.success && probe.output?.trim().endsWith('present')) {
    return { exists: true };
  }

  console.log('[Server] No downloader credentials found');
  return { exists: false, error: 'Downloader credentials not found. Re-authentication required.' };
}

// SECURITY: Defense-in-depth validation - even though callers use hardcoded values
export const VALID_PATCHLINES = ['release', 'pre-release'] as const;

const VERSION_PROBE_TIMEOUT_SECONDS = 30;

export interface VersionCheckResult {
  version: string;
  authRequired?: boolean;
  error?: string;
}

// The game container's entrypoint and the panel share this lock around every
// downloader call: any call may rewrite the credentials file when it refreshes
// the token. Panel probes never wait for it (a container start may hold it for
// a whole download) and report "busy" instead.
export const DOWNLOADER_BUSY_MARKER = '__DOWNLOADER_BUSY__';
const DOWNLOADER_LOCK_EXIT = 75;

/**
 * Shell command that runs the downloader as the hytale user with a time limit
 * and the shared lock. The lock file is opened as hytale too: the folder
 * belongs to the server, and root would follow a link planted under its name.
 * timeout runs as hytale so the time limit works: the container has no
 * CAP_KILL, so root could not signal the downloader. `args` must already be
 * shell-safe.
 */
export function downloaderShellCommand(args: string, timeoutSeconds: number): string {
  return (
    `cd /opt/hytale/downloader && gosu hytale timeout ${Math.floor(timeoutSeconds)} ` +
    `flock -n -E ${DOWNLOADER_LOCK_EXIT} .downloader.lock ` +
    `./hytale-downloader-linux-amd64 ${args} 2>&1; ` +
    `[ $? -eq ${DOWNLOADER_LOCK_EXIT} ] && echo ${DOWNLOADER_BUSY_MARKER}; true`
  );
}

export async function getLatestVersion(patchline: string): Promise<VersionCheckResult> {
  // SECURITY: Validate patchline to prevent command injection
  if (!VALID_PATCHLINES.includes(patchline as (typeof VALID_PATCHLINES)[number])) {
    console.error(`Invalid patchline attempted: ${patchline}`);
    return { version: 'unknown', error: 'Invalid patchline' };
  }

  // Without saved credentials -print-version starts a device login and waits
  // for it until the time limit; there is nothing to probe.
  const credentials = await checkDownloaderCredentials();
  if (!credentials.exists) {
    return { version: 'unknown', authRequired: true, error: credentials.error };
  }

  // Run downloader and capture both stdout and stderr to detect auth issues.
  // IMPORTANT: run as the `hytale` user (uid 9999), not root. The container's
  // default exec user is root, but the actual server download in entrypoint.sh
  // runs via `gosu hytale`. If we probe the version as root we (a) read a
  // different credential store than the real download and can report a version
  // the hytale-user download can't actually fetch, and (b) leave root-owned
  // cache/credential files in /opt/hytale/downloader that then block the
  // hytale-user download. Running as hytale keeps probe and download in sync.
  // -skip-update-check keeps the downloader's notice about its own new
  // version (which carries a date-like version) out of the output.
  const checkResult = await dockerService.execInContainer(
    downloaderShellCommand(
      `-patchline ${escapeShellArg(patchline)} -print-version -skip-update-check`,
      VERSION_PROBE_TIMEOUT_SECONDS,
    ),
    undefined,
    { timeoutMs: (VERSION_PROBE_TIMEOUT_SECONDS + 5) * 1000 },
  );

  if (!checkResult.success) {
    console.error('[Server] Downloader exec failed:', checkResult.error);
    return { version: 'unknown', error: checkResult.error };
  }

  const output = checkResult.output || '';
  if (output.includes(DOWNLOADER_BUSY_MARKER)) {
    return {
      version: 'unknown',
      error: 'The downloader is busy (download in progress). Try again later.',
    };
  }

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
  const chosenVersion =
    labeledVersion ?? versionTokens.find((v) => !isDateStamp(v)) ?? versionTokens[0];
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

// Helper function to parse Prometheus text format
export function parsePrometheusMetrics(raw: string): Record<string, unknown> {
  const lines = raw.split('\n').filter((line) => line && !line.startsWith('#'));
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
  const lines = raw.split('\n').filter((line) => line && !line.startsWith('#'));
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
