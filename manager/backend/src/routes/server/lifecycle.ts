// Lifecycle + observability endpoints: status, stats, memory, start/stop/restart,
// and KyuubiSoft API plugin runtime data (status/install/uninstall + live data
// like players, info, memory, metrics, TPS, per-player details).
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as dockerService from '../../services/docker.js';
import * as kyuubiApiService from '../../services/kyuubiApi.js';
import { getPlayerInventoryFromFile, getPlayerDetailsFromFile } from '../../services/players.js';
import {
  isDemoMode,
  getDemoMemoryStats,
  getDemoPluginUpdateStatus,
} from '../../services/demoData.js';
import { parsePrometheusMetrics, parseTpsMetrics } from './shared.js';

const router = Router();

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

// POST /api/server/start
router.post('/start', authMiddleware, requirePermission('server.start'), async (_req: Request, res: Response) => {
  // Demo mode: simulate server start
  if (isDemoMode()) {
    res.json({
      success: true,
      message: '[Demo] Server started successfully',
    });
    return;
  }

  const result = await dockerService.startContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// POST /api/server/stop
router.post('/stop', authMiddleware, requirePermission('server.stop'), async (_req: Request, res: Response) => {
  // Demo mode: simulate server stop
  if (isDemoMode()) {
    res.json({
      success: true,
      message: '[Demo] Server stopped successfully',
    });
    return;
  }

  const result = await dockerService.stopContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// POST /api/server/restart
router.post('/restart', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  // Demo mode: simulate server restart
  if (isDemoMode()) {
    res.json({
      success: true,
      message: '[Demo] Server restarted successfully',
    });
    return;
  }

  const result = await dockerService.restartContainer();
  if (!result.success) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
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

export default router;
