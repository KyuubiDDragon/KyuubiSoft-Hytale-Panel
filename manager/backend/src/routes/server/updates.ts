// Update Center endpoints: version check, native updates (status read from the
// installation's files; download / apply / cancel as console commands),
// native update settings, history, JAR snapshots + rollback, downloader version.
import { Router, Response } from 'express';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as dockerService from '../../services/docker.js';
import { isDemoMode, getDemoUpdateStatus, getDemoUpdateConfig } from '../../services/demoData.js';
import { readPanelConfig, getLatestVersion } from './shared.js';
import {
  getReconciledHistory,
  recordUpdate,
  snapshotCurrentJar,
  listJarSnapshots,
  rollbackToSnapshot,
  rollbackToNativeBackup,
  type RollbackResult,
} from '../../services/updateHistory.js';
import {
  resolveInstallPaths,
  readInstalledVersion,
  getStagedUpdate,
  discardStagedUpdate,
  setStagedUpdateAside,
  checkUpdaterMount,
} from '../../services/serverInstall.js';
import {
  readUpdateSettings,
  validateUpdateSettingsPatch,
  writeUpdateSettings,
} from '../../services/updateSettings.js';
import {
  getUpdateCenterStatus,
  checkLatestVersion,
  getDownloaderStatus,
  updateDownloader,
  stagedPatchlineDiffers,
} from '../../services/updateCenter.js';
import {
  withServerStopped,
  startServer,
  isLifecycleBusy,
  LifecycleError,
  LifecycleBusyError,
} from '../../services/serverLifecycle.js';
import { resolveServerId } from '../../services/servers.js';
import { readJsonFile } from '../../utils/jsonStore.js';
import { UnsafeFileError } from '../../utils/noFollowFs.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

const MAX_COUNTDOWN_SECONDS = 1800;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

const BUSY_RESPONSE = {
  success: false,
  reason: 'lifecycle_busy',
  error: 'Another server operation (stop, start, rollback, restore) is running.',
};

/** 409 lifecycle_busy when another operation holds or waits for the server's lock. */
async function refuseIfBusy(req: AuthenticatedRequest, res: Response): Promise<boolean> {
  if (!isLifecycleBusy(await resolveServerId(req.serverId))) return false;
  res.status(409).json(BUSY_RESPONSE);
  return true;
}

const NO_UPDATER_ERROR =
  "The panel cannot see the game container's updater folder, so a downloaded update would stay invisible and be installed on the next start. Update docker-compose.yml (updater mount for both services) and recreate the containers.";

function countdownFrom(body: unknown): number {
  const v = (body as { countdownSeconds?: unknown } | undefined)?.countdownSeconds;
  return Number.isInteger(v) && (v as number) > 0
    ? Math.min(v as number, MAX_COUNTDOWN_SECONDS)
    : 0;
}

/** A rollback that failed inside withServerStopped. */
class RollbackFailed extends Error {
  constructor(readonly result: RollbackResult) {
    super(result.error ?? 'Rollback failed');
  }
}

async function isServerRunning(serverId?: string): Promise<boolean> {
  const state = await dockerService.getContainerState(serverId).catch(() => null);
  return state?.running === true;
}

// GET /api/server/check-update - Check if a Hytale server update is available
router.get(
  '/check-update',
  authMiddleware,
  requirePermission('server.view_status'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        installedVersion: '1.0.0-demo',
        latestVersion: '1.0.1-demo',
        updateAvailable: true,
        patchline: 'release',
        authRequired: false,
        versions: { release: '1.0.1-demo', preRelease: '1.1.0-pre.1-demo' },
        message: '[DEMO] Update available: 1.0.0-demo → 1.0.1-demo',
      });
      return;
    }

    try {
      const { serverPath } = await resolveInstallPaths(req.serverId);
      const installedVersion = (await readInstalledVersion(serverPath)).version ?? 'unknown';
      const { patchline: currentPatchline } = await readPanelConfig();

      // One after the other: the downloader calls share a lock and a probe
      // that cannot get it reports "busy" instead of waiting.
      const releaseResult = await getLatestVersion('release');
      const preReleaseResult = await getLatestVersion('pre-release');

      const authRequired = releaseResult.authRequired || preReleaseResult.authRequired;
      const latestVersionResult = currentPatchline === 'release' ? releaseResult : preReleaseResult;
      const latestVersion = latestVersionResult.version;
      const updateAvailable =
        installedVersion !== 'unknown' &&
        latestVersion !== 'unknown' &&
        installedVersion !== latestVersion;

      let message: string;
      if (authRequired) {
        message =
          'Downloader authentication required. Please re-authenticate to check for updates.';
      } else if (updateAvailable) {
        message = `Update available: ${installedVersion} → ${latestVersion}`;
      } else if (installedVersion === latestVersion) {
        message = 'Server is up to date';
      } else if (latestVersion === 'unknown') {
        message =
          latestVersionResult.error ||
          'Could not fetch latest version. Check network connection or re-authenticate.';
      } else {
        message = 'Could not determine update status';
      }

      res.json({
        installedVersion,
        latestVersion,
        updateAvailable,
        patchline: currentPatchline,
        authRequired,
        versions: { release: releaseResult.version, preRelease: preReleaseResult.version },
        message,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to check for updates', message: errorMessage(error) });
    }
  },
);

// ============================================================
// Native update settings (config.json → "Update")
// ============================================================

async function readServerConfig(serverId?: string): Promise<{ file: string; data: unknown }> {
  const { serverPath } = await resolveInstallPaths(serverId);
  const file = path.join(serverPath, 'config.json');
  // The server can write here: a link is not followed.
  return { file, data: (await readJsonFile<unknown>(file, { confineTo: [serverPath] })) ?? {} };
}

// GET /api/server/update-config - Native update settings
router.get(
  '/update-config',
  authMiddleware,
  requirePermission('updates.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json(getDemoUpdateConfig());
      return;
    }
    try {
      const [{ data }, panelConfig] = await Promise.all([
        readServerConfig(req.serverId),
        readPanelConfig(),
      ]);
      res.json(readUpdateSettings(data, panelConfig.patchline));
    } catch (error) {
      res.status(500).json({ error: 'Failed to read update config', message: errorMessage(error) });
    }
  },
);

// PUT /api/server/update-config - Save native update settings.
// The server keeps its config in memory and writes it back when something
// changes, so config.json is only written while it is stopped: with the
// server running the request is refused (409, requiresRestart) unless it asks
// for `restart: true`, which stops the server, saves and starts it again.
router.put(
  '/update-config',
  authMiddleware,
  requirePermission('updates.config'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        success: true,
        message: '[DEMO] Update config saved (simulated)',
        data: getDemoUpdateConfig(),
      });
      return;
    }
    try {
      const [{ file, data }, panelConfig] = await Promise.all([
        readServerConfig(req.serverId),
        readPanelConfig(),
      ]);
      const current = readUpdateSettings(data, panelConfig.patchline);
      const validation = validateUpdateSettingsPatch(req.body, current);
      if (!validation.ok) {
        res.status(400).json({ success: false, error: validation.error });
        return;
      }
      const restart = req.body?.restart === true;
      // A start or restart in progress would read the file meanwhile.
      if (await refuseIfBusy(req, res)) return;
      const running = await isServerRunning(req.serverId);
      if (running && !restart) {
        res.status(409).json({
          success: false,
          requiresRestart: true,
          error:
            'The server is running. Update settings can only be saved while it is stopped; save with a restart.',
        });
        return;
      }
      const write = () => writeUpdateSettings(file, validation.patch);
      const written = running
        ? await withServerStopped(
            req.serverId,
            {
              reason: 'config',
              actor: req.user,
              countdownSeconds: countdownFrom(req.body),
              rejectIfBusy: true,
            },
            write,
          )
        : await write();
      res.json({
        success: true,
        message: running ? 'Update settings saved, server restarted' : 'Update settings saved',
        restarted: running,
        data: readUpdateSettings(written, panelConfig.patchline),
      });
    } catch (error) {
      if (error instanceof LifecycleBusyError) {
        res.status(409).json(BUSY_RESPONSE);
        return;
      }
      const status = error instanceof LifecycleError ? 503 : 500;
      res.status(status).json({
        success: false,
        error: 'Failed to save update config',
        message: errorMessage(error),
      });
    }
  },
);

// ============================================================
// Native updates
// ============================================================

// GET /api/server/update-status - Installed / staged / previous version, actions
router.get(
  '/update-status',
  authMiddleware,
  requirePermission('updates.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, data: getDemoUpdateStatus() });
      return;
    }
    try {
      res.json({ success: true, data: await getUpdateCenterStatus(req.serverId) });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get update status', message: errorMessage(error) });
    }
  },
);

// POST /api/server/update-check - Latest version on the panel's patchline
router.post(
  '/update-check',
  authMiddleware,
  requirePermission('updates.check'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        success: true,
        message: '[DEMO] Update check completed',
        data: getDemoUpdateStatus(),
      });
      return;
    }
    try {
      const check = await checkLatestVersion(req.serverId);
      const status = await getUpdateCenterStatus(req.serverId);
      if (check.latestVersion === 'unknown') {
        // 409, not 401: the panel session is fine, only the downloader needs
        // a login (a 401 would make the client refresh its own token).
        res.status(check.authRequired ? 409 : 502).json({
          success: false,
          authRequired: !!check.authRequired,
          error: check.error || 'Could not determine the latest version',
          data: status,
        });
        return;
      }
      res.json({ success: true, message: 'Update check completed', data: status });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, error: 'Update check failed', message: errorMessage(error) });
    }
  },
);

// POST /api/server/update-download - Let the server download the update
// (`/update download`). The result is not visible here: a finished download
// appears as the staged update in /update-status.
router.post(
  '/update-download',
  authMiddleware,
  requirePermission('updates.download'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Update download started (simulated)' });
      return;
    }
    try {
      const status = await getUpdateCenterStatus(req.serverId);
      if (!status.actions.download.allowed) {
        res.status(409).json({
          success: false,
          reason: status.actions.download.reason,
          error: 'Download not possible right now',
        });
        return;
      }
      const result = await dockerService.execCommand('/update download', req.serverId);
      if (!result.success) {
        res
          .status(503)
          .json({ success: false, error: result.error || 'Could not send the command' });
        return;
      }
      res.status(202).json({
        success: true,
        message:
          'Download requested. The server downloads in the background (progress in the console); the staged version appears here when it is done.',
      });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, error: 'Download failed', message: errorMessage(error) });
    }
  },
);

// POST /api/server/update-apply - Apply the staged update.
// Running server: `/update apply --confirm` (the server backs up the current
// files to updater/backup and restarts with exit code 8; the start script then
// puts the staged files in place). Stopped server: the start script applies
// the staged update on start, so the server is simply started.
// `force` overrides the checks of the staged JAR and the disk space;
// `allowPatchlineSwitch` confirms installing a build of another patchline.
router.post(
  '/update-apply',
  authMiddleware,
  requirePermission('updates.apply'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        success: true,
        message: '[DEMO] Update applied (simulated)',
        warning: 'Server would restart in real mode',
      });
      return;
    }
    try {
      const status = await getUpdateCenterStatus(req.serverId);
      const force = req.body?.force === true;
      const allowPatchlineSwitch = req.body?.allowPatchlineSwitch === true;
      if (status.actions.apply.reason === 'no_updater') {
        res.status(409).json({ success: false, reason: 'no_updater', error: NO_UPDATER_ERROR });
        return;
      }
      if (!status.staged) {
        res.status(409).json({
          success: false,
          reason: 'nothing_staged',
          error: 'No update is staged. Download one first.',
        });
        return;
      }
      if (status.actions.apply.reason === 'lifecycle_busy') {
        res.status(409).json(BUSY_RESPONSE);
        return;
      }
      // Each check on its own (the status names only the first one that fails).
      if (!status.staged.version && !force) {
        res.status(409).json({
          success: false,
          reason: 'staged_invalid',
          error:
            'The staged HytaleServer.jar has no readable Hytale version (incomplete or foreign file).',
        });
        return;
      }
      if (stagedPatchlineDiffers(status.staged, status.currentPatchline) && !allowPatchlineSwitch) {
        res.status(409).json({
          success: false,
          reason: 'patchline_mismatch',
          error: `The staged update is for the ${status.staged.patchline} patchline, the installed server is ${status.currentPatchline}.`,
        });
        return;
      }
      if (status.disk?.checked && !status.disk.sufficient && !force) {
        res.status(409).json({
          success: false,
          reason: 'disk_space',
          error: 'Not enough free disk space to back up the current version and apply the update.',
          disk: status.disk,
        });
        return;
      }

      const fromVersion = status.currentVersion !== 'unknown' ? status.currentVersion : null;
      const toVersion = status.staged.version;
      // Panel snapshot as an extra rollback point; never blocks the update.
      await snapshotCurrentJar(req.serverId).catch((err: unknown) =>
        console.warn(`[Updates] No JAR snapshot before the update: ${errorMessage(err)}`),
      );

      if (status.serverRunning) {
        const result = await dockerService.execCommand('/update apply --confirm', req.serverId);
        if (!result.success) {
          res
            .status(503)
            .json({ success: false, error: result.error || 'Could not send the command' });
          return;
        }
      } else {
        const started = await startServer(req.serverId, {
          reason: 'update',
          actor: req.user,
          rejectIfBusy: true,
        });
        if (!started.ok) {
          res
            .status(503)
            .json({ success: false, error: `Could not start the server: ${started.error}` });
          return;
        }
      }

      await recordUpdate({
        action: 'apply',
        fromVersion,
        toVersion,
        by: req.user ?? null,
        success: false,
        pending: true,
      });
      res.json({
        success: true,
        message: status.serverRunning
          ? 'Update requested. The server backs up its files, restarts and installs the update.'
          : 'The server is starting and installs the staged update first.',
        warning: 'Players will be disconnected while the server restarts.',
      });
    } catch (error) {
      if (error instanceof LifecycleBusyError) {
        res.status(409).json(BUSY_RESPONSE);
        return;
      }
      res
        .status(500)
        .json({ success: false, error: 'Apply update failed', message: errorMessage(error) });
    }
  },
);

// POST /api/server/update-cancel - Discard the staged update. A running server
// does it itself (`/update cancel`); for a stopped one the panel deletes the
// staging folder (starting the server would install it first).
router.post(
  '/update-cancel',
  authMiddleware,
  requirePermission('updates.download'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Update cancelled (simulated)' });
      return;
    }
    try {
      const status = await getUpdateCenterStatus(req.serverId);
      if (!status.actions.cancel.allowed) {
        res.status(409).json({
          success: false,
          reason: status.actions.cancel.reason,
          error: 'Nothing to discard right now',
        });
        return;
      }
      if (status.serverRunning) {
        // The container also runs while the start script installs the staged
        // update or restarts Java: nobody would read the command then.
        if ((await dockerService.isServerProcessRunning(req.serverId)) === false) {
          res.status(409).json({
            success: false,
            reason: 'lifecycle_busy',
            error: 'The server is starting or installing an update; try again in a moment.',
          });
          return;
        }
        const result = await dockerService.execCommand('/update cancel', req.serverId);
        if (!result.success) {
          res
            .status(503)
            .json({ success: false, error: result.error || 'Could not send the command' });
          return;
        }
        res.json({ success: true, message: 'Cancel requested' });
        return;
      }
      const { updaterPath } = await resolveInstallPaths(req.serverId);
      // Under the lifecycle lock, so the server is not started meanwhile.
      await withServerStopped(
        req.serverId,
        { reason: 'update', actor: req.user, rejectIfBusy: true },
        () => discardStagedUpdate(updaterPath),
      );
      res.json({ success: true, discarded: true, message: 'Staged update discarded' });
    } catch (error) {
      if (error instanceof LifecycleBusyError) {
        res.status(409).json(BUSY_RESPONSE);
        return;
      }
      const status = error instanceof LifecycleError ? 503 : 500;
      res
        .status(status)
        .json({ success: false, error: 'Cancel failed', message: errorMessage(error) });
    }
  },
);

// ============================================================
// History, snapshots, rollback
// ============================================================

// GET /api/server/update-history - Applied/rolled-back update log
router.get(
  '/update-history',
  authMiddleware,
  requirePermission('updates.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        history: [
          {
            id: 'demo-1',
            at: new Date(Date.now() - 86400000).toISOString(),
            fromVersion: '1.0.3',
            toVersion: '1.0.4',
            action: 'apply',
            by: 'admin',
            success: true,
          },
        ],
      });
      return;
    }
    try {
      res.json({ history: await getReconciledHistory(req.serverId) });
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to read update history', message: errorMessage(error) });
    }
  },
);

// GET /api/server/jar-snapshots - Available rollback points
router.get(
  '/jar-snapshots',
  authMiddleware,
  requirePermission('updates.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        snapshots: [
          {
            id: 'demo-snap-1',
            version: '1.0.3',
            createdAt: new Date(Date.now() - 86400000).toISOString(),
            sizeBytes: 104857600,
            file: 'HytaleServer-1.0.3.jar',
            hasAssets: true,
          },
        ],
      });
      return;
    }
    try {
      res.json({ snapshots: await listJarSnapshots(req.serverId) });
    } catch (error) {
      res.status(500).json({ error: 'Failed to list snapshots', message: errorMessage(error) });
    }
  },
);

// POST /api/server/jar-snapshot - Manually snapshot the current JAR (+ Assets.zip link)
router.post(
  '/jar-snapshot',
  authMiddleware,
  requirePermission('updates.apply'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] JAR snapshot created (simulated)' });
      return;
    }
    try {
      // A rollback or update may be swapping the files right now.
      if (await refuseIfBusy(req, res)) return;
      const snap = await snapshotCurrentJar(req.serverId);
      if (!snap) {
        res.status(400).json({ success: false, error: 'No server JAR to snapshot yet' });
        return;
      }
      res.json({ success: true, snapshot: snap });
    } catch (error) {
      if (error instanceof UnsafeFileError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      res
        .status(500)
        .json({ success: false, error: 'Snapshot failed', message: errorMessage(error) });
    }
  },
);

// POST /api/server/rollback - Restore a snapshot ({ snapshotId }) or the
// previous version from updater/backup ({ source: 'native' }). The server is
// stopped cleanly first and started again afterwards if it was running. A
// staged update would be installed again by that start, so it has to be
// discarded along with the rollback ({ discardStaged: true }).
router.post(
  '/rollback',
  authMiddleware,
  requirePermission('updates.apply'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        success: true,
        message: '[DEMO] Rolled back (simulated)',
        warning: 'Server would restart in real mode',
      });
      return;
    }

    const { snapshotId, source } = (req.body ?? {}) as { snapshotId?: unknown; source?: unknown };
    const native = source === 'native';
    if (!native && (typeof snapshotId !== 'string' || !snapshotId)) {
      res.status(400).json({ success: false, error: 'snapshotId or source "native" required' });
      return;
    }

    let fromVersion: string | null = null;
    let running = false;
    let autoUpdate = false;
    let discardedVersion: string | null = null;
    let result: RollbackResult;
    try {
      // A second click while the first rollback (or any stop/start) runs must
      // not queue a second one behind it.
      if (await refuseIfBusy(req, res)) return;
      const paths = await resolveInstallPaths(req.serverId);
      // An updater folder the panel cannot see may hold a staged update that
      // the next start would install over the restored version.
      if (paths.updaterPath && (await checkUpdaterMount(paths)) !== 'mounted') {
        res.status(409).json({ success: false, reason: 'no_updater', error: NO_UPDATER_ERROR });
        return;
      }
      fromVersion = (await readInstalledVersion(paths.serverPath)).version;
      running = await isServerRunning(req.serverId);
      autoUpdate = (await readPanelConfig()).autoUpdate === true;
      // The start script installs a staged update on every start, so it
      // would replace the restored version right away.
      const discardStaged = req.body?.discardStaged === true;
      if ((await getStagedUpdate(paths.updaterPath)) && !discardStaged) {
        res.status(409).json({
          success: false,
          reason: 'staged_update',
          error:
            'An update is downloaded and would be installed again on the next start. Discard it first.',
        });
        return;
      }
      result = await withServerStopped(
        req.serverId,
        {
          reason: 'rollback',
          actor: req.user,
          countdownSeconds: countdownFrom(req.body),
          rejectIfBusy: true,
        },
        async () => {
          // Checked again under the lock: the server may have staged one
          // until it stopped.
          const staged = await getStagedUpdate(paths.updaterPath);
          if (staged && !discardStaged) {
            throw new RollbackFailed({
              success: false,
              error: 'An update was downloaded meanwhile; the rollback was not started.',
            });
          }
          // Out of the way before the start that follows, but only deleted
          // once the rollback worked: a failed one leaves it staged.
          const aside = staged ? await setStagedUpdateAside(paths.updaterPath) : null;
          const r = native
            ? await rollbackToNativeBackup(req.serverId)
            : await rollbackToSnapshot(snapshotId as string, req.serverId);
          // A failed rollback changed nothing (every file is swapped in by
          // rename at the end, and put back if a rename fails); the server
          // comes back on the old version.
          if (!r.success) {
            const restored = await aside?.restore().then(
              () => true,
              () => false,
            );
            throw new RollbackFailed(
              restored === false
                ? { ...r, error: `${r.error}; the downloaded update could not be put back` }
                : r,
            );
          }
          if (aside && staged) {
            await aside.remove();
            discardedVersion = staged.version ?? 'unknown';
          }
          return r;
        },
      );
    } catch (error) {
      // Refused before anything happened: nothing to record.
      if (error instanceof LifecycleBusyError) {
        res.status(409).json(BUSY_RESPONSE);
        return;
      }
      const failed = error instanceof RollbackFailed ? error.result : null;
      const message = failed?.error ?? errorMessage(error);
      await recordUpdate({
        action: 'rollback',
        fromVersion,
        toVersion: null,
        by: req.user ?? null,
        success: false,
        note: message,
      });
      res.status(failed ? 400 : 503).json({ success: false, error: message });
      return;
    }

    await recordUpdate({
      action: 'rollback',
      fromVersion,
      toVersion: result.restoredVersion ?? null,
      by: req.user ?? null,
      success: true,
      note:
        [
          result.restoredAssets ? null : 'JAR only (Assets.zip unchanged)',
          discardedVersion ? `staged update ${discardedVersion} discarded` : null,
        ]
          .filter(Boolean)
          .join('; ') || undefined,
    });
    res.json({
      success: true,
      message: `Rolled back to ${result.restoredVersion ?? 'the previous version'}.${running ? ' The server is starting again.' : ''}`,
      restoredVersion: result.restoredVersion ?? null,
      restoredAssets: !!result.restoredAssets,
      discardedStagedVersion: discardedVersion,
      // The downloader check at container start would fetch the latest build again.
      warning: autoUpdate
        ? 'Auto-updates are on: the next container start downloads the latest version again.'
        : undefined,
    });
  },
);

// ============================================================
// Downloader version (reported only; replaced after confirmation)
// ============================================================

// GET /api/server/downloader-version - Installed downloader version + newer one
router.get(
  '/downloader-version',
  authMiddleware,
  requirePermission('updates.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        success: true,
        data: {
          installed: true,
          version: '2026.01.09-demo',
          latestVersion: '2026.05.13-demo',
          updateAvailable: true,
          busy: false,
          checkedAt: new Date().toISOString(),
        },
      });
      return;
    }
    try {
      const data = await getDownloaderStatus(req.serverId, { refresh: req.query.refresh === '1' });
      if (!data) {
        res.status(503).json({ success: false, error: 'Server container not running' });
        return;
      }
      res.json({ success: true, data });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, error: 'Downloader check failed', message: errorMessage(error) });
    }
  },
);

// POST /api/server/downloader-update - Replace the downloader with the current release
router.post(
  '/downloader-update',
  authMiddleware,
  requirePermission('updates.apply'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Downloader updated (simulated)' });
      return;
    }
    try {
      if (!(await isServerRunning(req.serverId))) {
        res.status(409).json({
          success: false,
          reason: 'server_stopped',
          error: 'The game container must be running.',
        });
        return;
      }
      const result = await updateDownloader(req.serverId);
      if (!result.success) {
        res.status(502).json({ success: false, error: result.error });
        return;
      }
      const data = await getDownloaderStatus(req.serverId, { refresh: true });
      res.json({ success: true, message: 'Downloader updated', data });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, error: 'Downloader update failed', message: errorMessage(error) });
    }
  },
);

export default router;
