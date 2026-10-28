import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/audit.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  listEventActionViews,
  approveEventAction,
  getEventAction,
  createEventAction,
  updateEventAction,
  deleteEventAction,
  availableEvents,
  eventActionWarnings,
  reviewEventAction,
  ACTION_TYPES,
  type EventAction,
  type EventActionDraft,
  type EventActionType,
} from '../services/eventActions.js';
import { actorFromRequest } from '../services/commandPolicy.js';
import { isConnectedToPlugin } from '../services/pluginEvents.js';
import { listServers } from '../services/servers.js';
import { asyncRoute } from '../utils/asyncRoute.js';

const router = Router();

/** Whether the rule's server, or one of them for a rule on every server, lacks a plugin connection. */
async function withoutPlugin(serverId: string | null): Promise<boolean> {
  if (serverId) return !isConnectedToPlugin(serverId);
  const servers = await listServers().catch(() => []);
  return servers.length === 0 || servers.some((s) => !isConnectedToPlugin(s.id));
}

async function warningsFor(rule: EventAction) {
  return eventActionWarnings(rule, { withoutPlugin: await withoutPlugin(rule.serverId) });
}

type DraftInput = Partial<Record<keyof EventActionDraft, unknown>>;

// Only the editable fields; id, createdBy and createdAt are never taken from the body.
function pickDraftFields(body: unknown): DraftInput {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: DraftInput = {};
  for (const key of [
    'name',
    'serverId',
    'eventPattern',
    'actionType',
    'actionPayload',
    'enabled',
  ] as const) {
    if (key in src) out[key] = src[key];
  }
  return out;
}

// GET /api/event-actions  — list rules + the catalog of bindable events
router.get(
  '/',
  authMiddleware,
  requirePermission('scheduler.view'),
  asyncRoute(async (_req: Request, res: Response) => {
    // Command rules come with a derived blockedReason (see approve below).
    res.json({
      rules: await listEventActionViews(),
      events: availableEvents(),
      actionTypes: ACTION_TYPES,
    });
  }),
);

// POST /api/event-actions/:id/approve — take over a blocked command rule as its
// creator (only if the requester may run its command; audited)
router.post(
  '/:id/approve',
  authMiddleware,
  requirePermission('scheduler.edit'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const result = await approveEventAction(req.params.id, actorFromRequest(req));
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    audit(req, 'event_action.approved', {
      target: `event_action:${req.params.id}`,
      metadata: { command: result.rule.actionPayload.command },
    });
    res.json({ rule: { ...result.rule, blockedReason: null } });
  }),
);

// POST /api/event-actions
// SECURITY: a command rule needs the same console tier as typing the command
// (on the rule's server, or globally for "all servers"); the rule later runs
// with its creator's current rights, not with full console rights.
router.post(
  '/',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    const input = pickDraftFields(req.body);
    const draft = {
      name: input.name,
      serverId: input.serverId || null, // '' / omitted = all servers
      eventPattern: input.eventPattern,
      actionType: input.actionType,
      actionPayload: input.actionPayload ?? {},
      enabled: true,
    } as EventActionDraft;
    const review = await reviewEventAction(draft, null, actorFromRequest(req));
    if (!review.ok) {
      res.status(review.status).json({ error: review.error });
      return;
    }
    const rule = createEventAction({
      name: draft.name,
      serverId: draft.serverId,
      eventPattern: draft.eventPattern,
      actionType: draft.actionType as EventActionType,
      actionPayload: draft.actionPayload,
      createdBy: review.createdBy,
    });
    audit(req, 'event_action.created', {
      target: `event_action:${rule.id}`,
      metadata: { eventPattern: draft.eventPattern, actionType: draft.actionType },
    });
    res.json({ rule, warnings: await warningsFor(rule) });
  },
);

// PUT /api/event-actions/:id
router.put(
  '/:id',
  authMiddleware,
  requirePermission('scheduler.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    const existing = getEventAction(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    const merged = { ...existing, ...pickDraftFields(req.body) } as EventAction & EventActionDraft;
    const draft = { ...merged, serverId: merged.serverId || null };
    const review = await reviewEventAction(draft, existing, actorFromRequest(req));
    if (!review.ok) {
      res.status(review.status).json({ error: review.error });
      return;
    }
    const updated = updateEventAction(req.params.id, {
      name: draft.name,
      serverId: draft.serverId ?? null,
      eventPattern: draft.eventPattern,
      actionType: draft.actionType,
      actionPayload: draft.actionPayload,
      enabled: draft.enabled,
      createdBy: review.createdBy,
    });
    if (!updated) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    audit(req, 'event_action.updated', { target: `event_action:${req.params.id}` });
    res.json({ rule: updated, warnings: await warningsFor(updated) });
  },
);

// DELETE /api/event-actions/:id
router.delete(
  '/:id',
  authMiddleware,
  requirePermission('scheduler.edit'),
  (req: AuthenticatedRequest, res: Response) => {
    if (!deleteEventAction(req.params.id)) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    audit(req, 'event_action.deleted', { target: `event_action:${req.params.id}` });
    res.json({ success: true });
  },
);

export default router;
