// Aggregate router for /api/management. Mounts the directories / worlds /
// worldConfigs / configs / cache submodules under the same path so every
// original URL is preserved.
import { Router } from 'express';

import directoriesRoutes from './directories.js';
import worldsRoutes from './worlds.js';
import worldConfigsRoutes from './worldConfigs.js';
import configsRoutes from './configs.js';
import cacheRoutes from './cache.js';

// Re-export helpers that callers of the old monolithic module may have relied on.
// (`logActivity` was re-exported and `addStatsEntry` was exported by the old file.)
export { logActivity } from '../../services/activityLog.js';
export { addStatsEntry } from '../../services/managementHelpers.js';

const router = Router();

// All submodules are mounted at root so each route keeps its original
// /api/management/* URL exactly as it was before the split.
router.use('/', directoriesRoutes);
router.use('/', worldsRoutes);
router.use('/', worldConfigsRoutes);
router.use('/', configsRoutes);
router.use('/', cacheRoutes);

export default router;
