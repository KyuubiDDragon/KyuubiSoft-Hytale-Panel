import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as assetService from '../services/assets.js';

const router = Router();

// GET /api/assets/status - Get extraction status
router.get('/status', authMiddleware, (_req: Request, res: Response) => {
  const status = assetService.getAssetStatus();
  res.json(status);
});

// POST /api/assets/extract - Extract assets from archive
router.post('/extract', authMiddleware, (_req: Request, res: Response) => {
  const result = assetService.extractAssets();

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
router.delete('/cache', authMiddleware, (_req: Request, res: Response) => {
  const result = assetService.clearAssets();

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
router.get('/browse', authMiddleware, (req: Request, res: Response) => {
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
router.get('/tree', authMiddleware, (req: Request, res: Response) => {
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
router.get('/file', authMiddleware, (req: Request, res: Response) => {
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
router.get('/search', authMiddleware, (req: Request, res: Response) => {
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
router.get('/download/*', authMiddleware, (req: Request, res: Response) => {
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
router.get('/item-icon/:itemId', authMiddleware, (req: Request, res: Response) => {
  const { itemId } = req.params;

  if (!itemId) {
    res.status(400).json({ detail: 'Item ID required' });
    return;
  }

  // Common paths where item icons might be found in Hytale assets
  const possiblePaths = [
    // UI Icons
    `hytale/textures/ui/icons/items/${itemId}.png`,
    `hytale/textures/ui/icons/items/${itemId.toLowerCase()}.png`,
    `textures/ui/icons/items/${itemId}.png`,
    `textures/ui/icons/items/${itemId.toLowerCase()}.png`,
    // Direct item textures
    `hytale/textures/items/${itemId}.png`,
    `hytale/textures/items/${itemId.toLowerCase()}.png`,
    `textures/items/${itemId}.png`,
    // Block textures (for block items)
    `hytale/textures/blocks/${itemId}.png`,
    `textures/blocks/${itemId}.png`,
    // Try with underscores converted to paths
    `hytale/textures/ui/icons/items/${itemId.replace(/_/g, '/')}.png`,
  ];

  // Try each possible path
  for (const iconPath of possiblePaths) {
    const result = assetService.readAssetFile(iconPath);
    if (result.success && result.isBinary && result.mimeType?.startsWith('image/')) {
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      res.send(Buffer.from(result.content as string, 'base64'));
      return;
    }
  }

  // If not found, return 404
  res.status(404).json({ detail: 'Item icon not found', itemId });
});

// GET /api/assets/item-icon-search/:itemId - Search for item icon path
// Returns the path if found, useful for debugging/checking if icon exists
router.get('/item-icon-search/:itemId', authMiddleware, (req: Request, res: Response) => {
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

export default router;
