import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/audit.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  listEventActions, createEventAction, updateEventAction, deleteEventAction,
  availableEvents, type EventActionType,
} from '../services/eventActions.js';

const router = Router();

const ACTION_TYPES: EventActionType[] = ['command', 'announce', 'backup'];

// GET /api/event-actions  — list rules + the catalog of bindable events
router.get('/', authMiddleware, requirePermission('scheduler.view'), (_req: Request, res: Response) => {
  res.json({ rules: listEventActions(), events: availableEvents(), actionTypes: ACTION_TYPES });
});

// POST /api/event-actions
router.post('/', authMiddleware, requirePermission('scheduler.edit'), (req: AuthenticatedRequest, res: Response) => {
  const { name, serverId, eventPattern, actionType, actionPayload } = req.body as {
    name?: string; serverId?: string; eventPattern?: string; actionType?: string;
    actionPayload?: { command?: string; message?: string };
  };
  if (!name || !eventPattern || !actionType || !ACTION_TYPES.includes(actionType as EventActionType)) {
    res.status(400).json({ error: 'name, eventPattern and a valid actionType are required' });
    return;
  }
  if (actionType === 'command' && !actionPayload?.command) {
    res.status(400).json({ error: 'command action requires actionPayload.command' });
    return;
  }
  if (actionType === 'announce' && !actionPayload?.message) {
    res.status(400).json({ error: 'announce action requires actionPayload.message' });
    return;
  }
  const rule = createEventAction({
    name, serverId: serverId ?? null, eventPattern,
    actionType: actionType as EventActionType,
    actionPayload: actionPayload ?? {},
    createdBy: req.user || 'system',
  });
  audit(req, 'event_action.created', { target: `event_action:${rule.id}`, metadata: { eventPattern, actionType } });
  res.json({ rule });
});

// PUT /api/event-actions/:id
router.put('/:id', authMiddleware, requirePermission('scheduler.edit'), (req: AuthenticatedRequest, res: Response) => {
  const updated = updateEventAction(req.params.id, req.body ?? {});
  if (!updated) { res.status(404).json({ error: 'Rule not found' }); return; }
  audit(req, 'event_action.updated', { target: `event_action:${req.params.id}` });
  res.json({ rule: updated });
});

// DELETE /api/event-actions/:id
router.delete('/:id', authMiddleware, requirePermission('scheduler.edit'), (req: AuthenticatedRequest, res: Response) => {
  if (!deleteEventAction(req.params.id)) { res.status(404).json({ error: 'Rule not found' }); return; }
  audit(req, 'event_action.deleted', { target: `event_action:${req.params.id}` });
  res.json({ success: true });
});

export default router;
