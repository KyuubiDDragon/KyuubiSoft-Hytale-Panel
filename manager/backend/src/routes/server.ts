import { Router, Request, Response } from 'express';
import { readdir, readFile, writeFile, stat } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import * as dockerService from '../services/docker.js';
import * as kyuubiApiService from '../services/kyuubiApi.js';
import { getPlayerInventoryFromFile, getPlayerDetailsFromFile } from '../services/players.js';
import { config } from '../config.js';

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

// GET /api/server/status
router.get('/status', authMiddleware, async (_req: Request, res: Response) => {
  const status = await dockerService.getStatus();
  res.json(status);
});

// GET /api/server/stats
router.get('/stats', authMiddleware, async (_req: Request, res: Response) => {
  const stats = await dockerService.getStats();
  res.json(stats);
});

// GET /api/server/memory - Get detailed memory stats from server command
router.get('/memory', authMiddleware, async (_req: Request, res: Response) => {
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
router.get('/quick-settings', authMiddleware, async (_req: Request, res: Response) => {
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
router.put('/quick-settings', authMiddleware, async (req: Request, res: Response) => {
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
router.post('/start', authMiddleware, async (_req: Request, res: Response) => {
  const result = await dockerService.startContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// POST /api/server/stop
router.post('/stop', authMiddleware, async (_req: Request, res: Response) => {
  const result = await dockerService.stopContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// POST /api/server/restart
router.post('/restart', authMiddleware, async (_req: Request, res: Response) => {
  const result = await dockerService.restartContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// Panel config file path (for patchline setting)
const PANEL_CONFIG_PATH = '/opt/hytale/data/panel-config.json';

// Helper to read panel config
async function readPanelConfig(): Promise<{ patchline: string }> {
  try {
    const content = await readFile(PANEL_CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    // Return defaults if file doesn't exist
    return { patchline: process.env.HYTALE_PATCHLINE || 'release' };
  }
}

// Helper to write panel config
async function writePanelConfig(config: { patchline: string }): Promise<void> {
  await writeFile(PANEL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// GET /api/server/patchline - Get current patchline setting
router.get('/patchline', authMiddleware, async (_req: Request, res: Response) => {
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
router.put('/patchline', authMiddleware, async (req: Request, res: Response) => {
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

// Helper to get latest version for a patchline
async function getLatestVersion(patchline: string): Promise<string> {
  const checkResult = await dockerService.execInContainer(
    `cd /opt/hytale/downloader && ./hytale-downloader-linux-amd64 -patchline ${patchline} -print-version 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+" | head -1`
  );

  if (checkResult.success && checkResult.output) {
    return checkResult.output.trim();
  }
  return 'unknown';
}

// GET /api/server/check-update - Check if a Hytale server update is available
router.get('/check-update', authMiddleware, async (_req: Request, res: Response) => {
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
    const [releaseVersion, preReleaseVersion] = await Promise.all([
      getLatestVersion('release'),
      getLatestVersion('pre-release')
    ]);

    // Check if update is available for current patchline
    const latestVersion = currentPatchline === 'release' ? releaseVersion : preReleaseVersion;
    const updateAvailable = installedVersion !== 'unknown' &&
                           latestVersion !== 'unknown' &&
                           installedVersion !== latestVersion;

    res.json({
      installedVersion,
      latestVersion,
      updateAvailable,
      patchline: currentPatchline,
      // Include both patchline versions
      versions: {
        release: releaseVersion,
        preRelease: preReleaseVersion
      },
      message: updateAvailable
        ? `Update available: ${installedVersion} → ${latestVersion}`
        : installedVersion === latestVersion
          ? 'Server is up to date'
          : 'Could not determine update status'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check for updates',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/config/files - List config files
router.get('/config/files', authMiddleware, async (_req: Request, res: Response) => {
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
router.get('/config/:filename', authMiddleware, async (req: Request, res: Response) => {
  const { filename } = req.params;

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
router.put('/config/:filename', authMiddleware, async (req: Request, res: Response) => {
  const { filename } = req.params;
  const { content } = req.body;

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
router.get('/plugin/status', authMiddleware, async (_req: Request, res: Response) => {
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
router.get('/plugin/update-check', authMiddleware, async (_req: Request, res: Response) => {
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
router.post('/plugin/install', authMiddleware, async (_req: Request, res: Response) => {
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
router.delete('/plugin/uninstall', authMiddleware, async (_req: Request, res: Response) => {
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
router.get('/plugin/players', authMiddleware, async (_req: Request, res: Response) => {
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
router.get('/plugin/info', authMiddleware, async (_req: Request, res: Response) => {
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
router.get('/plugin/memory', authMiddleware, async (_req: Request, res: Response) => {
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

// GET /api/server/plugin/players/:name/details - Get player details from plugin API
router.get('/plugin/players/:name/details', authMiddleware, async (req: Request, res: Response) => {
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
router.get('/plugin/players/:name/inventory', authMiddleware, async (req: Request, res: Response) => {
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
router.get('/plugin/players/:name/appearance', authMiddleware, async (req: Request, res: Response) => {
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
router.get('/players/:name/file/details', authMiddleware, async (req: Request, res: Response) => {
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
router.get('/players/:name/file/inventory', authMiddleware, async (req: Request, res: Response) => {
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

export default router;
