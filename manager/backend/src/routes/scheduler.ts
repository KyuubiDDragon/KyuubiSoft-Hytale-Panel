import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as schedulerService from '../services/scheduler.js';
import * as dockerService from '../services/docker.js';

const router = Router();

// GET /api/scheduler/config - Get scheduler configuration
router.get('/config', authMiddleware, async (_req: Request, res: Response) => {
  const config = schedulerService.getConfig();
  res.json(config);
});

// PUT /api/scheduler/config - Update scheduler configuration
router.put('/config', authMiddleware, async (req: Request, res: Response) => {
  const success = schedulerService.saveConfig(req.body);
  if (success) {
    res.json({ success: true, message: 'Configuration saved' });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save configuration' });
  }
});

// GET /api/scheduler/status - Get scheduler status
router.get('/status', authMiddleware, async (_req: Request, res: Response) => {
  const status = schedulerService.getSchedulerStatus();
  res.json(status);
});

// POST /api/scheduler/backup/run - Run backup now
router.post('/backup/run', authMiddleware, async (_req: Request, res: Response) => {
  const { createBackup } = await import('../services/backup.js');
  const result = createBackup('manual');
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

// GET /api/scheduler/quick-commands - Get quick commands
router.get('/quick-commands', authMiddleware, async (_req: Request, res: Response) => {
  const commands = schedulerService.getQuickCommands();
  res.json(commands);
});

// POST /api/scheduler/quick-commands - Add quick command
router.post('/quick-commands', authMiddleware, async (req: Request, res: Response) => {
  const { name, command, icon, category } = req.body;

  if (!name || !command) {
    res.status(400).json({ error: 'Name and command are required' });
    return;
  }

  const newCommand = schedulerService.addQuickCommand({
    name,
    command,
    icon: icon || 'terminal',
    category: category || 'custom',
  });

  res.json(newCommand);
});

// PUT /api/scheduler/quick-commands/:id - Update quick command
router.put('/quick-commands/:id', authMiddleware, async (req: Request, res: Response) => {
  const success = schedulerService.updateQuickCommand(req.params.id, req.body);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Command not found' });
  }
});

// DELETE /api/scheduler/quick-commands/:id - Delete quick command
router.delete('/quick-commands/:id', authMiddleware, async (req: Request, res: Response) => {
  const success = schedulerService.deleteQuickCommand(req.params.id);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Command not found' });
  }
});

// POST /api/scheduler/quick-commands/:id/execute - Execute quick command
router.post('/quick-commands/:id/execute', authMiddleware, async (req: Request, res: Response) => {
  const commands = schedulerService.getQuickCommands();
  const command = commands.find(c => c.id === req.params.id);

  if (!command) {
    res.status(404).json({ error: 'Command not found' });
    return;
  }

  const result = await dockerService.execCommand(command.command);
  res.json(result);
});

// POST /api/scheduler/broadcast - Send broadcast message
router.post('/broadcast', authMiddleware, async (req: Request, res: Response) => {
  const { message } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  const result = await dockerService.execCommand(`/broadcast ${message}`);
  res.json(result);
});

// POST /api/scheduler/restart/cancel - Cancel pending restart
router.post('/restart/cancel', authMiddleware, async (_req: Request, res: Response) => {
  const cancelled = schedulerService.cancelPendingRestart();
  if (cancelled) {
    res.json({ success: true, message: 'Pending restart cancelled' });
  } else {
    res.status(404).json({ success: false, error: 'No pending restart to cancel' });
  }
});

// GET /api/scheduler/restart/status - Get restart status
router.get('/restart/status', authMiddleware, async (_req: Request, res: Response) => {
  const status = schedulerService.getSchedulerStatus();
  res.json(status.scheduledRestarts);
});

export default router;
