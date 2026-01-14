import { Router, Request, Response } from 'express';
import { readdir, readFile, writeFile, stat } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import * as dockerService from '../services/docker.js';
import { config } from '../config.js';

const router = Router();

// Allowed config file extensions
const CONFIG_EXTENSIONS = ['.json', '.properties', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini'];

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

export default router;
