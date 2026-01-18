import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as assetService from '../services/assets.js';

const router = Router();

// Cache for found icon paths - speeds up repeated lookups significantly
const iconPathCache = new Map<string, string | null>();
const ICON_CACHE_MAX_SIZE = 1000;

function getCachedIconPath(itemId: string): string | null | undefined {
  return iconPathCache.get(itemId);
}

function setCachedIconPath(itemId: string, path: string | null): void {
  // Prevent unbounded cache growth
  if (iconPathCache.size >= ICON_CACHE_MAX_SIZE) {
    // Remove oldest entries (first 100)
    const keysToDelete = Array.from(iconPathCache.keys()).slice(0, 100);
    keysToDelete.forEach(k => iconPathCache.delete(k));
  }
  iconPathCache.set(itemId, path);
}

// GET /api/assets/status - Get extraction status
router.get('/status', authMiddleware, requirePermission('assets.view'), (_req: Request, res: Response) => {
  const status = assetService.getAssetStatus();
  res.json(status);
});

// POST /api/assets/extract - Extract assets from archive
router.post('/extract', authMiddleware, requirePermission('assets.manage'), (_req: Request, res: Response) => {
  const result = assetService.extractAssets();

  // Clear icon path cache when re-extracting
  iconPathCache.clear();

  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json({
    success: true,
    message: result.message || 'Extraction started',
  });
});

// DELETE /api/assets/cache - Clear extracted assets
router.delete('/cache', authMiddleware, requirePermission('assets.manage'), (_req: Request, res: Response) => {
  const result = assetService.clearAssets();

  // Clear icon path cache as well
  iconPathCache.clear();

  if (!result.success) {
    res.status(500).json(result);
    return;
  }

  res.json({
    success: true,
    message: 'Asset cache cleared',
  });
});

// GET /api/assets/browse - List directory contents
router.get('/browse', authMiddleware, requirePermission('assets.view'), (req: Request, res: Response) => {
  const relativePath = (req.query.path as string) || '';

  const items = assetService.listAssetDirectory(relativePath);

  if (items === null) {
    res.status(404).json({ detail: 'Directory not found or invalid path' });
    return;
  }

  res.json({
    path: relativePath,
    items,
  });
});

// GET /api/assets/tree - Get directory tree
router.get('/tree', authMiddleware, requirePermission('assets.view'), (req: Request, res: Response) => {
  const relativePath = (req.query.path as string) || '';
  const maxDepth = Math.min(parseInt(req.query.depth as string) || 3, 5);

  const tree = assetService.getAssetTree(relativePath, maxDepth);

  if (tree === null) {
    res.status(404).json({ detail: 'Directory not found or invalid path' });
    return;
  }

  res.json(tree);
});

// GET /api/assets/file - Read file content
router.get('/file', authMiddleware, requirePermission('assets.view'), (req: Request, res: Response) => {
  const relativePath = req.query.path as string;

  if (!relativePath) {
    res.status(400).json({ detail: 'Path parameter required' });
    return;
  }

  const result = assetService.readAssetFile(relativePath);

  if (!result.success) {
    res.status(404).json({ detail: result.error });
    return;
  }

  res.json({
    path: relativePath,
    content: result.content,
    mimeType: result.mimeType,
    size: result.size,
    isBinary: result.isBinary,
  });
});

// GET /api/assets/search - Search for files
// Supports: plain text, glob patterns (*.json, sign*.json), regex (/pattern/flags)
router.get('/search', authMiddleware, requirePermission('assets.view'), (req: Request, res: Response) => {
  const query = req.query.q as string;

  if (!query || query.length < 2) {
    res.status(400).json({ detail: 'Search query must be at least 2 characters' });
    return;
  }

  const searchContent = req.query.content === 'true';
  const extensions = req.query.ext ? (req.query.ext as string).split(',') : undefined;
  const maxResults = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const useRegex = req.query.regex === 'true';
  const useGlob = req.query.glob === 'true';

  const results = assetService.searchAssets(query, {
    searchContent,
    extensions,
    maxResults,
    useRegex,
    useGlob,
  });

  res.json({
    query,
    count: results.length,
    results,
    mode: useRegex ? 'regex' : useGlob ? 'glob' : 'auto',
  });
});

// GET /api/assets/download/:path(*) - Download raw file
router.get('/download/*', authMiddleware, requirePermission('assets.view'), (req: Request, res: Response) => {
  const relativePath = req.params[0];

  if (!relativePath) {
    res.status(400).json({ detail: 'Path parameter required' });
    return;
  }

  const result = assetService.readAssetFile(relativePath);

  if (!result.success) {
    res.status(404).json({ detail: result.error });
    return;
  }

  const filename = relativePath.split('/').pop() || 'file';

  if (result.isBinary && result.mimeType?.startsWith('image/')) {
    // Send actual image file
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(Buffer.from(result.content as string, 'base64'));
  } else {
    // Send as download
    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(result.content);
  }
});

// GET /api/assets/item-icon/:itemId - Get item icon image
// Searches common paths for item icons and returns the image
// NOTE: No authMiddleware - this endpoint is public so <img> tags can load icons
router.get('/item-icon/:itemId', (req: Request, res: Response) => {
  let { itemId } = req.params;

  if (!itemId) {
    res.status(400).json({ detail: 'Item ID required' });
    return;
  }

  // Strip namespace prefix if present (e.g., "hytale:Cobalt_Sword" -> "Cobalt_Sword")
  const originalId = itemId;
  if (itemId.includes(':')) {
    itemId = itemId.split(':')[1];
  }

  // Check cache first for fast lookup
  const cachedPath = getCachedIconPath(itemId);
  if (cachedPath !== undefined) {
    if (cachedPath === null) {
      // Cached as not found
      res.status(404).json({ detail: 'Item icon not found (cached)', itemId });
      return;
    }
    // Found in cache - serve directly
    const result = assetService.readAssetFile(cachedPath);
    if (result.success && result.isBinary && result.mimeType?.startsWith('image/')) {
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(result.content as string, 'base64'));
      return;
    }
    // Cached path no longer valid, remove from cache
    iconPathCache.delete(itemId);
  }

  // Create variations of the item name for searching
  const itemLower = itemId.toLowerCase();
  // Convert to title case (armor_adamantite_chest -> Armor_Adamantite_Chest)
  const itemTitleCase = itemId.split('_').map((w: string) =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join('_');

  // Primary path: Common/Icons/ItemsGenerated/ - this is where all items are!
  // Order matters - most likely paths first for fast lookup
  const possiblePaths = [
    `Common/Icons/ItemsGenerated/${itemTitleCase}.png`,
    `Common/Icons/ItemsGenerated/${itemId}.png`,
    `Common/Icons/ItemsGenerated/${itemLower}.png`,
  ];

  // Try each possible path
  for (const iconPath of possiblePaths) {
    const result = assetService.readAssetFile(iconPath);
    if (result.success && result.isBinary && result.mimeType?.startsWith('image/')) {
      // Cache the found path
      setCachedIconPath(itemId, iconPath);
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      res.send(Buffer.from(result.content as string, 'base64'));
      return;
    }
  }

  // If not found in standard paths, try a search for the item name
  const searchResults = assetService.searchAssets(itemId, {
    extensions: ['.png'],
    maxResults: 5,
    useGlob: false,
  });

  // Also try lowercase search
  if (searchResults.length === 0) {
    const lowerSearchResults = assetService.searchAssets(itemLower, {
      extensions: ['.png'],
      maxResults: 5,
      useGlob: false,
    });
    searchResults.push(...lowerSearchResults);
  }

  // Try to find a matching result
  for (const searchResult of searchResults) {
    // Prefer files with "icon" in the path
    if (searchResult.path.toLowerCase().includes('icon') ||
        searchResult.path.toLowerCase().includes('item') ||
        searchResult.path.toLowerCase().includes('ui')) {
      const result = assetService.readAssetFile(searchResult.path);
      if (result.success && result.isBinary && result.mimeType?.startsWith('image/')) {
        // Cache the found path
        setCachedIconPath(itemId, searchResult.path);
        res.setHeader('Content-Type', result.mimeType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.from(result.content as string, 'base64'));
        return;
      }
    }
  }

  // If still not found, try any search result
  if (searchResults.length > 0) {
    const result = assetService.readAssetFile(searchResults[0].path);
    if (result.success && result.isBinary && result.mimeType?.startsWith('image/')) {
      // Cache the found path
      setCachedIconPath(itemId, searchResults[0].path);
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(result.content as string, 'base64'));
      return;
    }
  }

  // Cache as not found to avoid repeated searches
  setCachedIconPath(itemId, null);

  // If not found, return 404 with debug info
  res.status(404).json({
    detail: 'Item icon not found',
    originalId,
    itemId,
    searchedPaths: possiblePaths.slice(0, 8),
    searchResults: searchResults.map(r => r.path).slice(0, 5),
  });
});

// GET /api/assets/player-avatar - Get a player avatar/face texture
// Searches for player character textures in the assets
router.get('/player-avatar', (req: Request, res: Response) => {
  // Try specific paths first (common Hytale asset locations)
  const specificPaths = [
    // UI portraits/avatars
    'hytale/textures/ui/portraits/player.png',
    'hytale/textures/ui/avatars/default.png',
    'hytale/textures/ui/icons/player.png',
    'hytale/textures/ui/hud/player_portrait.png',
    // Entity textures
    'hytale/textures/entity/player/face.png',
    'hytale/textures/entity/player/head.png',
    'hytale/textures/entity/player/default.png',
    'hytale/textures/entity/human/face.png',
    'hytale/textures/entity/npc/human_face.png',
    // Character model textures
    'hytale/textures/models/player/face.png',
    'hytale/textures/models/character/face.png',
    // Alternative structures
    'textures/entity/player/face.png',
    'textures/ui/portraits/player.png',
    'ui/portraits/player.png',
    'ui/avatars/default.png',
  ];

  // Try specific paths first
  for (const avatarPath of specificPaths) {
    const result = assetService.readAssetFile(avatarPath);
    if (result.success && result.isBinary && result.mimeType?.startsWith('image/')) {
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(result.content as string, 'base64'));
      return;
    }
  }

  // Fallback: Search for player/character face/avatar textures
  const searchTerms = [
    'human_face',
    'player_face',
    'character_face',
    'portrait',
    'avatar',
    'npc_human',
    'face_texture',
    'player_icon',
  ];

  for (const term of searchTerms) {
    const results = assetService.searchAssets(term, {
      extensions: ['.png', '.jpg', '.jpeg'],
      maxResults: 20,
      useGlob: false,
    });

    // Look for face/head/portrait specifically
    for (const result of results) {
      const pathLower = result.path.toLowerCase();
      if (pathLower.includes('face') ||
          pathLower.includes('head') ||
          pathLower.includes('portrait') ||
          pathLower.includes('icon') ||
          pathLower.includes('avatar')) {
        const fileResult = assetService.readAssetFile(result.path);
        if (fileResult.success && fileResult.isBinary && fileResult.mimeType?.startsWith('image/')) {
          res.setHeader('Content-Type', fileResult.mimeType);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.send(Buffer.from(fileResult.content as string, 'base64'));
          return;
        }
      }
    }
  }

  // Not found
  res.status(404).json({ detail: 'Player avatar texture not found in assets' });
});

// GET /api/assets/player-avatar-search - Debug: Search for player-related textures
router.get('/player-avatar-search', authMiddleware, requirePermission('assets.view'), (req: Request, res: Response) => {
  const searchTerms = ['character', 'player', 'face', 'head', 'avatar', 'portrait', 'human', 'npc'];
  const allResults: { term: string; paths: string[] }[] = [];

  for (const term of searchTerms) {
    const results = assetService.searchAssets(term, {
      extensions: ['.png', '.jpg', '.jpeg'],
      maxResults: 20,
      useGlob: false,
    });
    if (results.length > 0) {
      allResults.push({
        term,
        paths: results.map(r => r.path),
      });
    }
  }

  res.json({ results: allResults });
});

// GET /api/assets/item-icon-search/:itemId - Search for item icon path
// Returns the path if found, useful for debugging/checking if icon exists
router.get('/item-icon-search/:itemId', authMiddleware, requirePermission('assets.view'), (req: Request, res: Response) => {
  const { itemId } = req.params;

  if (!itemId) {
    res.status(400).json({ detail: 'Item ID required' });
    return;
  }

  // Search for the item icon
  const results = assetService.searchAssets(itemId, {
    extensions: ['.png', '.jpg', '.jpeg'],
    maxResults: 10,
    useGlob: false,
  });

  res.json({
    itemId,
    found: results.length > 0,
    paths: results.map(r => r.path),
  });
});

// GET /api/assets/items - Get list of all available items
// Returns items with their IDs, display names, and icon paths
router.get('/items', authMiddleware, requirePermission('assets.view'), (req: Request, res: Response) => {
  const query = (req.query.q as string) || '';
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  if (query) {
    // Search items
    const items = assetService.searchItems(query, limit);
    res.json({
      items,
      count: items.length,
      query,
    });
  } else {
    // Return all items
    const items = assetService.getItemList();
    res.json({
      items: items.slice(0, limit),
      count: items.length,
      total: items.length,
    });
  }
});

// GET /api/assets/debug/structure - Get top-level structure of extracted assets
// Useful for debugging and finding where icons are located
router.get('/debug/structure', authMiddleware, requirePermission('assets.view'), (_req: Request, res: Response) => {
  const tree = assetService.getAssetTree('', 2);

  if (tree === null) {
    res.status(404).json({ detail: 'Assets not extracted or directory not found' });
    return;
  }

  res.json({
    structure: tree,
    hint: 'Use /api/assets/browse?path=<path> to explore further',
  });
});

// GET /api/assets/debug/find-icons - Search for all icon/texture directories
router.get('/debug/find-icons', authMiddleware, requirePermission('assets.view'), (_req: Request, res: Response) => {
  const iconPaths = assetService.searchAssets('icon', {
    extensions: [],
    maxResults: 50,
    useGlob: false,
  });

  const texturePaths = assetService.searchAssets('texture', {
    extensions: [],
    maxResults: 50,
    useGlob: false,
  });

  res.json({
    iconDirectories: iconPaths.filter(p => p.type === 'directory').map(p => p.path),
    textureDirectories: texturePaths.filter(p => p.type === 'directory').map(p => p.path),
    sampleIconFiles: iconPaths.filter(p => p.type === 'file').slice(0, 10).map(p => p.path),
    sampleTextureFiles: texturePaths.filter(p => p.type === 'file').slice(0, 10).map(p => p.path),
  });
});

export default router;
