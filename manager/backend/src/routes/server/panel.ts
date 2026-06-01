// Panel-meta endpoints: panel version check + new-features banner.
import { Router, Request, Response } from 'express';
import { readFile, access, constants } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import { dismissNewFeaturesBanner } from '../../services/migration.js';
import { checkPanelUpdate, getCurrentVersion } from '../../services/panelVersionService.js';
import { isDemoMode, getDemoNewFeatures } from '../../services/demoData.js';

const router = Router();

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

// GET /api/server/panel-version - Get current panel version and check for updates
router.get('/panel-version', authMiddleware, requirePermission('dashboard.view'), async (req: Request, res: Response) => {
  // Demo mode: return demo panel version info
  if (isDemoMode()) {
    const currentVersion = await getCurrentVersion();
    res.json({
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      releaseUrl: 'https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/releases',
      releaseNotes: '[DEMO] No release notes in demo mode',
      publishedAt: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
    });
    return;
  }

  try {
    // Check if force refresh is requested via query param
    const forceRefresh = req.query.refresh === 'true';
    const versionInfo = await checkPanelUpdate(forceRefresh);

    res.json(versionInfo);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check panel version',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
