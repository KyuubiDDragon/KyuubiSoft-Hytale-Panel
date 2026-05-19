import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  listWebhooks, getWebhook, createWebhook, updateWebhook, deleteWebhook,
  listDeliveries, testWebhook,
} from '../services/webhooks.js';
import { PanelEventNames, type PanelEventName } from '../schemas/events.js';
import { audit } from '../services/audit.js';
import { z } from 'zod';

const router = Router();

const upsertSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  type: z.enum(['discord', 'slack', 'generic']),
  events: z.array(z.enum(PanelEventNames)).min(1),
  secret: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
});

router.get('/', authMiddleware, requirePermission('webhooks.view'), (_req: AuthenticatedRequest, res: Response) => {
  res.json({ webhooks: listWebhooks(), availableEvents: PanelEventNames });
});

router.post('/', authMiddleware, requirePermission('webhooks.manage'), (req: AuthenticatedRequest, res: Response) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    return;
  }
  const wh = createWebhook({ ...parsed.data, events: parsed.data.events as PanelEventName[], createdBy: req.user! });
  audit(req, 'webhook.created', { target: `webhook:${wh.id}`, metadata: { name: wh.name, type: wh.type } });
  res.json({ webhook: wh });
});

router.put('/:id', authMiddleware, requirePermission('webhooks.manage'), (req: AuthenticatedRequest, res: Response) => {
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    return;
  }
  const data = { ...parsed.data, events: parsed.data.events as PanelEventName[] | undefined };
  const wh = updateWebhook(req.params.id, data);
  if (!wh) { res.status(404).json({ detail: 'Webhook not found' }); return; }
  audit(req, 'webhook.updated', { target: `webhook:${wh.id}` });
  res.json({ webhook: wh });
});

router.delete('/:id', authMiddleware, requirePermission('webhooks.manage'), (req: AuthenticatedRequest, res: Response) => {
  if (!deleteWebhook(req.params.id)) { res.status(404).json({ detail: 'Webhook not found' }); return; }
  audit(req, 'webhook.deleted', { target: `webhook:${req.params.id}` });
  res.json({ success: true });
});

router.post('/:id/test', authMiddleware, requirePermission('webhooks.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await testWebhook(req.params.id, req.user!);
    audit(req, 'webhook.tested', { target: `webhook:${req.params.id}`, metadata: { success: result.success } });
    res.json(result);
  } catch (err) {
    res.status(404).json({ detail: err instanceof Error ? err.message : 'Failed' });
  }
});

router.get('/:id/deliveries', authMiddleware, requirePermission('webhooks.view'), (req: AuthenticatedRequest, res: Response) => {
  if (!getWebhook(req.params.id)) { res.status(404).json({ detail: 'Webhook not found' }); return; }
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;
  const status = req.query.status as string | undefined;
  res.json(listDeliveries(req.params.id, { limit, cursor, status }));
});

export default router;
