/**
 * Routes for the auto-wiki (V3.1.3).
 *
 * GET /api/wiki[?public=true]   – list (may be public per panel config)
 * GET /api/wiki/:slug            – single page (markdown + metadata)
 * GET /api/wiki/config           – wiki config
 * PUT /api/wiki/config           – update wiki config
 * POST /api/wiki/regenerate     – trigger a scan
 */
import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as wiki from '../services/wiki.js';
import { logActivity } from '../services/activityLog.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Bypass auth ONLY for read endpoints when wiki.publicAccess is enabled.
async function authOrPublicRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  const isReadRequest = req.method === 'GET' && !req.path.endsWith('/config');
  if (isReadRequest && req.query.public === 'true') {
    const cfg = await wiki.getWikiConfig();
    if (cfg.publicAccess) {
      next();
      return;
    }
  }
  // Fall through to standard auth + permission middleware.
  authMiddleware(req as AuthenticatedRequest, res, () => {
    requirePermission('wiki.view')(req as AuthenticatedRequest, res, next);
  });
}

router.get('/', authOrPublicRead, async (_req: Request, res: Response) => {
  const index = await wiki.loadWikiIndex();
  res.json(index);
});

router.get('/config', authMiddleware, requirePermission('wiki.view'), async (_req: Request, res: Response) => {
  res.json(await wiki.getWikiConfig());
});

router.put('/config', authMiddleware, requirePermission('wiki.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const { publicAccess } = req.body ?? {};
  const next = await wiki.setWikiConfig({
    publicAccess: typeof publicAccess === 'boolean' ? publicAccess : undefined,
  });
  await logActivity(req.user || 'system', 'wiki.config_changed', 'wiki', true, undefined, JSON.stringify(next));
  res.json(next);
});

router.post('/regenerate', authMiddleware, requirePermission('wiki.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const index = await wiki.regenerateWiki();
    await logActivity(req.user || 'system', 'wiki.regenerated', 'wiki', true, undefined, `${index.entries.length} entries`);
    res.json({ success: true, count: index.entries.length, generatedAt: index.generatedAt });
  } catch (err) {
    await logActivity(req.user || 'system', 'wiki.regenerated', 'wiki', false, undefined, (err as Error).message);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

router.get('/:slug', authOrPublicRead, async (req: Request, res: Response) => {
  const page = await wiki.loadWikiPage(req.params.slug);
  if (!page) {
    res.status(404).json({ error: 'Page not found' });
    return;
  }
  res.json(page);
});

export default router;
