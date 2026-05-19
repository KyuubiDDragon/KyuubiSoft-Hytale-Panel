// Update-related endpoints: legacy version check + native update system (config,
// status, check, download, apply, cancel).
import { Router, Request, Response } from 'express';
import { readFile, writeFile, access, constants } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as dockerService from '../../services/docker.js';
import { config } from '../../config.js';
import {
  isDemoMode,
  getDemoUpdateStatus,
  getDemoUpdateConfig,
} from '../../services/demoData.js';
import {
  readPanelConfig,
  getLatestVersion,
  UpdateConfig,
  getDefaultUpdateConfig,
  parseUpdateStatusOutput,
} from './shared.js';

const router = Router();

// GET /api/server/check-update - Check if a Hytale server update is available
router.get('/check-update', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  // Demo mode: return mock update status
  if (isDemoMode()) {
    const updateStatus = getDemoUpdateStatus();
    res.json({
      installedVersion: updateStatus.currentVersion,
      latestVersion: updateStatus.latestVersion,
      updateAvailable: updateStatus.updateAvailable,
      patchline: 'release',
      authRequired: false,
      versions: {
        release: updateStatus.latestVersion,
        preRelease: '1.1.0-pre.1-demo',
      },
      message: updateStatus.updateAvailable
        ? `[DEMO] Update available: ${updateStatus.currentVersion} → ${updateStatus.latestVersion}`
        : '[DEMO] Server is up to date',
    });
    return;
  }

  try {
    // Read installed version from file
    const versionFilePath = path.join(config.serverPath, '.hytale-version');
    let installedVersion = 'unknown';
    try {
      installedVersion = (await readFile(versionFilePath, 'utf-8')).trim();
    } catch {
      // Version file doesn't exist yet
    }

    // Get current patchline setting from panel config
    const panelConfig = await readPanelConfig();
    const currentPatchline = panelConfig.patchline;

    // Check both patchlines in parallel
    const [releaseResult, preReleaseResult] = await Promise.all([
      getLatestVersion('release'),
      getLatestVersion('pre-release')
    ]);

    // Check if any auth is required
    const authRequired = releaseResult.authRequired || preReleaseResult.authRequired;

    // Check if update is available for current patchline
    const latestVersionResult = currentPatchline === 'release' ? releaseResult : preReleaseResult;
    const latestVersion = latestVersionResult.version;
    const updateAvailable = installedVersion !== 'unknown' &&
                           latestVersion !== 'unknown' &&
                           installedVersion !== latestVersion;

    // Determine appropriate message
    let message: string;
    if (authRequired) {
      message = 'Downloader authentication required. Please re-authenticate to check for updates.';
    } else if (updateAvailable) {
      message = `Update available: ${installedVersion} → ${latestVersion}`;
    } else if (installedVersion === latestVersion) {
      message = 'Server is up to date';
    } else if (latestVersion === 'unknown') {
      message = 'Could not fetch latest version. Check network connection or re-authenticate.';
    } else {
      message = 'Could not determine update status';
    }

    res.json({
      installedVersion,
      latestVersion,
      updateAvailable,
      patchline: currentPatchline,
      authRequired, // NEW: indicates if re-authentication is needed
      // Include both patchline versions
      versions: {
        release: releaseResult.version,
        preRelease: preReleaseResult.version
      },
      message,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check for updates',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ============================================================
// Native Update System Endpoints (Hytale 24.01.2026+)
// ============================================================

// GET /api/server/update-config - Get native update configuration
router.get('/update-config', authMiddleware, requirePermission('updates.view'), async (_req: Request, res: Response) => {
  // Demo mode: return demo update config
  if (isDemoMode()) {
    res.json(getDemoUpdateConfig());
    return;
  }

  try {
    const configPath = path.join(config.serverPath, 'config.json');

    try {
      await access(configPath, constants.R_OK);
      const serverConfig = JSON.parse(await readFile(configPath, 'utf-8'));
      const updateConfig = serverConfig.updateConfig || getDefaultUpdateConfig();
      res.json(updateConfig);
    } catch {
      // Config doesn't exist yet, return defaults
      res.json(getDefaultUpdateConfig());
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to read update config',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/update-config - Update native update configuration
router.put('/update-config', authMiddleware, requirePermission('updates.config'), async (req: Request, res: Response) => {
  // Demo mode: simulate config update
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Update config saved (simulated)' });
    return;
  }

  try {
    const {
      enabled,
      checkIntervalSeconds,
      notifyPlayersOnAvailable,
      patchline,
      runBackupBeforeUpdate,
      backupConfigBeforeUpdate,
      autoApplyMode,
      autoApplyDelayMinutes
    } = req.body;

    // Validation
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Field "enabled" must be boolean' });
    }
    if (checkIntervalSeconds !== undefined && (!Number.isInteger(checkIntervalSeconds) || checkIntervalSeconds < 60)) {
      return res.status(400).json({ error: 'Field "checkIntervalSeconds" must be integer >= 60' });
    }
    if (patchline !== undefined && !['release', 'pre-release'].includes(patchline)) {
      return res.status(400).json({ error: 'Field "patchline" must be "release" or "pre-release"' });
    }
    if (autoApplyMode !== undefined && !['DISABLED', 'WHEN_EMPTY', 'SCHEDULED'].includes(autoApplyMode)) {
      return res.status(400).json({ error: 'Field "autoApplyMode" must be DISABLED, WHEN_EMPTY, or SCHEDULED' });
    }
    if (autoApplyDelayMinutes !== undefined && (!Number.isInteger(autoApplyDelayMinutes) || autoApplyDelayMinutes < 1)) {
      return res.status(400).json({ error: 'Field "autoApplyDelayMinutes" must be integer >= 1' });
    }

    const configPath = path.join(config.serverPath, 'config.json');

    // Read existing config or create new
    let serverConfig: Record<string, unknown> = {};
    try {
      await access(configPath, constants.R_OK);
      serverConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    } catch {
      // Config doesn't exist, will create new
    }

    // Merge with existing updateConfig
    const currentUpdateConfig = (serverConfig.updateConfig as UpdateConfig) || getDefaultUpdateConfig();
    serverConfig.updateConfig = {
      ...currentUpdateConfig,
      ...(enabled !== undefined && { enabled }),
      ...(checkIntervalSeconds !== undefined && { checkIntervalSeconds }),
      ...(notifyPlayersOnAvailable !== undefined && { notifyPlayersOnAvailable }),
      ...(patchline !== undefined && { patchline }),
      ...(runBackupBeforeUpdate !== undefined && { runBackupBeforeUpdate }),
      ...(backupConfigBeforeUpdate !== undefined && { backupConfigBeforeUpdate }),
      ...(autoApplyMode !== undefined && { autoApplyMode }),
      ...(autoApplyDelayMinutes !== undefined && { autoApplyDelayMinutes }),
    };

    await writeFile(configPath, JSON.stringify(serverConfig, null, 2));

    res.json({
      success: true,
      message: 'Update config saved',
      data: serverConfig.updateConfig
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save update config',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/update-status - Get native update status
router.get('/update-status', authMiddleware, requirePermission('updates.view'), async (_req: Request, res: Response) => {
  // Demo mode: return demo update status
  if (isDemoMode()) {
    res.json({ success: true, data: getDemoUpdateStatus() });
    return;
  }

  try {
    const result = await dockerService.execCommand('/update status');

    if (!result.success) {
      return res.status(503).json({
        error: 'Server not responding',
        message: 'Cannot query update status. Is the server running?'
      });
    }

    const status = parseUpdateStatusOutput(result.message || '');
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get update status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/update-check - Check for updates
router.post('/update-check', authMiddleware, requirePermission('updates.check'), async (_req: Request, res: Response) => {
  try {
    const result = await dockerService.execCommand('/update check');

    if (!result.success) {
      return res.status(503).json({
        success: false,
        error: result.error || 'Update check failed',
        message: 'Server may be offline or not responding'
      });
    }

    // Give server time to process and get status
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statusResult = await dockerService.execCommand('/update status');
    const status = parseUpdateStatusOutput(statusResult.message || '');

    res.json({
      success: true,
      message: 'Update check completed',
      data: status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Update check failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/update-download - Download available update
router.post('/update-download', authMiddleware, requirePermission('updates.download'), async (_req: Request, res: Response) => {
  // Demo mode: simulate update download
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Update download started (simulated)', data: { state: 'DOWNLOADING', progress: 0 } });
    return;
  }

  try {
    const result = await dockerService.execCommand('/update download');

    if (!result.success) {
      return res.status(503).json({
        success: false,
        error: result.error || 'Download failed',
        message: 'Server may be offline or not responding'
      });
    }

    res.json({
      success: true,
      message: 'Update download started. Check status for progress.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Download failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/update-apply - Apply downloaded update (restarts server)
router.post('/update-apply', authMiddleware, requirePermission('updates.apply'), async (_req: Request, res: Response) => {
  // Demo mode: simulate update apply
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Update applied (simulated)', warning: 'Server would restart in real mode' });
    return;
  }

  try {
    // Check if update is ready
    const statusResult = await dockerService.execCommand('/update status');
    const status = parseUpdateStatusOutput(statusResult.message || '');

    if (status.state !== 'READY') {
      return res.status(400).json({
        success: false,
        error: 'No update ready to apply',
        message: 'Download an update first using /update download'
      });
    }

    // Apply update (server will restart with exit code 8)
    await dockerService.execCommand('/update apply');

    res.json({
      success: true,
      message: 'Update applied. Server is restarting...',
      warning: 'Server will restart shortly. Players will be disconnected.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Apply update failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/update-cancel - Cancel ongoing download
router.post('/update-cancel', authMiddleware, requirePermission('updates.download'), async (_req: Request, res: Response) => {
  // Demo mode: simulate update cancel
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Update cancelled (simulated)' });
    return;
  }

  try {
    await dockerService.execCommand('/update cancel');

    res.json({
      success: true,
      message: 'Update download cancelled'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Cancel failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
