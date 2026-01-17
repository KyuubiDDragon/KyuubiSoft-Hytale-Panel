import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as dockerService from '../services/docker.js';
import { parseLogs } from '../services/logs.js';

const router = Router();

// GET /api/console/logs
router.get('/logs', authMiddleware, async (req: Request, res: Response) => {
  // Allow 0 for all logs, otherwise limit between 1 and 10000
  const tailParam = parseInt(req.query.tail as string);
  const tail = tailParam === 0 ? 0 : Math.min(Math.max(tailParam || 100, 1), 10000);

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
