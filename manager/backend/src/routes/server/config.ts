// Server config endpoints: quick-settings, panel toggles (patchline, accept-early-plugins,
// disable-sentry, allow-op), and arbitrary config file read/write.
import { Router, Request, Response } from 'express';
import { readdir, readFile, writeFile, stat } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as dockerService from '../../services/docker.js';
import { config } from '../../config.js';
import { escapeShellArg } from '../../utils/sanitize.js';
import {
  isDemoMode,
  getDemoQuickSettings,
  getDemoConfigFiles,
  getDemoServerConfig,
  getDemoPatchlineConfig,
} from '../../services/demoData.js';
import {
  CONFIG_EXTENSIONS,
  QuickSettings,
  readPanelConfig,
  writePanelConfig,
} from './shared.js';

const router = Router();

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

      // Delete via container exec to ensure proper permissions. Paths are
      // config-derived, but shell-escaped so the command stays injection-proof.
      await dockerService.execInContainer(
        `rm -f ${escapeShellArg(serverJar)} ${escapeShellArg(assetsZip)} ${escapeShellArg(versionFile)} 2>/dev/null || true`
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

// RAM like "3G" / "512M"; args allow only safe token characters (the start
// script word-splits them, never evals — but we still reject shell metachars).
const RAM_RE = /^\d{1,5}[MmGg]$/;
const SAFE_ARGS_RE = /^[A-Za-z0-9 _.:=+\-/@]*$/;

// GET /api/server/jvm - current JVM/startup tuning (RAM + extra args).
router.get('/jvm', authMiddleware, requirePermission('config.view'), async (_req: Request, res: Response) => {
  if (isDemoMode()) {
    res.json({ javaMinRam: '3G', javaMaxRam: '4G', extraJavaArgs: '', extraServerArgs: '', envDefaults: { javaMinRam: '3G', javaMaxRam: '4G' } });
    return;
  }
  try {
    const panelConfig = await readPanelConfig();
    res.json({
      // Effective values fall back to the container env defaults when unset.
      javaMinRam: panelConfig.javaMinRam ?? process.env.JAVA_MIN_RAM ?? '3G',
      javaMaxRam: panelConfig.javaMaxRam ?? process.env.JAVA_MAX_RAM ?? '4G',
      extraJavaArgs: panelConfig.extraJavaArgs ?? '',
      extraServerArgs: panelConfig.extraServerArgs ?? '',
      envDefaults: { javaMinRam: process.env.JAVA_MIN_RAM ?? '3G', javaMaxRam: process.env.JAVA_MAX_RAM ?? '4G' },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read JVM settings', message: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PUT /api/server/jvm - persist JVM/startup tuning to panel-config.json.
router.put('/jvm', authMiddleware, requirePermission('config.edit'), async (req: Request, res: Response) => {
  if (isDemoMode()) {
    res.json({ success: true, changed: true, message: '[DEMO] JVM settings changed (simulated)' });
    return;
  }
  try {
    const body = req.body ?? {};
    const minRam = String(body.javaMinRam ?? '').trim();
    const maxRam = String(body.javaMaxRam ?? '').trim();
    const extraJava = String(body.extraJavaArgs ?? '').trim();
    const extraServer = String(body.extraServerArgs ?? '').trim();

    if (!RAM_RE.test(minRam) || !RAM_RE.test(maxRam)) {
      res.status(400).json({ error: 'RAM must look like "3G" or "512M".' });
      return;
    }
    const toMb = (v: string) => (v.toUpperCase().endsWith('G') ? parseInt(v) * 1024 : parseInt(v));
    if (toMb(minRam) > toMb(maxRam)) {
      res.status(400).json({ error: 'Minimum RAM cannot exceed maximum RAM.' });
      return;
    }
    for (const [name, val] of [['extraJavaArgs', extraJava], ['extraServerArgs', extraServer]] as const) {
      if (val.length > 1024 || !SAFE_ARGS_RE.test(val)) {
        res.status(400).json({ error: `${name} contains invalid characters or is too long.` });
        return;
      }
    }

    const panelConfig = await readPanelConfig();
    const changed =
      panelConfig.javaMinRam !== minRam || panelConfig.javaMaxRam !== maxRam ||
      (panelConfig.extraJavaArgs ?? '') !== extraJava || (panelConfig.extraServerArgs ?? '') !== extraServer;
    panelConfig.javaMinRam = minRam;
    panelConfig.javaMaxRam = maxRam;
    panelConfig.extraJavaArgs = extraJava;
    panelConfig.extraServerArgs = extraServer;
    await writePanelConfig(panelConfig);

    res.json({
      success: true,
      changed,
      message: changed ? 'JVM settings saved. Restart the server to apply changes.' : 'Settings unchanged.',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save JVM settings', message: error instanceof Error ? error.message : 'Unknown error' });
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

export default router;
