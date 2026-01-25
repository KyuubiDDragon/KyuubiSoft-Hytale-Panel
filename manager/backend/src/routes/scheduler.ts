import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as schedulerService from '../services/scheduler.js';
import * as dockerService from '../services/docker.js';
import { isDemoMode, getDemoSchedulerTasks } from '../services/demoData.js';

const router = Router();

// Demo scheduler config
const DEMO_SCHEDULER_CONFIG = {
  autoBackup: {
    enabled: true,
    schedule: '0 4 * * *',
    keepCount: 10,
  },
  autoRestart: {
    enabled: true,
    schedule: '0 5 * * 0',
    warningMinutes: [15, 10, 5, 1],
  },
  announcements: [],
};

// Demo quick commands
const DEMO_QUICK_COMMANDS = [
  { id: 'qc-1', name: 'Weather Clear', command: '/weather clear', icon: 'sun', category: 'world' },
  { id: 'qc-2', name: 'Weather Rain', command: '/weather rain', icon: 'cloud-rain', category: 'world' },
  { id: 'qc-3', name: 'Save World', command: '/save-all', icon: 'save', category: 'server' },
  { id: 'qc-4', name: 'List Players', command: '/list', icon: 'users', category: 'info' },
];

// GET /api/scheduler/config - Get scheduler configuration
router.get('/config', authMiddleware, requirePermission('scheduler.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock config
  if (isDemoMode()) {
    res.json(DEMO_SCHEDULER_CONFIG);
    return;
  }

  const config = schedulerService.getConfig();
  res.json(config);
});

// PUT /api/scheduler/config - Update scheduler configuration
router.put('/config', authMiddleware, requirePermission('scheduler.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate save
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Configuration saved (simulated)' });
    return;
  }

  const success = schedulerService.saveConfig(req.body);
  if (success) {
    res.json({ success: true, message: 'Configuration saved' });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save configuration' });
  }
});

// GET /api/scheduler/status - Get scheduler status
router.get('/status', authMiddleware, requirePermission('scheduler.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock status
  if (isDemoMode()) {
    const tasks = getDemoSchedulerTasks();
    res.json({
      backups: {
        enabled: true,
        nextRun: tasks[0].nextRun,
        lastRun: tasks[0].lastRun,
        schedule: '0 4 * * *',
      },
      announcements: {
        enabled: true,
        activeCount: 2,
      },
      scheduledRestarts: {
        enabled: true,
        nextRestart: tasks[1].nextRun,
        pendingRestart: null,
        times: ['05:00'],
      },
    });
    return;
  }

  const status = schedulerService.getSchedulerStatus();
  res.json(status);
});

// POST /api/scheduler/backup/run - Run backup now
router.post('/backup/run', authMiddleware, requirePermission('scheduler.edit'), async (_req: Request, res: Response) => {
  const { createBackup } = await import('../services/backup.js');
  const result = createBackup('manual');
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

// GET /api/scheduler/quick-commands - Get quick commands
router.get('/quick-commands', authMiddleware, requirePermission('scheduler.view'), async (_req: Request, res: Response) => {
  // Demo mode: return mock commands
  if (isDemoMode()) {
    res.json(DEMO_QUICK_COMMANDS);
    return;
  }

  const commands = schedulerService.getQuickCommands();
  res.json(commands);
});

// POST /api/scheduler/quick-commands - Add quick command
router.post('/quick-commands', authMiddleware, requirePermission('scheduler.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate add
  if (isDemoMode()) {
    const { name, command, icon, category } = req.body;
    res.json({
      id: `qc-demo-${Date.now()}`,
      name,
      command,
      icon: icon || 'terminal',
      category: category || 'custom',
    });
    return;
  }

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
router.put('/quick-commands/:id', authMiddleware, requirePermission('scheduler.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate update
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Command updated (simulated)' });
    return;
  }

  const success = schedulerService.updateQuickCommand(req.params.id, req.body);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Command not found' });
  }
});

// DELETE /api/scheduler/quick-commands/:id - Delete quick command
router.delete('/quick-commands/:id', authMiddleware, requirePermission('scheduler.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate delete
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Command deleted (simulated)' });
    return;
  }

  const success = schedulerService.deleteQuickCommand(req.params.id);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Command not found' });
  }
});

// POST /api/scheduler/quick-commands/:id/execute - Execute quick command
router.post('/quick-commands/:id/execute', authMiddleware, requirePermission('scheduler.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate execution
  if (isDemoMode()) {
    const cmd = DEMO_QUICK_COMMANDS.find(c => c.id === req.params.id);
    res.json({ success: true, message: `[DEMO] Command executed: ${cmd?.command || req.params.id}` });
    return;
  }

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
router.post('/broadcast', authMiddleware, requirePermission('scheduler.edit'), async (req: Request, res: Response) => {
  // Demo mode: simulate broadcast
  if (isDemoMode()) {
    res.json({ success: true, message: `[DEMO] Broadcast sent: ${req.body.message}` });
    return;
  }

  const { message } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  const result = await dockerService.execCommand(`/broadcast ${message}`);
  res.json(result);
});

// POST /api/scheduler/restart/cancel - Cancel pending restart
router.post('/restart/cancel', authMiddleware, requirePermission('scheduler.edit'), async (_req: Request, res: Response) => {
  // Demo mode: simulate cancel
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Pending restart cancelled (simulated)' });
    return;
  }

  const cancelled = schedulerService.cancelPendingRestart();
  if (cancelled) {
    res.json({ success: true, message: 'Pending restart cancelled' });
  } else {
    res.status(404).json({ success: false, error: 'No pending restart to cancel' });
  }
});

// GET /api/scheduler/restart/status - Get restart status
router.get('/restart/status', authMiddleware, requirePermission('scheduler.view'), async (_req: Request, res: Response) => {
  // Demo mode: return empty
  if (isDemoMode()) {
    res.json({ enabled: true, pending: null });
    return;
  }

  const status = schedulerService.getSchedulerStatus();
  res.json(status.scheduledRestarts);
});

export default router;
