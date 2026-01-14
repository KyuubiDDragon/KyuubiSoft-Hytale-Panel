import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as dockerService from '../services/docker.js';
import { parseLogs } from '../services/logs.js';

const router = Router();

// GET /api/console/logs
router.get('/logs', authMiddleware, async (req: Request, res: Response) => {
  const tail = Math.min(Math.max(parseInt(req.query.tail as string) || 100, 1), 1000);

  const rawLogs = await dockerService.getLogs(tail);
  const logs = parseLogs(rawLogs);

  res.json({
    logs,
    count: logs.length,
  });
});

// POST /api/console/command
router.post('/command', authMiddleware, async (req: Request, res: Response) => {
  const { command } = req.body;

  if (!command) {
    res.status(400).json({ detail: 'Command required' });
    return;
  }

  const result = await dockerService.execCommand(command);

  res.json({
    success: result.success,
    command,
    output: result.message,
    error: result.error,
  });
});

export default router;
