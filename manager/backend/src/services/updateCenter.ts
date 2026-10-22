/**
 * Update Center state for one server, built from what the panel can verify:
 * the files of the installation (installed and staged version, previous
 * version in updater/backup, free disk space), the container state and the
 * downloader. Console replies are not used: the panel cannot read the output
 * of a console command yet, so "download running" is not observable — a
 * finished download shows up as a staged update.
 */
import path from 'path';
import * as dockerService from './docker.js';
import {
  resolveInstallPaths,
  readInstalledVersion,
  getStagedUpdate,
  getNativeBackup,
  checkApplyDiskSpace,
  checkUpdaterMount,
  type StagedUpdate,
  type NativeBackup,
  type DiskCheck,
  type UpdaterMountState,
} from './serverInstall.js';
import { readUpdateSettings } from './updateSettings.js';
import { resolveServerId } from './servers.js';
import { isLifecycleBusy } from './serverLifecycle.js';
import { readRegularFile } from '../utils/noFollowFs.js';
import {
  readPanelConfig,
  getLatestVersion,
  downloaderShellCommand,
  DOWNLOADER_BUSY_MARKER,
} from '../routes/server/shared.js';

export type ActionBlock =
  | 'server_stopped'
  | 'server_running'
  | 'no_updater'
  | 'invalid_layout'
  | 'already_staged'
  | 'nothing_staged'
  | 'disk_space'
  | 'no_backup'
  | 'staged_invalid'
  | 'patchline_mismatch'
  | 'lifecycle_busy';

export interface ActionState {
  allowed: boolean;
  reason?: ActionBlock;
}

export interface LatestCheck {
  patchline: string;
  latestVersion: string;
  checkedAt: string;
  authRequired?: boolean;
  error?: string;
}

export interface UpdateCenterStatus {
  // Shape the UI already knew
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  state: 'IDLE' | 'READY';
  // Filesystem view
  currentPatchline: string | null;
  staged: StagedUpdate | null;
  backup: NativeBackup | null;
  serverRunning: boolean;
  /** The panel sees the updater folder the game container uses (updaterMount === 'mounted'). */
  updaterMounted: boolean;
  updaterMount: UpdaterMountState;
  /** A stop, start, rollback or restore of this server runs or waits. */
  lifecycleBusy: boolean;
  /** null = unknown (server not running) */
  layoutValid: boolean | null;
  disk: DiskCheck | null;
  lastCheck: LatestCheck | null;
  actions: {
    download: ActionState;
    apply: ActionState;
    cancel: ActionState;
    rollbackNative: ActionState;
    /** Rollback to a JAR snapshot. */
    rollbackSnapshot: ActionState;
  };
}

const LAYOUT_CACHE_MS = 60_000;
const layoutCache = new Map<string, { at: number; valid: boolean | null }>();
const lastChecks = new Map<string, LatestCheck>();

const SERVER_CONFIG_MAX_BYTES = 16 * 1024 * 1024;

async function serverConfigJson(serverPath: string): Promise<unknown> {
  try {
    // The server can write here: a link is not followed.
    const raw = await readRegularFile(path.join(serverPath, 'config.json'), [serverPath], {
      maxBytes: SERVER_CONFIG_MAX_BYTES,
    });
    return JSON.parse(raw.toString('utf-8'));
  } catch {
    return {};
  }
}

/**
 * Does the game container have the layout Hytale 0.7 needs for updates
 * (Assets.zip and a start.sh next to the server directory)? The entrypoint
 * creates both; an image built before that change does not.
 */
export async function checkUpdateLayout(serverId?: string): Promise<boolean | null> {
  const key = await resolveServerId(serverId);
  const cached = layoutCache.get(key);
  if (cached && Date.now() - cached.at < LAYOUT_CACHE_MS) return cached.valid;
  const result = await dockerService.execInContainer(
    'if [ -e /opt/hytale/Assets.zip ] && { [ -e /opt/hytale/start.sh ] || [ -e /opt/hytale/start.bat ]; }; ' +
      'then echo LAYOUT_OK; else echo LAYOUT_INVALID; fi',
    serverId,
  );
  let valid: boolean | null = null;
  if (result.success && result.output?.includes('LAYOUT_OK')) valid = true;
  else if (result.success && result.output?.includes('LAYOUT_INVALID')) valid = false;
  layoutCache.set(key, { at: Date.now(), valid });
  return valid;
}

function block(reason: ActionBlock): ActionState {
  return { allowed: false, reason };
}

/**
 * A staged build of another patchline than the installed one: applying it
 * switches the installation over, so only after a confirmation.
 */
export function stagedPatchlineDiffers(
  staged: StagedUpdate | null,
  installedPatchline: string | null,
): boolean {
  return !!staged?.patchline && !!installedPatchline && staged.patchline !== installedPatchline;
}

export async function getUpdateCenterStatus(serverId?: string): Promise<UpdateCenterStatus> {
  const paths = await resolveInstallPaths(serverId);
  const updaterMount = await checkUpdaterMount(paths);
  // A folder the game container does not use tells nothing about its updates.
  const updaterPath = updaterMount === 'mounted' ? paths.updaterPath : null;
  const [installed, staged, backup, container, panelConfig, serverConfig] = await Promise.all([
    readInstalledVersion(paths.serverPath),
    getStagedUpdate(updaterPath),
    getNativeBackup(updaterPath),
    dockerService.getContainerState(serverId).catch(() => null),
    readPanelConfig(),
    serverConfigJson(paths.serverPath),
  ]);
  const running = container?.running === true;
  const layoutValid = running ? await checkUpdateLayout(serverId) : null;
  const settings = readUpdateSettings(serverConfig, panelConfig.patchline);
  const disk = staged
    ? await checkApplyDiskSpace(paths, staged, backup, {
        worldBackup: settings.runBackupBeforeUpdate,
      })
    : null;
  const id = await resolveServerId(serverId);
  const lastCheck = lastChecks.get(id) ?? null;
  // A stop, start, rollback or restore runs or waits: the files change under it.
  const busy = isLifecycleBusy(id);

  let download: ActionState = { allowed: true };
  if (!updaterPath) download = block('no_updater');
  else if (busy) download = block('lifecycle_busy');
  else if (!running) download = block('server_stopped');
  else if (layoutValid === false) download = block('invalid_layout');
  else if (staged) download = block('already_staged');

  let apply: ActionState = { allowed: true };
  if (!updaterPath) apply = block('no_updater');
  else if (!staged) apply = block('nothing_staged');
  else if (busy) apply = block('lifecycle_busy');
  // A staged JAR without a readable Hytale manifest is half-written or foreign.
  else if (!staged.version) apply = block('staged_invalid');
  else if (stagedPatchlineDiffers(staged, installed.patchline)) apply = block('patchline_mismatch');
  else if (disk && disk.checked && !disk.sufficient) apply = block('disk_space');

  // A running server discards it itself (`/update cancel`); a stopped one has
  // the staging folder removed by the panel.
  let cancel: ActionState = { allowed: true };
  if (!updaterPath) cancel = block('no_updater');
  else if (!staged) cancel = block('nothing_staged');
  else if (busy) cancel = block('lifecycle_busy');

  let rollbackNative: ActionState = { allowed: true };
  if (!updaterPath) rollbackNative = block('no_updater');
  else if (!backup) rollbackNative = block('no_backup');
  else if (busy) rollbackNative = block('lifecycle_busy');

  // An updater folder the panel should see but does not may hold a staged
  // update the next start would install over the restored version. (An
  // additional server has none mounted at all, as before.)
  let rollbackSnapshot: ActionState = { allowed: true };
  if (paths.updaterPath && !updaterPath) rollbackSnapshot = block('no_updater');
  else if (busy) rollbackSnapshot = block('lifecycle_busy');

  return {
    available: !!staged,
    currentVersion: installed.version ?? 'unknown',
    latestVersion: staged?.version ?? lastCheck?.latestVersion ?? 'unknown',
    state: staged ? 'READY' : 'IDLE',
    currentPatchline: installed.patchline,
    staged,
    backup,
    serverRunning: running,
    updaterMounted: updaterMount === 'mounted',
    updaterMount,
    lifecycleBusy: busy,
    layoutValid,
    disk,
    lastCheck,
    actions: { download, apply, cancel, rollbackNative, rollbackSnapshot },
  };
}

/** Latest version on the panel's patchline, via the downloader (needs its login). */
export async function checkLatestVersion(serverId?: string): Promise<LatestCheck> {
  const { patchline } = await readPanelConfig();
  const result = await getLatestVersion(patchline);
  const check: LatestCheck = {
    patchline,
    latestVersion: result.version,
    checkedAt: new Date().toISOString(),
    authRequired: result.authRequired,
    error: result.error,
  };
  lastChecks.set(await resolveServerId(serverId), check);
  return check;
}

// ---------- downloader version ----------

export interface DownloaderStatus {
  installed: boolean;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  busy: boolean;
  checkedAt: string;
}

const DOWNLOADER_VERSION_RE = /\b(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)\b/;
const DOWNLOADER_UPDATE_RE =
  /new version of hytale-downloader is available:\s*(\S+)\s*\(current:\s*([^)\s]+)\)/i;
const NO_DOWNLOADER_MARKER = '__NO_DOWNLOADER__';
const DOWNLOADER_CACHE_MS = 60 * 60 * 1000;
const downloaderCache = new Map<string, DownloaderStatus>();

/** Parses `-version` + `-check-update` output (exported for tests). */
export function parseDownloaderOutput(output: string): Omit<DownloaderStatus, 'checkedAt'> {
  if (output.includes(NO_DOWNLOADER_MARKER)) {
    return {
      installed: false,
      version: null,
      latestVersion: null,
      updateAvailable: false,
      busy: false,
    };
  }
  const busy = output.includes(DOWNLOADER_BUSY_MARKER);
  const update = DOWNLOADER_UPDATE_RE.exec(output);
  const version = update?.[2] ?? DOWNLOADER_VERSION_RE.exec(output)?.[1] ?? null;
  return {
    installed: true,
    version,
    latestVersion: update?.[1] ?? (busy ? null : version),
    updateAvailable: !!update,
    busy,
  };
}

/**
 * Version of the downloader and whether a newer one exists. Never updates
 * anything; cached for an hour unless `refresh` is set.
 */
export async function getDownloaderStatus(
  serverId?: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<DownloaderStatus | null> {
  const key = await resolveServerId(serverId);
  const cached = downloaderCache.get(key);
  if (!refresh && cached && Date.now() - Date.parse(cached.checkedAt) < DOWNLOADER_CACHE_MS) {
    return cached;
  }
  const result = await dockerService.execInContainer(
    `[ -x /opt/hytale/downloader/hytale-downloader-linux-amd64 ] || { echo ${NO_DOWNLOADER_MARKER}; exit 0; }; ` +
      downloaderShellCommand('-version', 20) +
      '; ' +
      downloaderShellCommand('-check-update', 30),
    serverId,
    { timeoutMs: 55_000 },
  );
  if (!result.success) return cached ?? null;
  const status: DownloaderStatus = {
    ...parseDownloaderOutput(result.output || ''),
    checkedAt: new Date().toISOString(),
  };
  if (!status.busy) downloaderCache.set(key, status);
  return status;
}

const DOWNLOADER_ZIP_URL = 'https://downloader.hytale.com/hytale-downloader.zip';
const UPDATED_MARKER = '__DOWNLOADER_UPDATED__';

/**
 * Shell command for the game container that replaces the downloader binary
 * with the current official release. The exec starts as root, but the lock and
 * every step run as the hytale user: the downloader folder belongs to the
 * server, and root following a link planted there could overwrite (or create)
 * any file in the container. Downloaded and test-run in a temporary directory
 * first; the swap is a rename, so a failed download changes nothing. Holds the
 * shared downloader lock.
 */
export function buildDownloaderUpdateCommand(): string {
  const script = [
    'set -e',
    'umask 022',
    'tmp=$(mktemp -d /tmp/downloader-update.XXXXXX)',
    'trap \'rm -rf "$tmp"\' EXIT',
    `wget -q --timeout=60 --tries=2 -O "$tmp/d.zip" ${DOWNLOADER_ZIP_URL}`,
    'unzip -q -o "$tmp/d.zip" hytale-downloader-linux-amd64 -d "$tmp"',
    'chmod 755 "$tmp/hytale-downloader-linux-amd64"',
    '"$tmp/hytale-downloader-linux-amd64" -version >/dev/null',
    'rm -f .hytale-downloader-linux-amd64.new',
    'cp "$tmp/hytale-downloader-linux-amd64" .hytale-downloader-linux-amd64.new',
    'mv -f .hytale-downloader-linux-amd64.new hytale-downloader-linux-amd64',
    `echo ${UPDATED_MARKER}`,
  ].join('\n');
  return (
    `cd /opt/hytale/downloader && gosu hytale timeout 150 flock -w 10 -E 75 .downloader.lock sh -c '${script.replace(/'/g, `'\\''`)}' 2>&1; ` +
    `[ $? -eq 75 ] && echo ${DOWNLOADER_BUSY_MARKER}; true`
  );
}

/** Replaces the downloader (only after an explicit confirmation in the UI). */
export async function updateDownloader(
  serverId?: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await dockerService.execInContainer(buildDownloaderUpdateCommand(), serverId, {
    timeoutMs: 160_000,
  });
  const output = result.output || '';
  downloaderCache.delete(await resolveServerId(serverId));
  if (output.includes(UPDATED_MARKER)) return { success: true };
  if (output.includes(DOWNLOADER_BUSY_MARKER)) {
    return {
      success: false,
      error: 'The downloader is busy (a download is running). Try again later.',
    };
  }
  return {
    success: false,
    error:
      result.error ||
      output.split('\n').filter(Boolean).slice(-3).join(' ') ||
      'Downloader update failed',
  };
}
