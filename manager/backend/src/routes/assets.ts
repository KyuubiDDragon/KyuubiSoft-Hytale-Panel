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
    res.status(500).json(result);
    return;
  }

  res.json({
    success: true,
    message: `Assets extracted successfully (${result.fileCount} files)`,
    fileCount: result.fileCount,
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
router.get('/search', authMiddleware, (req: Request, res: Response) => {
  const query = req.query.q as string;

  if (!query || query.length < 2) {
    res.status(400).json({ detail: 'Search query must be at least 2 characters' });
    return;
  }

  const searchContent = req.query.content === 'true';
  const extensions = req.query.ext ? (req.query.ext as string).split(',') : undefined;
  const maxResults = Math.min(parseInt(req.query.limit as string) || 100, 500);

  const results = assetService.searchAssets(query, {
    searchContent,
    extensions,
    maxResults,
  });

  res.json({
    query,
    count: results.length,
    results,
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

export default router;
