import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import * as schedulerService from '../services/scheduler.js';
import * as dockerService from '../services/docker.js';
import { toCommandText } from '../utils/sanitize.js';
import { actorFromRequest, authorizeCommand } from '../services/commandPolicy.js';
import { audit } from '../services/audit.js';
import { asyncRoute } from '../utils/asyncRoute.js';
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

// Demo quick commands: the Hytale 0.7 defaults of a new install.
const DEMO_QUICK_COMMANDS = schedulerService.defaultQuickCommands();

function sendQuickCommandChange(res: Response, change: schedulerService.QuickCommandChange): void {
  if (change === 'ok') res.json({ success: true });
  else if (change === 'not_found') res.status(404).json({ error: 'Command not found' });
  else res.status(500).json({ error: 'Failed to save the quick command' });
}

// GET /api/scheduler/config - Get scheduler configuration
router.get(
  '/config',
  authMiddleware,
  requirePermission('scheduler.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json(DEMO_SCHEDULER_CONFIG);
      return;
    }
    // Scheduled commands come with a derived blockedReason for the UI.
    res.json(await schedulerService.getConfigView(req.serverId));
  }),
);

// PUT /api/scheduler/config - Update scheduler configuration
router.put(
  '/config',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Configuration saved (simulated)' });
      return;
    }

    const incoming = req.body as Record<string, unknown> | undefined;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      res.status(400).json({ success: false, error: 'Configuration object required' });
      return;
    }

    // SECURITY: stored commands get the same check as the console (whitelist +
    // console.execute / console.execute.admin) against the user saving them, so
    // scheduler.edit alone can't plan /op, /stop or /ban. Rejected up front so
    // the user gets a clear error instead of a silently skipped timer.
    const update: Record<string, unknown> = { ...incoming };
    const actor = actorFromRequest(req);
    if ('scheduledCommands' in incoming) {
      const review = await schedulerService.reviewScheduledCommands(
        incoming.scheduledCommands,
        actor,
        req.serverId,
      );
      if (!review.ok) {
        res.status(review.status).json({ success: false, error: review.error });
        return;
      }
      update.scheduledCommands = review.value;
    }
    if ('quickCommands' in incoming) {
      const review = await schedulerService.reviewQuickCommands(
        incoming.quickCommands,
        actor,
        req.serverId,
      );
      if (!review.ok) {
        res.status(review.status).json({ success: false, error: review.error });
        return;
      }
      update.quickCommands = review.value;
    }
    // Restart times drive stop/start of the server: anything but well-spaced
    // "HH:MM" values is refused (an invalid one used to restart in a loop).
    if ('scheduledRestarts' in incoming) {
      const plan = incoming.scheduledRestarts;
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        res.status(400).json({ success: false, error: 'scheduledRestarts must be an object' });
        return;
      }
      if ('times' in plan) {
        const review = schedulerService.reviewRestartTimes((plan as { times: unknown }).times);
        if (!review.ok) {
          res.status(400).json({ success: false, error: review.error });
          return;
        }
        update.scheduledRestarts = { ...plan, times: review.value };
      }
    }

    const success = await schedulerService.saveConfig(update, req.serverId);
    if (success) {
      res.json({ success: true, message: 'Configuration saved' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save configuration' });
    }
  },
);

// POST /api/scheduler/commands/:id/run - Run a scheduled command immediately
router.post(
  '/commands/:id/run',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Scheduled command executed (simulated)' });
      return;
    }
    const result = await schedulerService.runScheduledCommandNow(
      req.params.id,
      req.serverId,
      actorFromRequest(req),
    );
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(result.status ?? 400).json({ success: false, error: result.error });
    }
  },
);

// POST /api/scheduler/commands/:id/approve - Take over a blocked entry as its
// creator (only if the requester may run the command; audited)
router.post(
  '/commands/:id/approve',
  authMiddleware,
  requirePermission('scheduler.edit'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Scheduled command approved (simulated)' });
      return;
    }
    const result = await schedulerService.approveScheduledCommand(
      req.params.id,
      req.serverId,
      actorFromRequest(req),
    );
    if (!result.success) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    audit(req, 'scheduler.command_approved', {
      target: `scheduled_command:${result.serverId}:${req.params.id}`,
      metadata: { name: result.command.name, command: result.command.command },
    });
    res.json({ success: true, command: { ...result.command, blockedReason: null } });
  }),
);

// GET /api/scheduler/status - Get scheduler status
router.get(
  '/status',
  authMiddleware,
  requirePermission('scheduler.view'),
  async (req: AuthenticatedRequest, res: Response) => {
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
    const status = await schedulerService.getSchedulerStatus(req.serverId);
    res.json(status);
  },
);

// POST /api/scheduler/backup/run - Run backup now (the same right as creating
// one on the Backups page, not just editing the schedule)
router.post(
  '/backup/run',
  authMiddleware,
  requirePermission('scheduler.edit', 'backups.create'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { createBackup } = await import('../services/backup.js');
    const result = await createBackup('manual', req.serverId);
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  },
);

// GET /api/scheduler/quick-commands - Get quick commands
router.get(
  '/quick-commands',
  authMiddleware,
  requirePermission('scheduler.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json(DEMO_QUICK_COMMANDS);
      return;
    }
    const commands = schedulerService.getQuickCommands(req.serverId);
    res.json(commands);
  },
);

// POST /api/scheduler/quick-commands - Add quick command
router.post(
  '/quick-commands',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
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
    if (!name || !command || typeof name !== 'string' || typeof command !== 'string') {
      res.status(400).json({ error: 'Name and command are required' });
      return;
    }

    // SECURITY: a quick command may only hold what its author could run in the console.
    const auth = await authorizeCommand(actorFromRequest(req), command, req.serverId);
    if (!auth.allowed) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const newCommand = await schedulerService.addQuickCommand(
      {
        name,
        command,
        icon: icon || 'terminal',
        category: category || 'custom',
      },
      req.serverId,
    );
    if (!newCommand) {
      res.status(500).json({ error: 'Failed to save the quick command' });
      return;
    }

    res.json(newCommand);
  },
);

// PUT /api/scheduler/quick-commands/:id - Update quick command
router.put(
  '/quick-commands/:id',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Command updated (simulated)' });
      return;
    }
    const existing = schedulerService
      .getQuickCommands(req.serverId)
      .find((c) => c.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Command not found' });
      return;
    }
    // Only the editable fields; the id stays fixed.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: { name?: string; command?: string; icon?: string; category?: string } = {};
    for (const key of ['name', 'command', 'icon', 'category'] as const) {
      if (typeof body[key] === 'string') updates[key] = body[key] as string;
    }
    if (updates.command !== undefined && updates.command !== existing.command) {
      const auth = await authorizeCommand(actorFromRequest(req), updates.command, req.serverId);
      if (!auth.allowed) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
    }
    sendQuickCommandChange(
      res,
      await schedulerService.updateQuickCommand(req.params.id, updates, req.serverId),
    );
  },
);

// DELETE /api/scheduler/quick-commands/:id - Delete quick command
router.delete(
  '/quick-commands/:id',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Command deleted (simulated)' });
      return;
    }
    sendQuickCommandChange(
      res,
      await schedulerService.deleteQuickCommand(req.params.id, req.serverId),
    );
  },
);

// POST /api/scheduler/quick-commands/:id/execute - Execute quick command
router.post(
  '/quick-commands/:id/execute',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      const cmd = DEMO_QUICK_COMMANDS.find((c) => c.id === req.params.id);
      res.json({
        success: true,
        message: `[DEMO] Command executed: ${cmd?.command || req.params.id}`,
      });
      return;
    }

    const commands = schedulerService.getQuickCommands(req.serverId);
    const command = commands.find((c) => c.id === req.params.id);
    if (!command) {
      res.status(404).json({ error: 'Command not found' });
      return;
    }

    // SECURITY: clicking a quick command is a console command by the clicking
    // user, so it needs the same whitelist + tier check as typing it.
    const auth = await authorizeCommand(actorFromRequest(req), command.command, req.serverId);
    if (!auth.allowed) {
      res.status(auth.status).json({ success: false, error: auth.error });
      return;
    }

    const result = await dockerService.execCommand(command.command, req.serverId);
    res.json(result);
  },
);

// POST /api/scheduler/broadcast - Send broadcast message
router.post(
  '/broadcast',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: `[DEMO] Broadcast sent: ${req.body.message}` });
      return;
    }

    const { message } = req.body;
    // One line of plain text for the server's command parser.
    const text = typeof message === 'string' ? toCommandText(message, 500) : '';
    if (!text) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    const result = await dockerService.execCommand(`/broadcast ${text}`, req.serverId);
    res.json(result);
  },
);

// POST /api/scheduler/restart/cancel - Cancel pending restart
router.post(
  '/restart/cancel',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Pending restart cancelled (simulated)' });
      return;
    }
    const cancelled = schedulerService.cancelPendingRestart(req.serverId);
    if (cancelled) {
      res.json({ success: true, message: 'Pending restart cancelled' });
    } else {
      res.status(404).json({ success: false, error: 'No pending restart to cancel' });
    }
  },
);

// GET /api/scheduler/restart/status - Get restart status
router.get(
  '/restart/status',
  authMiddleware,
  requirePermission('scheduler.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ enabled: true, pending: null });
      return;
    }
    const status = await schedulerService.getSchedulerStatus(req.serverId);
    res.json(status.scheduledRestarts);
  },
);

export default router;
