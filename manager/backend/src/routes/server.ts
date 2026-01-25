import { Router, Request, Response } from 'express';
import { readdir, readFile, writeFile, stat, access, constants } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as dockerService from '../services/docker.js';
import * as kyuubiApiService from '../services/kyuubiApi.js';
import { getPlayerInventoryFromFile, getPlayerDetailsFromFile } from '../services/players.js';
import { config } from '../config.js';
import { dismissNewFeaturesBanner } from '../services/migration.js';
import {
  isDemoMode,
  getDemoQuickSettings,
  getDemoMemoryStats,
  getDemoUpdateStatus,
  getDemoUpdateConfig,
  getDemoVersionInfo,
  getDemoPluginUpdateStatus,
  getDemoNewFeatures,
  getDemoConfigFiles,
  getDemoServerConfig,
  getDemoDownloaderStatus,
  getDemoPatchlineConfig,
} from '../services/demoData.js';

const router = Router();

// Allowed config file extensions
const CONFIG_EXTENSIONS = ['.json', '.properties', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini'];

// Quick settings interface
interface QuickSettings {
  serverName: string;
  motd: string;
  password: string;
  maxPlayers: number;
  maxViewRadius: number;
  defaultGameMode: string;
}

// GET /api/server/demo - Check if demo mode is enabled (no auth required for login page)
router.get('/demo', (_req: Request, res: Response) => {
  res.json({
    demoMode: isDemoMode(),
    message: isDemoMode() ? 'Panel is running in demo mode. All data is simulated.' : undefined,
  });
});

// GET /api/server/status
router.get('/status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  const status = await dockerService.getStatus();
  res.json(status);
});

// GET /api/server/stats
router.get('/stats', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  const stats = await dockerService.getStats();
  res.json(stats);
});

// GET /api/server/memory - Get detailed memory stats from server command
router.get('/memory', authMiddleware, requirePermission('performance.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock memory stats
  if (isDemoMode()) {
    res.json(getDemoMemoryStats());
    return;
  }

  try {
    const result = await dockerService.execCommand('/server stats memory');

    if (!result.success || !result.output) {
      res.json({
        available: false,
        error: result.error || 'Command not available',
      });
      return;
    }

    // Parse the output:
    // Total Physical Memory: 62.7 GiB
    // Free Physical Memory: 5.8 GiB
    // Total Swap Memory: 7.6 GiB
    // Free Swap Memory: 5.5 GiB
    // Heap Memory Usage:
    // Init: 4.0 GiB
    // Used: 1.2 GiB
    // Committed: 4.0 GiB
    // Max: 16.0 GiB

    const output = result.output;

    const parseValue = (pattern: RegExp): number | null => {
      const match = output.match(pattern);
      if (match) {
        return parseFloat(match[1]);
      }
      return null;
    };

    const memoryStats = {
      available: true,
      physical: {
        total: parseValue(/Total Physical Memory:\s*([\d.]+)\s*GiB/i),
        free: parseValue(/Free Physical Memory:\s*([\d.]+)\s*GiB/i),
      },
      swap: {
        total: parseValue(/Total Swap Memory:\s*([\d.]+)\s*GiB/i),
        free: parseValue(/Free Swap Memory:\s*([\d.]+)\s*GiB/i),
      },
      heap: {
        init: parseValue(/Init:\s*([\d.]+)\s*GiB/i),
        used: parseValue(/Used:\s*([\d.]+)\s*GiB/i),
        committed: parseValue(/Committed:\s*([\d.]+)\s*GiB/i),
        max: parseValue(/Max:\s*([\d.]+)\s*GiB/i),
      },
      raw: output,
    };

    res.json(memoryStats);
  } catch (error) {
    res.status(500).json({
      available: false,
      error: error instanceof Error ? error.message : 'Failed to get memory stats',
    });
  }
});

// GET /api/server/quick-settings - Get quick settings from config.json
router.get('/quick-settings', authMiddleware, requirePermission('config.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock settings
  if (isDemoMode()) {
    res.json(getDemoQuickSettings());
    return;
  }

  try {
    const configPath = path.join(config.serverPath, 'config.json');
    const content = await readFile(configPath, 'utf-8');
    const configData = JSON.parse(content);

    const quickSettings: QuickSettings = {
      serverName: configData.ServerName || 'Hytale Server',
      motd: configData.MOTD || '',
      password: configData.Password || '',
      maxPlayers: configData.MaxPlayers || 100,
      maxViewRadius: configData.MaxViewRadius || 32,
      defaultGameMode: configData.Defaults?.GameMode || 'Adventure',
    };

    res.json(quickSettings);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load quick settings',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/quick-settings - Save quick settings to config.json
router.put('/quick-settings', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate save
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Quick settings saved (simulated)' });
    return;
  }

  try {
    const { serverName, motd, password, maxPlayers, maxViewRadius, defaultGameMode } = req.body;

    const configPath = path.join(config.serverPath, 'config.json');
    const content = await readFile(configPath, 'utf-8');
    const configData = JSON.parse(content);

    // Update only the quick settings fields
    if (serverName !== undefined) configData.ServerName = serverName;
    if (motd !== undefined) configData.MOTD = motd;
    if (password !== undefined) configData.Password = password;
    if (maxPlayers !== undefined) configData.MaxPlayers = Number(maxPlayers);
    if (maxViewRadius !== undefined) configData.MaxViewRadius = Number(maxViewRadius);
    if (defaultGameMode !== undefined) {
      if (!configData.Defaults) configData.Defaults = {};
      configData.Defaults.GameMode = defaultGameMode;
    }

    await writeFile(configPath, JSON.stringify(configData, null, 2), 'utf-8');
    res.json({ success: true, message: 'Quick settings saved' });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save quick settings',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/start
router.post('/start', authMiddleware, requirePermission('server.start'), async (_req: Request, res: Response) => {
  const result = await dockerService.startContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// POST /api/server/stop
router.post('/stop', authMiddleware, requirePermission('server.stop'), async (_req: Request, res: Response) => {
  const result = await dockerService.stopContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// POST /api/server/restart
router.post('/restart', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  const result = await dockerService.restartContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// Panel config file path (for patchline setting)
const PANEL_CONFIG_PATH = '/opt/hytale/data/panel-config.json';

// Panel config interface
interface PanelConfig {
  patchline: string;
  acceptEarlyPlugins: boolean;
  disableSentry: boolean;
  allowOp: boolean;
}

// Helper to read panel config
async function readPanelConfig(): Promise<PanelConfig> {
  try {
    const content = await readFile(PANEL_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content);
    // Ensure all fields have defaults
    return {
      patchline: config.patchline || process.env.HYTALE_PATCHLINE || 'release',
      acceptEarlyPlugins: config.acceptEarlyPlugins ?? false,
      disableSentry: config.disableSentry ?? false,
      allowOp: config.allowOp ?? false,
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
async function writePanelConfig(config: PanelConfig): Promise<void> {
  await writeFile(PANEL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// GET /api/server/patchline - Get current patchline setting
router.get('/patchline', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  // Demo mode: return demo patchline
  if (isDemoMode()) {
    const demoPatchline = getDemoPatchlineConfig();
    res.json({
      patchline: demoPatchline.patchline,
      options: ['release', 'pre-release'],
    });
    return;
  }

  try {
    const panelConfig = await readPanelConfig();
    res.json({
      patchline: panelConfig.patchline,
      options: ['release', 'pre-release']
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get patchline setting',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/patchline - Set patchline setting
router.put('/patchline', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate patchline change
  if (isDemoMode()) {
    const { patchline } = req.body;
    res.json({ success: true, patchline, changed: true, message: '[DEMO] Patchline changed (simulated)' });
    return;
  }

  try {
    const { patchline } = req.body;

    if (!patchline || !['release', 'pre-release'].includes(patchline)) {
      res.status(400).json({ error: 'Invalid patchline. Must be "release" or "pre-release"' });
      return;
    }

    const panelConfig = await readPanelConfig();
    const oldPatchline = panelConfig.patchline;
    const patchlineChanged = oldPatchline !== patchline;

    // Update config
    panelConfig.patchline = patchline;
    await writePanelConfig(panelConfig);

    // If patchline changed, delete server files to force redownload on restart
    if (patchlineChanged) {
      const serverJar = path.join(config.serverPath, 'HytaleServer.jar');
      const assetsZip = path.join(config.serverPath, 'Assets.zip');
      const versionFile = path.join(config.serverPath, '.hytale-version');

      // Delete via container exec to ensure proper permissions
      await dockerService.execInContainer(
        `rm -f "${serverJar}" "${assetsZip}" "${versionFile}" 2>/dev/null || true`
      );

      res.json({
        success: true,
        patchline,
        changed: true,
        message: `Patchline changed from ${oldPatchline} to ${patchline}. Server files deleted. Restart to download the new version.`
      });
    } else {
      res.json({
        success: true,
        patchline,
        changed: false,
        message: 'Patchline unchanged.'
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to set patchline',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/accept-early-plugins - Get current acceptEarlyPlugins setting
router.get('/accept-early-plugins', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  // Demo mode: return demo setting
  if (isDemoMode()) {
    res.json({ acceptEarlyPlugins: true });
    return;
  }

  try {
    const panelConfig = await readPanelConfig();
    res.json({
      acceptEarlyPlugins: panelConfig.acceptEarlyPlugins,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get accept early plugins setting',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/accept-early-plugins - Set acceptEarlyPlugins setting
router.put('/accept-early-plugins', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate setting change
  if (isDemoMode()) {
    const { acceptEarlyPlugins } = req.body;
    res.json({ success: true, acceptEarlyPlugins, changed: true, message: '[DEMO] Setting changed (simulated)' });
    return;
  }

  try {
    const { acceptEarlyPlugins } = req.body;

    if (typeof acceptEarlyPlugins !== 'boolean') {
      res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
      return;
    }

    const panelConfig = await readPanelConfig();
    const oldValue = panelConfig.acceptEarlyPlugins;
    const valueChanged = oldValue !== acceptEarlyPlugins;

    // Update config
    panelConfig.acceptEarlyPlugins = acceptEarlyPlugins;
    await writePanelConfig(panelConfig);

    res.json({
      success: true,
      acceptEarlyPlugins,
      changed: valueChanged,
      message: valueChanged
        ? `Accept early plugins ${acceptEarlyPlugins ? 'enabled' : 'disabled'}. Restart the server to apply changes.`
        : 'Setting unchanged.'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to set accept early plugins',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/disable-sentry - Get current disableSentry setting
router.get('/disable-sentry', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  // Demo mode: return demo setting
  if (isDemoMode()) {
    res.json({ disableSentry: false });
    return;
  }

  try {
    const panelConfig = await readPanelConfig();
    res.json({
      disableSentry: panelConfig.disableSentry,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get disable sentry setting',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/disable-sentry - Set disableSentry setting
router.put('/disable-sentry', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate setting change
  if (isDemoMode()) {
    const { disableSentry } = req.body;
    res.json({ success: true, disableSentry, changed: true, message: '[DEMO] Setting changed (simulated)' });
    return;
  }

  try {
    const { disableSentry } = req.body;

    if (typeof disableSentry !== 'boolean') {
      res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
      return;
    }

    const panelConfig = await readPanelConfig();
    const oldValue = panelConfig.disableSentry;
    const valueChanged = oldValue !== disableSentry;

    // Update config
    panelConfig.disableSentry = disableSentry;
    await writePanelConfig(panelConfig);

    res.json({
      success: true,
      disableSentry,
      changed: valueChanged,
      message: valueChanged
        ? `Sentry crash reporting ${disableSentry ? 'disabled' : 'enabled'}. Restart the server to apply changes.`
        : 'Setting unchanged.'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to set disable sentry',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/allow-op - Get current allowOp setting
router.get('/allow-op', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  // Demo mode: return demo setting
  if (isDemoMode()) {
    res.json({ allowOp: true });
    return;
  }

  try {
    const panelConfig = await readPanelConfig();
    res.json({
      allowOp: panelConfig.allowOp,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get allow op setting',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/allow-op - Set allowOp setting
router.put('/allow-op', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate setting change
  if (isDemoMode()) {
    const { allowOp } = req.body;
    res.json({ success: true, allowOp, changed: true, message: '[DEMO] Setting changed (simulated)' });
    return;
  }

  try {
    const { allowOp } = req.body;

    if (typeof allowOp !== 'boolean') {
      res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
      return;
    }

    const panelConfig = await readPanelConfig();
    const oldValue = panelConfig.allowOp;
    const valueChanged = oldValue !== allowOp;

    // Update config
    panelConfig.allowOp = allowOp;
    await writePanelConfig(panelConfig);

    res.json({
      success: true,
      allowOp,
      changed: valueChanged,
      message: valueChanged
        ? `OP commands ${allowOp ? 'enabled' : 'disabled'}. Restart the server to apply changes.`
        : 'Setting unchanged.'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to set allow op',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Helper to check if downloader credentials exist
async function checkDownloaderCredentials(): Promise<{ exists: boolean; error?: string }> {
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

// Helper to get latest version for a patchline
// SECURITY: Defense-in-depth validation - even though callers use hardcoded values
const VALID_PATCHLINES = ['release', 'pre-release'] as const;

interface VersionCheckResult {
  version: string;
  authRequired?: boolean;
  error?: string;
}

async function getLatestVersion(patchline: string): Promise<VersionCheckResult> {
  // SECURITY: Validate patchline to prevent command injection
  if (!VALID_PATCHLINES.includes(patchline as typeof VALID_PATCHLINES[number])) {
    console.error(`Invalid patchline attempted: ${patchline}`);
    return { version: 'unknown', error: 'Invalid patchline' };
  }

  // Run downloader and capture both stdout and stderr to detect auth issues
  const checkResult = await dockerService.execInContainer(
    `cd /opt/hytale/downloader && ./hytale-downloader-linux-amd64 -patchline ${patchline} -print-version 2>&1`
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

  // Extract version number from output
  const versionMatch = output.match(/[0-9]+\.[0-9]+\.[0-9]+/);
  if (versionMatch) {
    return { version: versionMatch[0] };
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

// GET /api/server/config/files - List config files
router.get('/config/files', authMiddleware, requirePermission('config.view'), async (_req: Request, res: Response) => {
  // Demo mode: return demo config files
  if (isDemoMode()) {
    const demoFiles = getDemoConfigFiles();
    res.json({
      files: demoFiles.map(f => ({
        name: f.name,
        size: f.size,
        modified: f.lastModified,
      })),
    });
    return;
  }

  try {
    const files = await readdir(config.serverPath);
    const configFiles = files.filter(f =>
      CONFIG_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext))
    );

    const fileInfos = await Promise.all(configFiles.map(async (filename) => {
      try {
        const filePath = path.join(config.serverPath, filename);
        const stats = await stat(filePath);
        return {
          name: filename,
          size: stats.size,
          modified: stats.mtime.toISOString(),
        };
      } catch {
        return { name: filename, size: 0, modified: null };
      }
    }));

    res.json({ files: fileInfos });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list config files',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/config/:filename - Read config file
router.get('/config/:filename', authMiddleware, requirePermission('config.view'), async (req: Request, res: Response) => {
  const { filename } = req.params;

  // Demo mode: return demo config content
  if (isDemoMode()) {
    res.json({ filename, content: getDemoServerConfig() });
    return;
  }

  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  // Check extension
  if (!CONFIG_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext))) {
    res.status(400).json({ error: 'File type not allowed' });
    return;
  }

  try {
    const filePath = path.join(config.serverPath, filename);
    const content = await readFile(filePath, 'utf-8');
    res.json({ filename, content });
  } catch (error) {
    res.status(404).json({
      error: 'File not found',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/server/config/:filename - Write config file
router.put('/config/:filename', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  const { filename } = req.params;
  const { content } = req.body;

  // Demo mode: simulate config save
  if (isDemoMode()) {
    res.json({ success: true, filename, message: '[DEMO] Config saved (simulated)' });
    return;
  }

  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  // Check extension
  if (!CONFIG_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext))) {
    res.status(400).json({ error: 'File type not allowed' });
    return;
  }

  if (typeof content !== 'string') {
    res.status(400).json({ error: 'Content must be a string' });
    return;
  }

  try {
    const filePath = path.join(config.serverPath, filename);
    await writeFile(filePath, content, 'utf-8');
    res.json({ success: true, message: 'Config saved' });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save config',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// =============================================
// KyuubiSoft API Plugin Routes
// =============================================

// GET /api/server/plugin/status - Get KyuubiSoft API plugin status
router.get('/plugin/status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const status = await kyuubiApiService.getPluginStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get plugin status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/update-check - Check if plugin update is available
router.get('/plugin/update-check', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  // Demo mode: return mock plugin update status
  if (isDemoMode()) {
    const pluginUpdate = getDemoPluginUpdateStatus();
    res.json(pluginUpdate);
    return;
  }

  try {
    const updateInfo = kyuubiApiService.isUpdateAvailable();
    res.json(updateInfo);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check for plugin updates',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/plugin/install - Install or update the KyuubiSoft API plugin
router.post('/plugin/install', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  // Demo mode: simulate plugin install
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Plugin installed (simulated)', version: '1.0.0' });
    return;
  }

  try {
    const result = await kyuubiApiService.installPlugin();
    if (!result.success) {
      res.status(500).json(result);
      return;
    }
    res.json({
      success: true,
      message: 'Plugin installed successfully. Restart the server to activate.',
      version: kyuubiApiService.PLUGIN_VERSION
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install plugin'
    });
  }
});

// DELETE /api/server/plugin/uninstall - Uninstall the KyuubiSoft API plugin
router.delete('/plugin/uninstall', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  // Demo mode: simulate plugin uninstall
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Plugin uninstalled (simulated)' });
    return;
  }

  try {
    const result = await kyuubiApiService.uninstallPlugin();
    if (!result.success) {
      res.status(500).json(result);
      return;
    }
    res.json({
      success: true,
      message: 'Plugin uninstalled successfully. Restart the server to complete removal.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to uninstall plugin'
    });
  }
});

// GET /api/server/plugin/players - Get players from plugin API (more accurate)
router.get('/plugin/players', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getPlayersFromPlugin();
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get players from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/info - Get server info from plugin API
router.get('/plugin/info', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getServerInfoFromPlugin();
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get server info from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/memory - Get memory stats from plugin API
router.get('/plugin/memory', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getMemoryFromPlugin();
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get memory stats from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/metrics - Get Prometheus metrics from plugin API
router.get('/plugin/metrics', authMiddleware, requirePermission('performance.view'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getPrometheusMetrics();
    if (!result.success) {
      res.status(503).json({ success: false, error: result.error });
      return;
    }

    // Parse Prometheus text format into structured data
    const raw = result.data || '';
    const parsed = parsePrometheusMetrics(raw);

    res.json({
      success: true,
      data: {
        raw,
        parsed
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get Prometheus metrics from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/tps - Get extended TPS metrics from plugin API
router.get('/plugin/tps', authMiddleware, requirePermission('performance.view'), async (_req: Request, res: Response) => {
  try {
    const result = await kyuubiApiService.getPrometheusMetrics();
    if (!result.success) {
      res.status(503).json({ success: false, error: result.error });
      return;
    }

    const raw = result.data || '';
    const tpsMetrics = parseTpsMetrics(raw);

    res.json({
      success: true,
      data: tpsMetrics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get TPS metrics from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Helper function to parse Prometheus text format
function parsePrometheusMetrics(raw: string): Record<string, unknown> {
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
function parseTpsMetrics(raw: string): Record<string, number> {
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

// GET /api/server/plugin/players/:name/details - Get player details from plugin API
router.get('/plugin/players/:name/details', authMiddleware, requirePermission('server.view_status'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const result = await kyuubiApiService.getPlayerDetailsFromPlugin(name);
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get player details from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/players/:name/inventory - Get player inventory from plugin API
router.get('/plugin/players/:name/inventory', authMiddleware, requirePermission('server.view_status'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const result = await kyuubiApiService.getPlayerInventoryFromPlugin(name);
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get player inventory from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/plugin/players/:name/appearance - Get player appearance from plugin API
router.get('/plugin/players/:name/appearance', authMiddleware, requirePermission('server.view_status'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const result = await kyuubiApiService.getPlayerAppearanceFromPlugin(name);
    if (!result.success) {
      res.status(503).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get player appearance from plugin',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ============================================================
// Player Data from Files (server/universe/players/)
// ============================================================

// GET /api/server/players/:name/file/details - Get player details from saved JSON file
router.get('/players/:name/file/details', authMiddleware, requirePermission('players.view'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const details = await getPlayerDetailsFromFile(name);
    if (!details) {
      res.status(404).json({
        success: false,
        error: 'Player not found or no saved data available'
      });
      return;
    }
    res.json({
      success: true,
      data: details
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to read player details',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/players/:name/file/inventory - Get player inventory from saved JSON file
router.get('/players/:name/file/inventory', authMiddleware, requirePermission('players.view'), async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const inventory = await getPlayerInventoryFromFile(name);
    if (!inventory) {
      res.status(404).json({
        success: false,
        error: 'Player not found or no saved inventory data available'
      });
      return;
    }
    res.json({
      success: true,
      data: inventory
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to read player inventory',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ============================================================
// Downloader Authentication Endpoints
// ============================================================

// GET /api/server/downloader/auth-status - Check downloader authentication status
router.get('/downloader/auth-status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
  // Demo mode: return demo downloader status
  if (isDemoMode()) {
    const demoStatus = getDemoDownloaderStatus();
    res.json({
      authenticated: demoStatus.authenticated,
      credentialsExist: true,
      authRequired: false,
      username: demoStatus.username,
      lastAuth: demoStatus.lastAuth,
    });
    return;
  }

  try {
    const credCheck = await checkDownloaderCredentials();

    // Try to get version as a test
    if (credCheck.exists) {
      const testResult = await getLatestVersion('release');
      res.json({
        authenticated: testResult.version !== 'unknown' && !testResult.authRequired,
        credentialsExist: true,
        authRequired: testResult.authRequired || false,
        error: testResult.authRequired ? 'Token expired or invalid' : undefined,
      });
    } else {
      res.json({
        authenticated: false,
        credentialsExist: false,
        authRequired: true,
        error: 'No credentials found',
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check downloader auth status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// In-memory state for downloader OAuth flow
let downloaderOAuthState: {
  active: boolean;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: Date;
} = { active: false };

// POST /api/server/downloader/initiate-auth - Start downloader OAuth flow
router.post('/downloader/initiate-auth', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    console.log('[Server] Initiating downloader OAuth flow...');

    // First, delete existing credentials to force re-authentication
    await dockerService.execInContainer(
      `rm -f /opt/hytale/downloader/.hytale-downloader-credentials.json 2>/dev/null || true`
    );

    // Run the downloader - it will start OAuth flow when credentials are missing
    // Use a timeout since it will wait for user input
    const authResult = await dockerService.execInContainer(
      `cd /opt/hytale/downloader && timeout 60 ./hytale-downloader-linux-amd64 2>&1 || true`
    );

    const output = authResult.output || '';
    console.log('[Server] Downloader auth output:', output.substring(0, 1000));

    // Parse OAuth URLs from output
    // The downloader outputs: "Visit: https://oauth.accounts.hytale.com/oauth2/device/verify"
    // And a user code like: "Enter code: fHmkjxFE" or the code might be in the URL
    const urlMatch = output.match(/(https:\/\/oauth\.accounts\.hytale\.com\/[^\s\n\]]+)/i);

    // Try multiple patterns for the user code
    let userCode: string | null = null;
    const codePatterns = [
      /(?:enter\s+code|user_code|code)[:\s=]+([A-Za-z0-9]{6,12})/i,
      /user_code=([A-Za-z0-9]{6,12})/i,
      /\[([A-Za-z0-9]{8})\]/,  // Code might be in brackets
    ];

    for (const pattern of codePatterns) {
      const match = output.match(pattern);
      if (match) {
        userCode = match[1].trim();
        break;
      }
    }

    if (!urlMatch) {
      // Check if already authenticated or if download started
      if (output.includes('Downloading') || output.includes('already') || output.includes('authenticated') || output.includes('success')) {
        return res.json({
          success: true,
          alreadyAuthenticated: true,
          message: 'Downloader is already authenticated',
        });
      }

      // Maybe the downloader isn't installed or there's another issue
      return res.status(400).json({
        success: false,
        error: 'Could not parse OAuth URL from downloader output. The downloader may need to be reinstalled.',
        output: output.substring(0, 800),
      });
    }

    let verificationUrl = urlMatch[1].trim();

    // Clean up URL - remove any trailing characters that might have been captured
    verificationUrl = verificationUrl.replace(/[\]\)\}\s]+$/, '');

    // If URL doesn't have user_code, add it
    if (userCode && !verificationUrl.includes('user_code=')) {
      verificationUrl += verificationUrl.includes('?') ? `&user_code=${userCode}` : `?user_code=${userCode}`;
    }

    // Store state
    downloaderOAuthState = {
      active: true,
      verificationUrl,
      userCode: userCode || undefined,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    };

    res.json({
      success: true,
      verificationUrl,
      userCode,
      expiresIn: 900, // 15 minutes
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to initiate downloader auth',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/downloader/auth-poll - Poll for auth completion
router.get('/downloader/auth-poll', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    if (!downloaderOAuthState.active) {
      return res.json({
        completed: false,
        error: 'No active auth flow',
      });
    }

    // Check if expired
    if (downloaderOAuthState.expiresAt && new Date() > downloaderOAuthState.expiresAt) {
      downloaderOAuthState = { active: false };
      return res.json({
        completed: false,
        expired: true,
        error: 'Auth flow expired',
      });
    }

    // Check if credentials now exist and work
    const credCheck = await checkDownloaderCredentials();
    if (credCheck.exists) {
      const testResult = await getLatestVersion('release');
      if (testResult.version !== 'unknown' && !testResult.authRequired) {
        downloaderOAuthState = { active: false };
        return res.json({
          completed: true,
          version: testResult.version,
        });
      }
    }

    res.json({
      completed: false,
      verificationUrl: downloaderOAuthState.verificationUrl,
      userCode: downloaderOAuthState.userCode,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to poll auth status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ============================================================
// Native Update System Endpoints (Hytale 24.01.2026+)
// ============================================================

// UpdateConfig interface
interface UpdateConfig {
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
function getDefaultUpdateConfig(): UpdateConfig {
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

// Native update status interface
interface NativeUpdateStatus {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  state: 'IDLE' | 'CHECKING' | 'DOWNLOADING' | 'READY' | 'APPLYING' | 'ERROR';
  progress?: number;
  message?: string;
  error?: string;
}

// Helper to parse /update status output
function parseUpdateStatusOutput(output: string): NativeUpdateStatus {
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
    const result = await dockerService.execCommand('/update apply');

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
    const result = await dockerService.execCommand('/update cancel');

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

// ============================================================
// New Features Banner Endpoints
// ============================================================

// GET /api/server/new-features - Get new features status
router.get('/new-features', authMiddleware, requirePermission('dashboard.view'), async (_req: Request, res: Response) => {
  // Demo mode: return demo new features
  if (isDemoMode()) {
    const demoFeatures = getDemoNewFeatures();
    res.json({
      hasNewFeatures: demoFeatures.features.length > 0 && !demoFeatures.dismissed,
      features: demoFeatures.features,
      dismissed: demoFeatures.dismissed,
      panelVersion: demoFeatures.version,
    });
    return;
  }

  try {
    const configPath = path.join(config.dataPath, 'config.json');

    try {
      await access(configPath, constants.R_OK);
      const mainConfig = JSON.parse(await readFile(configPath, 'utf-8'));

      res.json({
        hasNewFeatures: !!(mainConfig.newFeaturesAvailable && mainConfig.newFeaturesAvailable.length > 0),
        features: mainConfig.newFeaturesAvailable || [],
        dismissed: mainConfig.newFeaturesBannerDismissed || false,
        panelVersion: mainConfig.panelVersion || '2.0.0',
      });
    } catch {
      res.json({
        hasNewFeatures: false,
        features: [],
        dismissed: true,
        panelVersion: '2.0.0',
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get new features status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/new-features/dismiss - Dismiss new features banner
router.post('/new-features/dismiss', authMiddleware, requirePermission('dashboard.view'), async (_req: Request, res: Response) => {
  // Demo mode: simulate dismiss
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] New features banner dismissed (simulated)' });
    return;
  }

  try {
    const success = await dismissNewFeaturesBanner();

    if (success) {
      res.json({
        success: true,
        message: 'New features banner dismissed'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to dismiss banner'
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to dismiss banner',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
