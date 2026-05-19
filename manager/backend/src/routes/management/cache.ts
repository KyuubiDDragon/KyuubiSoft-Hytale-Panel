// External mod-source integrations (Mod Store / Modtale / StackMart / CurseForge /
// CFWidget tracked-mod updates). These endpoints all hit external APIs and rely
// on per-source caches that can be refreshed.
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { logActivity } from '../../services/activityLog.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { isDemoMode, getDemoModStore, getDemoModtaleResults, getDemoStackMartResults } from '../../services/demoData.js';

import {
  getAvailableMods,
  installMod,
  uninstallMod,
  updateMod,
  getLatestRelease,
  refreshRegistry,
  getRegistryInfo,
} from '../../services/modStore.js';
import {
  searchMods as modtaleSearch,
  getModDetails as modtaleGetDetails,
  installModFromModtale,
  uninstallModtale,
  checkModtaleStatus,
  getTags as modtaleGetTags,
  getClassifications as modtaleGetClassifications,
  getGameVersions as modtaleGetGameVersions,
  getFeaturedMods,
  getRecentMods,
  clearModtaleCache,
  isValidProjectId,
  isValidVersion,
  getInstalledModtaleInfo,
  type ModtaleSortOption,
  type ModtaleClassification,
} from '../../services/modtale.js';
import {
  searchResources as stackmartSearch,
  getResourceDetails as stackmartGetDetails,
  installResourceFromStackMart,
  uninstallStackMart,
  checkStackMartStatus,
  getCategories as stackmartGetCategories,
  getPopularResources,
  getRecentResources,
  clearStackMartCache,
  isValidResourceId,
  getInstalledStackMartInfo,
  type StackMartSortOption,
  type StackMartCategory,
} from '../../services/stackmart.js';
import {
  searchMods as curseforgeSearch,
  getModDetails as curseforgeGetDetails,
  getModFiles as curseforgeGetFiles,
  installModFromCurseForge,
  uninstallCurseForge,
  updateMod as curseforgeUpdateMod,
  checkCurseForgeStatus,
  getCategories as curseforgeGetCategories,
  getFeaturedMods as curseforgeFeatured,
  getRecentMods as curseforgeRecent,
  getPopularMods as curseforgePopular,
  checkForUpdates as curseforgeCheckUpdates,
  clearCurseForgeCache,
  isValidModId as isValidCurseForgeModId,
  getInstalledCurseForgeInfo,
  type CurseForgeSortField,
  type CurseForgeSortOrder,
} from '../../services/curseforge.js';
import {
  getModInfo as cfwidgetGetMod,
  extractSlugFromUrl,
  trackMod as cfwidgetTrackMod,
  untrackMod as cfwidgetUntrackMod,
  checkModUpdate as cfwidgetCheckMod,
  checkAllUpdates as cfwidgetCheckAll,
  getUpdateStatus as cfwidgetStatus,
  updateInstalledVersion as cfwidgetUpdateVersion,
  installTrackedMod as cfwidgetInstallMod,
  uninstallTrackedMod as cfwidgetUninstallMod,
  clearCFWidgetCache,
} from '../../services/cfwidget.js';

const router = Router();

// ============== MOD STORE ==============

// GET /api/management/modstore
router.get('/modstore', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return demo mod store
  if (isDemoMode()) {
    res.json({ mods: getDemoModStore() });
    return;
  }

  try {
    const mods = await getAvailableMods();
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get mod store' });
  }
});

// GET /api/management/modstore/:modId/release
router.get('/modstore/:modId/release', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { modId } = req.params;
    const mods = await getAvailableMods();
    const mod = mods.find((m) => m.id === modId);

    if (!mod) {
      res.status(404).json({ error: 'Mod not found' });
      return;
    }

    // Check if mod has GitHub source
    if (!mod.github) {
      // For direct download mods, return version from registry
      res.json({
        version: mod.version || 'unknown',
        name: mod.name,
        publishedAt: null,
        assets: [],
        source: 'direct',
      });
      return;
    }

    const release = await getLatestRelease(mod.github);
    if (!release) {
      res.status(500).json({ error: 'Failed to fetch release info' });
      return;
    }

    res.json({
      version: release.tag_name,
      name: release.name,
      publishedAt: release.published_at,
      assets: release.assets.map((a) => ({
        name: a.name,
        size: a.size,
      })),
      source: 'github',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get release info' });
  }
});

// POST /api/management/modstore/:modId/install
router.post('/modstore/:modId/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    const { modId } = req.params;
    res.json({ success: true, filename: `${modId}.jar`, version: '1.0.0', message: '[DEMO] Mod installed (simulated)' });
    return;
  }

  try {
    const { modId } = req.params;
    const result = await installMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'install_mod',
        'mod',
        true,
        result.filename,
        `Installed ${modId} v${result.version} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to install mod' });
  }
});

// DELETE /api/management/modstore/:modId/uninstall
router.delete('/modstore/:modId/uninstall', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    const { modId } = req.params;
    res.json({ success: true, modId, message: '[DEMO] Mod uninstalled (simulated)' });
    return;
  }

  try {
    const { modId } = req.params;
    const result = await uninstallMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'uninstall_mod',
        'mod',
        true,
        modId,
        `Uninstalled ${modId} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

// POST /api/management/modstore/:modId/update
router.post('/modstore/:modId/update', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate update
  if (isDemoMode()) {
    const { modId } = req.params;
    res.json({ success: true, filename: `${modId}.jar`, version: '1.1.0', message: '[DEMO] Mod updated (simulated)' });
    return;
  }

  try {
    const { modId } = req.params;
    const result = await updateMod(modId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'update_mod',
        'mod',
        true,
        result.filename,
        `Updated ${modId} to ${result.version} from Mod Store`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update mod' });
  }
});

// POST /api/management/modstore/refresh - Refresh the external mod registry
router.post('/modstore/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    refreshRegistry();
    const mods = await getAvailableMods();
    res.json({ success: true, modCount: mods.length, registry: getRegistryInfo() });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to refresh registry' });
  }
});

// GET /api/management/modstore/info - Get registry info
router.get('/modstore/info', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    res.json(getRegistryInfo());
  } catch (error) {
    res.status(500).json({ error: 'Failed to get registry info' });
  }
});

// ============== MODTALE INTEGRATION ==============

// GET /api/management/modtale/status - Check Modtale API status
router.get('/modtale/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return online status
  if (isDemoMode()) {
    res.json({ available: true, latency: 120, demo: true });
    return;
  }

  try {
    const status = await checkModtaleStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check Modtale status' });
  }
});

// GET /api/management/modtale/search - Search mods on Modtale
router.get('/modtale/search', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return demo results
  if (isDemoMode()) {
    res.json(getDemoModtaleResults());
    return;
  }

  try {
    const {
      search,
      page,
      size,
      sort,
      classification,
      tags,
      gameVersion,
      author,
    } = req.query;

    const result = await modtaleSearch({
      search: search as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      size: size ? parseInt(size as string, 10) : undefined,
      sort: sort as ModtaleSortOption | undefined,
      classification: classification as ModtaleClassification | undefined,
      tags: tags ? (tags as string).split(',') : undefined,
      gameVersion: gameVersion as string | undefined,
      author: author as string | undefined,
    });

    if (!result) {
      res.status(503).json({ error: 'Modtale API unavailable' });
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to search Modtale' });
  }
});

// GET /api/management/modtale/projects/:projectId - Get project details
router.get('/modtale/projects/:projectId', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    // Security: Validate projectId format
    if (!isValidProjectId(projectId)) {
      res.status(400).json({ error: 'Invalid project ID format' });
      return;
    }

    const project = await modtaleGetDetails(projectId);

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json(project);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get project details' });
  }
});

// POST /api/management/modtale/install - Install mod from Modtale
router.post('/modtale/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    const { projectId } = req.body;
    res.json({ success: true, projectId, filename: `${projectId}.jar`, message: '[DEMO] Mod installed from Modtale (simulated)' });
    return;
  }

  try {
    const { projectId, versionId } = req.body;

    if (!projectId) {
      res.status(400).json({ error: 'projectId required' });
      return;
    }

    // Security: Validate projectId format
    if (!isValidProjectId(projectId)) {
      res.status(400).json({ error: 'Invalid project ID format' });
      return;
    }

    // Security: Validate versionId format if provided
    if (versionId && !isValidVersion(versionId)) {
      res.status(400).json({ error: 'Invalid version ID format' });
      return;
    }

    const result = await installModFromModtale(projectId, versionId);

    if (result.success) {
      await logActivity(
        req.user || 'unknown',
        'install_mod',
        'mod',
        true,
        result.filename,
        `Installed ${result.projectTitle} v${result.version} from Modtale`
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to install mod from Modtale' });
  }
});

// GET /api/management/modtale/featured - Get featured/popular mods
router.get('/modtale/featured', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const mods = await getFeaturedMods(limit);
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get featured mods' });
  }
});

// GET /api/management/modtale/recent - Get recently updated mods
router.get('/modtale/recent', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const mods = await getRecentMods(limit);
    res.json({ mods });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get recent mods' });
  }
});

// GET /api/management/modtale/tags - Get available tags
router.get('/modtale/tags', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const tags = await modtaleGetTags();
    res.json({ tags });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tags' });
  }
});

// GET /api/management/modtale/classifications - Get available classifications
router.get('/modtale/classifications', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const classifications = await modtaleGetClassifications();
    res.json({ classifications });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get classifications' });
  }
});

// GET /api/management/modtale/game-versions - Get supported game versions
router.get('/modtale/game-versions', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const gameVersions = await modtaleGetGameVersions();
    res.json({ gameVersions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get game versions' });
  }
});

// POST /api/management/modtale/refresh - Clear Modtale cache
router.post('/modtale/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    clearModtaleCache();
    res.json({ success: true, message: 'Modtale cache cleared' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to refresh cache' });
  }
});

// GET /api/management/modtale/installed - Get installed Modtale mods
router.get('/modtale/installed', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const installed = await getInstalledModtaleInfo();
    res.json({ installed });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get installed mods' });
  }
});

// DELETE /api/management/modtale/uninstall/:projectId - Uninstall a Modtale mod
router.delete('/modtale/uninstall/:projectId', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    const { projectId } = req.params;
    res.json({ success: true, projectId, message: '[DEMO] Modtale mod uninstalled (simulated)' });
    return;
  }

  try {
    const { projectId } = req.params;

    if (!projectId || !isValidProjectId(projectId)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    const result = await uninstallModtale(projectId);

    if (result.success) {
      // Log the uninstall activity
      await logActivity(
        req.user || 'Admin',
        'uninstall_modtale',
        'mod',
        true,
        projectId,
        `Uninstalled Modtale mod: ${projectId}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('Modtale uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

// ============== STACKMART INTEGRATION ==============

// GET /api/management/stackmart/status - Check StackMart API status
router.get('/stackmart/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return online status
  if (isDemoMode()) {
    res.json({ available: true, latency: 95, demo: true });
    return;
  }

  try {
    const status = await checkStackMartStatus();
    res.json(status);
  } catch {
    res.status(500).json({ error: 'Failed to check StackMart status' });
  }
});

// GET /api/management/stackmart/search - Search resources on StackMart
router.get('/stackmart/search', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return demo results
  if (isDemoMode()) {
    res.json(getDemoStackMartResults());
    return;
  }

  try {
    const {
      search,
      page = '1',
      limit = '20',
      sort = 'popular',
      category,
      subcategory,
    } = req.query;

    const result = await stackmartSearch({
      search: search as string | undefined,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      sort: sort as StackMartSortOption | undefined,
      category: category as StackMartCategory | undefined,
      subcategory: subcategory as string | undefined,
    });

    if (!result) {
      res.status(503).json({ error: 'StackMart API unavailable' });
      return;
    }

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to search StackMart' });
  }
});

// GET /api/management/stackmart/resources/:resourceId - Get resource details
router.get('/stackmart/resources/:resourceId', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { resourceId } = req.params;

    if (!isValidResourceId(resourceId)) {
      res.status(400).json({ error: 'Invalid resource ID format' });
      return;
    }

    const result = await stackmartGetDetails(resourceId);
    if (!result) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to get resource details' });
  }
});

// POST /api/management/stackmart/install - Install resource from StackMart
router.post('/stackmart/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    const { resourceId } = req.body;
    res.json({ success: true, resourceId, resourceName: 'Demo Resource', version: '1.0.0', message: '[DEMO] Resource installed from StackMart (simulated)' });
    return;
  }

  try {
    const { resourceId } = req.body;

    if (!resourceId || !isValidResourceId(resourceId)) {
      res.status(400).json({ success: false, error: 'Invalid resource ID' });
      return;
    }

    const result = await installResourceFromStackMart(resourceId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'install_stackmart',
        'mod',
        true,
        result.resourceName || resourceId,
        `Installed ${result.resourceName} v${result.version} from StackMart`
      );
    }

    res.json(result);
  } catch {
    res.status(500).json({ success: false, error: 'Failed to install resource from StackMart' });
  }
});

// GET /api/management/stackmart/popular - Get popular resources
router.get('/stackmart/popular', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const resources = await getPopularResources(limit);
    res.json({ resources });
  } catch {
    res.status(500).json({ error: 'Failed to get popular resources' });
  }
});

// GET /api/management/stackmart/recent - Get recent resources
router.get('/stackmart/recent', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const resources = await getRecentResources(limit);
    res.json({ resources });
  } catch {
    res.status(500).json({ error: 'Failed to get recent resources' });
  }
});

// GET /api/management/stackmart/categories - Get available categories
router.get('/stackmart/categories', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const categories = await stackmartGetCategories();
    res.json({ categories });
  } catch {
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

// POST /api/management/stackmart/refresh - Clear StackMart cache
router.post('/stackmart/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  try {
    clearStackMartCache();
    res.json({ success: true, message: 'StackMart cache cleared' });
  } catch {
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// GET /api/management/stackmart/installed - Get installed StackMart resources
router.get('/stackmart/installed', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  try {
    const installed = await getInstalledStackMartInfo();
    res.json({ installed });
  } catch {
    res.status(500).json({ error: 'Failed to get installed resources' });
  }
});

// DELETE /api/management/stackmart/uninstall/:resourceId - Uninstall a StackMart resource
router.delete('/stackmart/uninstall/:resourceId', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    const { resourceId } = req.params;
    res.json({ success: true, resourceId, message: '[DEMO] StackMart resource uninstalled (simulated)' });
    return;
  }

  try {
    const { resourceId } = req.params;

    if (!isValidResourceId(resourceId)) {
      res.status(400).json({ success: false, error: 'Invalid resource ID format' });
      return;
    }

    const result = await uninstallStackMart(resourceId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'uninstall_stackmart',
        'mod',
        true,
        resourceId,
        `Uninstalled StackMart resource: ${resourceId}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('StackMart uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall resource' });
  }
});

// ============================================
// CurseForge Integration Endpoints
// ============================================

// GET /api/management/curseforge/status - Check CurseForge API status
router.get('/curseforge/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return simulated status
  if (isDemoMode()) {
    res.json({
      configured: true,
      hasApiKey: true,
      apiAvailable: true,
      gameId: 432,
      demo: true,
    });
    return;
  }

  const status = await checkCurseForgeStatus();
  res.json(status);
});

// GET /api/management/curseforge/search - Search mods on CurseForge
router.get('/curseforge/search', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock search results
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 238222,
          name: 'JEI (Just Enough Items)',
          slug: 'jei',
          summary: 'View items and recipes',
          downloadCount: 150000000,
          authors: [{ id: 1, name: 'mezz', url: '' }],
          logo: { thumbnailUrl: 'https://via.placeholder.com/64' },
          dateModified: new Date().toISOString(),
          latestFiles: [],
        },
      ],
      pagination: { index: 0, pageSize: 20, resultCount: 1, totalCount: 1 },
      demo: true,
    });
    return;
  }

  try {
    const {
      search,
      gameId,
      classId,
      categoryId,
      gameVersion,
      sortField = 'Popularity',
      sortOrder = 'desc',
      pageSize = '20',
      index = '0',
    } = req.query;

    const result = await curseforgeSearch({
      search: search as string | undefined,
      gameId: gameId ? parseInt(gameId as string, 10) : undefined,
      classId: classId ? parseInt(classId as string, 10) : undefined,
      categoryId: categoryId ? parseInt(categoryId as string, 10) : undefined,
      gameVersion: gameVersion as string | undefined,
      sortField: sortField as CurseForgeSortField,
      sortOrder: sortOrder as CurseForgeSortOrder,
      pageSize: parseInt(pageSize as string, 10),
      index: parseInt(index as string, 10),
    });

    if (result) {
      res.json(result);
    } else {
      res.status(503).json({ error: 'CurseForge API unavailable' });
    }
  } catch (error) {
    console.error('CurseForge search error:', error);
    res.status(500).json({ error: 'Failed to search CurseForge' });
  }
});

// GET /api/management/curseforge/mods/:modId - Get mod details
router.get('/curseforge/mods/:modId', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock mod details
  if (isDemoMode()) {
    res.json({
      id: parseInt(req.params.modId, 10),
      name: 'Demo Mod',
      slug: 'demo-mod',
      summary: 'A demo mod for testing',
      downloadCount: 10000,
      authors: [{ id: 1, name: 'DemoAuthor', url: '' }],
      latestFiles: [
        {
          id: 1234567,
          displayName: 'demo-mod-1.0.0.jar',
          fileName: 'demo-mod-1.0.0.jar',
          releaseType: 1,
          gameVersions: ['1.20.1'],
          downloadUrl: null,
        },
      ],
      demo: true,
    });
    return;
  }

  try {
    const modId = parseInt(req.params.modId, 10);

    if (!isValidCurseForgeModId(modId)) {
      res.status(400).json({ error: 'Invalid mod ID format' });
      return;
    }

    const mod = await curseforgeGetDetails(modId);

    if (mod) {
      res.json(mod);
    } else {
      res.status(404).json({ error: 'Mod not found' });
    }
  } catch (error) {
    console.error('CurseForge mod details error:', error);
    res.status(500).json({ error: 'Failed to get mod details' });
  }
});

// GET /api/management/curseforge/mods/:modId/files - Get mod files
router.get('/curseforge/mods/:modId/files', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock files
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 1234567,
          displayName: 'demo-mod-1.0.0.jar',
          fileName: 'demo-mod-1.0.0.jar',
          releaseType: 1,
          gameVersions: ['1.20.1'],
          fileDate: new Date().toISOString(),
          downloadCount: 5000,
          downloadUrl: null,
        },
      ],
      demo: true,
    });
    return;
  }

  try {
    const modId = parseInt(req.params.modId, 10);
    const { gameVersion, pageSize = '50', index = '0' } = req.query;

    if (!isValidCurseForgeModId(modId)) {
      res.status(400).json({ error: 'Invalid mod ID format' });
      return;
    }

    const files = await curseforgeGetFiles(modId, {
      gameVersion: gameVersion as string | undefined,
      pageSize: parseInt(pageSize as string, 10),
      index: parseInt(index as string, 10),
    });

    if (files) {
      res.json({ data: files });
    } else {
      res.status(404).json({ error: 'Files not found' });
    }
  } catch (error) {
    console.error('CurseForge files error:', error);
    res.status(500).json({ error: 'Failed to get mod files' });
  }
});

// POST /api/management/curseforge/install - Install mod from CurseForge
router.post('/curseforge/install', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    const { modId, fileId } = req.body;
    res.json({
      success: true,
      modId,
      fileId,
      filename: 'demo-mod-1.0.0.jar',
      version: 'demo-mod-1.0.0',
      modName: 'Demo Mod',
      message: '[DEMO] CurseForge mod installed (simulated)',
    });
    return;
  }

  try {
    const { modId, fileId } = req.body;

    if (!modId || !isValidCurseForgeModId(modId)) {
      res.status(400).json({ success: false, error: 'Invalid mod ID' });
      return;
    }

    const result = await installModFromCurseForge(modId, fileId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'install_curseforge',
        'mod',
        true,
        result.modName || modId.toString(),
        `Installed ${result.modName} (${result.version}) from CurseForge`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CurseForge install error:', error);
    res.status(500).json({ success: false, error: 'Failed to install mod' });
  }
});

// POST /api/management/curseforge/update - Update mod to latest version
router.post('/curseforge/update', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate update
  if (isDemoMode()) {
    const { modId, fileId } = req.body;
    res.json({
      success: true,
      modId,
      fileId,
      filename: 'demo-mod-1.1.0.jar',
      version: 'demo-mod-1.1.0',
      modName: 'Demo Mod',
      message: '[DEMO] CurseForge mod updated (simulated)',
    });
    return;
  }

  try {
    const { modId, fileId } = req.body;

    if (!modId || !isValidCurseForgeModId(modId)) {
      res.status(400).json({ success: false, error: 'Invalid mod ID' });
      return;
    }

    const result = await curseforgeUpdateMod(modId, fileId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'update_curseforge',
        'mod',
        true,
        result.modName || modId.toString(),
        `Updated ${result.modName} to ${result.version} from CurseForge`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CurseForge update error:', error);
    res.status(500).json({ success: false, error: 'Failed to update mod' });
  }
});

// GET /api/management/curseforge/updates - Check for updates for installed mods
router.get('/curseforge/updates', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock updates
  if (isDemoMode()) {
    res.json({
      updates: [
        {
          modId: 238222,
          modName: 'JEI (Just Enough Items)',
          currentFileId: 1234566,
          currentVersion: 'jei-1.20.1-15.2.0.26',
          latestFileId: 1234567,
          latestVersion: 'jei-1.20.1-15.2.0.27',
          releaseType: 1,
          hasUpdate: true,
        },
      ],
      demo: true,
    });
    return;
  }

  try {
    const updates = await curseforgeCheckUpdates();
    res.json({ updates });
  } catch (error) {
    console.error('CurseForge updates check error:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// GET /api/management/curseforge/featured - Get featured mods
router.get('/curseforge/featured', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock featured mods
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 238222,
          name: 'JEI (Just Enough Items)',
          summary: 'View items and recipes',
          downloadCount: 150000000,
        },
      ],
      demo: true,
    });
    return;
  }

  const limit = parseInt(req.query.limit as string, 10) || 10;
  const mods = await curseforgeFeatured(limit);
  res.json({ data: mods });
});

// GET /api/management/curseforge/recent - Get recently updated mods
router.get('/curseforge/recent', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock recent mods
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 238223,
          name: 'Recent Mod',
          summary: 'A recently updated mod',
          downloadCount: 5000000,
        },
      ],
      demo: true,
    });
    return;
  }

  const limit = parseInt(req.query.limit as string, 10) || 10;
  const mods = await curseforgeRecent(limit);
  res.json({ data: mods });
});

// GET /api/management/curseforge/popular - Get popular mods
router.get('/curseforge/popular', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock popular mods
  if (isDemoMode()) {
    res.json({
      data: [
        {
          id: 238224,
          name: 'Popular Mod',
          summary: 'A very popular mod',
          downloadCount: 200000000,
        },
      ],
      demo: true,
    });
    return;
  }

  const limit = parseInt(req.query.limit as string, 10) || 10;
  const mods = await curseforgePopular(limit);
  res.json({ data: mods });
});

// GET /api/management/curseforge/categories - Get available categories
router.get('/curseforge/categories', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock categories
  if (isDemoMode()) {
    res.json({
      data: [
        { id: 6, name: 'Mods', slug: 'mc-mods' },
        { id: 12, name: 'Resource Packs', slug: 'texture-packs' },
        { id: 17, name: 'Modpacks', slug: 'modpacks' },
      ],
      demo: true,
    });
    return;
  }

  const gameId = req.query.gameId ? parseInt(req.query.gameId as string, 10) : undefined;
  const categories = await curseforgeGetCategories(gameId);
  res.json({ data: categories || [] });
});

// POST /api/management/curseforge/refresh - Clear CurseForge cache
router.post('/curseforge/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  clearCurseForgeCache();
  res.json({ success: true, message: 'CurseForge cache cleared' });
});

// GET /api/management/curseforge/installed - Get installed CurseForge mods
router.get('/curseforge/installed', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock installed mods
  if (isDemoMode()) {
    res.json({
      mods: {
        '238222': {
          modId: 238222,
          modName: 'JEI (Just Enough Items)',
          fileId: 1234566,
          version: 'jei-1.20.1-15.2.0.26',
          filename: 'jei-1.20.1-15.2.0.26.jar',
          installedAt: new Date().toISOString(),
          releaseType: 1,
          gameVersions: ['1.20.1'],
        },
      },
      demo: true,
    });
    return;
  }

  const mods = await getInstalledCurseForgeInfo();
  res.json({ mods });
});

// DELETE /api/management/curseforge/uninstall/:modId - Uninstall a CurseForge mod
router.delete('/curseforge/uninstall/:modId', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    const { modId } = req.params;
    res.json({ success: true, modId, message: '[DEMO] CurseForge mod uninstalled (simulated)' });
    return;
  }

  try {
    const modId = parseInt(req.params.modId, 10);

    if (!isValidCurseForgeModId(modId)) {
      res.status(400).json({ success: false, error: 'Invalid mod ID format' });
      return;
    }

    const result = await uninstallCurseForge(modId);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'uninstall_curseforge',
        'mod',
        true,
        modId.toString(),
        `Uninstalled CurseForge mod: ${modId}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CurseForge uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

// ============================================
// CFWidget Integration Endpoints (Free API - No Key Required)
// Used for mod update checking via CurseForge slugs
// ============================================

// GET /api/management/modupdates/status - Get current update status (cached)
router.get('/modupdates/status', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock status
  if (isDemoMode()) {
    res.json({
      totalTracked: 3,
      updatesAvailable: 1,
      lastChecked: new Date().toISOString(),
      mods: [
        {
          filename: 'KyuubiSoftAchievements-1.0.0.jar',
          curseforgeSlug: 'kyuubisoft-achievements-titles-rewards',
          installedVersion: '1.0.0',
          latestVersion: 'KyuubiSoft Achievements 1.0.1',
          hasUpdate: true,
          lastChecked: new Date().toISOString(),
          projectTitle: 'KyuubiSoft Achievements',
        },
      ],
      demo: true,
    });
    return;
  }

  try {
    // CFWidget status - for manually tracked mods via CurseForge slug
    const status = await cfwidgetStatus();
    res.json(status);
  } catch (error) {
    console.error('Mod updates status error:', error);
    res.status(500).json({ error: 'Failed to get update status' });
  }
});

// POST /api/management/modupdates/check - Check all mods for updates (runs full check)
router.post('/modupdates/check', authMiddleware, requirePermission('mods.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock check result
  if (isDemoMode()) {
    res.json({
      totalTracked: 3,
      updatesAvailable: 1,
      lastChecked: new Date().toISOString(),
      mods: [],
      demo: true,
    });
    return;
  }

  try {
    const status = await cfwidgetCheckAll();
    res.json(status);
  } catch (error) {
    console.error('Mod updates check error:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// POST /api/management/modupdates/track - Track a mod for updates
router.post('/modupdates/track', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate tracking
  if (isDemoMode()) {
    const { filename } = req.body;
    res.json({
      success: true,
      mod: {
        filename,
        curseforgeSlug: 'demo-mod',
        hasUpdate: false,
        lastChecked: new Date().toISOString(),
      },
      message: '[DEMO] Mod tracking added (simulated)',
    });
    return;
  }

  try {
    const { filename, curseforgeInput, currentVersion } = req.body;

    // Only curseforgeInput is required - filename can be empty for wishlist items
    if (!curseforgeInput) {
      res.status(400).json({ success: false, error: 'Missing curseforgeInput' });
      return;
    }

    const result = await cfwidgetTrackMod(filename || '', curseforgeInput, currentVersion);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'track_mod_updates',
        'mod',
        true,
        filename,
        `Started tracking updates for ${filename}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('Track mod error:', error);
    res.status(500).json({ success: false, error: 'Failed to track mod' });
  }
});

// DELETE /api/management/modupdates/track/:filename - Stop tracking a mod
router.delete('/modupdates/track/:filename', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate untracking
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Mod tracking removed (simulated)' });
    return;
  }

  try {
    const { filename } = req.params;
    const success = await cfwidgetUntrackMod(decodeURIComponent(filename));

    if (success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'untrack_mod_updates',
        'mod',
        true,
        filename,
        `Stopped tracking updates for ${filename}`
      );
    }

    res.json({ success });
  } catch (error) {
    console.error('Untrack mod error:', error);
    res.status(500).json({ success: false, error: 'Failed to untrack mod' });
  }
});

// GET /api/management/modupdates/check/:filename - Check single mod for update
router.get('/modupdates/check/:filename', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock result
  if (isDemoMode()) {
    res.json({
      filename: req.params.filename,
      hasUpdate: false,
      lastChecked: new Date().toISOString(),
      demo: true,
    });
    return;
  }

  try {
    const { filename } = req.params;
    const mod = await cfwidgetCheckMod(decodeURIComponent(filename));

    if (mod) {
      res.json(mod);
    } else {
      res.status(404).json({ error: 'Mod not tracked' });
    }
  } catch (error) {
    console.error('Check mod update error:', error);
    res.status(500).json({ error: 'Failed to check mod update' });
  }
});

// GET /api/management/modupdates/lookup - Lookup mod info by CurseForge URL/slug
router.get('/modupdates/lookup', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  // Demo mode: return mock lookup
  if (isDemoMode()) {
    res.json({
      id: 1445274,
      title: 'Demo Mod',
      summary: 'A demo mod for testing',
      thumbnail: 'https://via.placeholder.com/64',
      download: {
        name: 'demo-mod-1.0.0.jar',
        display: 'Demo Mod 1.0.0',
      },
      demo: true,
    });
    return;
  }

  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    const slug = extractSlugFromUrl(url);

    if (!slug) {
      res.status(400).json({ error: 'Invalid CurseForge URL or slug' });
      return;
    }

    const modInfo = await cfwidgetGetMod(slug);

    if (modInfo) {
      res.json(modInfo);
    } else {
      res.status(404).json({ error: 'Mod not found' });
    }
  } catch (error) {
    console.error('Lookup mod error:', error);
    res.status(500).json({ error: 'Failed to lookup mod' });
  }
});

// POST /api/management/modupdates/refresh - Clear CFWidget cache
router.post('/modupdates/refresh', authMiddleware, requirePermission('mods.install'), async (_req: Request, res: Response) => {
  clearCFWidgetCache();
  res.json({ success: true, message: 'CFWidget cache cleared' });
});

// PUT /api/management/modupdates/version/:filename - Update installed version for a tracked mod
router.put('/modupdates/version/:filename', authMiddleware, requirePermission('mods.install'), async (req: Request, res: Response) => {
  // Demo mode: simulate version update
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Version updated (simulated)' });
    return;
  }

  try {
    const { filename } = req.params;
    const { version, fileId } = req.body;

    if (!version) {
      res.status(400).json({ success: false, error: 'Missing version' });
      return;
    }

    const success = await cfwidgetUpdateVersion(decodeURIComponent(filename), version, fileId);
    res.json({ success });
  } catch (error) {
    console.error('Update version error:', error);
    res.status(500).json({ success: false, error: 'Failed to update version' });
  }
});

// POST /api/management/modupdates/install/:filename - Install or update a tracked mod
router.post('/modupdates/install/:filename', authMiddleware, requirePermission('mods.install'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate install
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Mod installed (simulated)', filename: 'demo-mod.jar' });
    return;
  }

  try {
    const { filename } = req.params;
    const decodedFilename = decodeURIComponent(filename);

    const result = await cfwidgetInstallMod(decodedFilename);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'install_mod_cfwidget',
        'mod',
        true,
        result.filename || decodedFilename,
        `Installed ${result.modName} v${result.version}`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CFWidget install error:', error);
    res.status(500).json({ success: false, error: 'Failed to install mod' });
  }
});

// DELETE /api/management/modupdates/uninstall/:filename - Uninstall a tracked mod (delete file and untrack)
router.delete('/modupdates/uninstall/:filename', authMiddleware, requirePermission('mods.delete'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate uninstall
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Mod uninstalled (simulated)' });
    return;
  }

  try {
    const { filename } = req.params;
    const decodedFilename = decodeURIComponent(filename);

    const result = await cfwidgetUninstallMod(decodedFilename);

    if (result.success) {
      const user = req.user || 'system';
      logActivity(
        user,
        'uninstall_mod_cfwidget',
        'mod',
        true,
        decodedFilename,
        `Uninstalled mod`
      );
    }

    res.json(result);
  } catch (error) {
    console.error('CFWidget uninstall error:', error);
    res.status(500).json({ success: false, error: 'Failed to uninstall mod' });
  }
});

export default router;
