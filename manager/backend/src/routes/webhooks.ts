import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  ALL_SERVERS_REQUIRED,
  SERVER_NOT_ALLOWED,
  accessibleServerIds,
  requirePermission,
} from '../middleware/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
  testWebhook,
  type Webhook,
} from '../services/webhooks.js';
import { PanelEventNames, type PanelEventName } from '../schemas/events.js';
import { audit } from '../services/audit.js';
import { assertSafeOutboundUrl, UnsafeUrlError } from '../utils/urlGuard.js';
import { getServer } from '../services/servers.js';
import { isValidServerId } from '../services/perServerData.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import { z } from 'zod';

const router = Router();

const upsertSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  type: z.enum(['discord', 'slack', 'generic']),
  events: z.array(z.enum(PanelEventNames)).min(1),
  // Only events of these servers; empty or omitted = every server.
  serverIds: z.array(z.string().refine(isValidServerId, 'invalid server id')).max(100).optional(),
  secret: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
});

/** The first id in `ids` the registry does not know, if any. */
async function unknownServerId(ids: readonly string[] | undefined): Promise<string | null> {
  for (const id of ids ?? []) {
    if (!(await getServer(id).catch(() => null))) return id;
  }
  return null;
}

/**
 * Why the caller may not manage a webhook for `serverIds`, or null when they
 * may. A webhook delivers that servers' events, so a caller limited to some
 * servers only manages webhooks for those; one for every server (empty list)
 * needs access to every server.
 */
async function serverAccessProblem(
  req: AuthenticatedRequest,
  serverIds: readonly string[],
): Promise<{ error: string; code: string } | null> {
  const allowed = await accessibleServerIds(req);
  if (allowed === null) return null;
  if (serverIds.length === 0) {
    return {
      error: 'A webhook for every server needs access to every server; choose your servers',
      code: ALL_SERVERS_REQUIRED,
    };
  }
  const outside = serverIds.find((id) => !allowed.includes(id));
  return outside ? { error: `No access to server ${outside}`, code: SERVER_NOT_ALLOWED } : null;
}

/** The webhook, after checking the caller may manage it; null after answering 404/403. */
async function ownWebhook(req: AuthenticatedRequest, res: Response): Promise<Webhook | null> {
  const wh = getWebhook(req.params.id);
  if (!wh) {
    res.status(404).json({ detail: 'Webhook not found' });
    return null;
  }
  const problem = await serverAccessProblem(req, wh.serverIds);
  if (problem) {
    res.status(403).json(problem);
    return null;
  }
  return wh;
}

function invalidBody(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'invalid_body',
    issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
}

/** Checks the URL and the server list; answers and returns false when one is not acceptable. */
async function acceptTarget(
  req: AuthenticatedRequest,
  res: Response,
  data: { url?: string; serverIds?: string[] },
  serverIds: readonly string[],
): Promise<boolean> {
  if (data.url) {
    try {
      assertSafeOutboundUrl(data.url);
    } catch (e) {
      const err = e as UnsafeUrlError;
      res.status(400).json({ error: 'unsafe_url', detail: err.message, reason: err.reason });
      return false;
    }
  }
  const unknown = await unknownServerId(data.serverIds);
  if (unknown) {
    res.status(400).json({ error: 'unknown_server', detail: `Unknown server: ${unknown}` });
    return false;
  }
  const problem = await serverAccessProblem(req, serverIds);
  if (problem) {
    res.status(403).json(problem);
    return false;
  }
  return true;
}

router.get(
  '/',
  authMiddleware,
  requirePermission('webhooks.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    // Only the webhooks the caller could manage: those for their own servers.
    const visible: Webhook[] = [];
    for (const wh of listWebhooks()) {
      if (!(await serverAccessProblem(req, wh.serverIds))) visible.push(wh);
    }
    res.json({ webhooks: visible, availableEvents: PanelEventNames });
  }),
);

router.post(
  '/',
  authMiddleware,
  requirePermission('webhooks.manage'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    if (!(await acceptTarget(req, res, parsed.data, parsed.data.serverIds ?? []))) return;
    const wh = createWebhook({
      ...parsed.data,
      events: parsed.data.events as PanelEventName[],
      createdBy: req.user!,
    });
    audit(req, 'webhook.created', {
      target: `webhook:${wh.id}`,
      metadata: { name: wh.name, type: wh.type, serverIds: wh.serverIds },
    });
    res.json({ webhook: wh });
  }),
);

router.put(
  '/:id',
  authMiddleware,
  requirePermission('webhooks.manage'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const parsed = upsertSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    const existing = await ownWebhook(req, res);
    if (!existing) return;
    const serverIds = parsed.data.serverIds ?? existing.serverIds;
    if (!(await acceptTarget(req, res, parsed.data, serverIds))) return;
    const data = { ...parsed.data, events: parsed.data.events as PanelEventName[] | undefined };
    const wh = updateWebhook(req.params.id, data);
    if (!wh) {
      res.status(404).json({ detail: 'Webhook not found' });
      return;
    }
    audit(req, 'webhook.updated', {
      target: `webhook:${wh.id}`,
      metadata: { serverIds: wh.serverIds },
    });
    res.json({ webhook: wh });
  }),
);

router.delete(
  '/:id',
  authMiddleware,
  requirePermission('webhooks.manage'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (!(await ownWebhook(req, res))) return;
    if (!deleteWebhook(req.params.id)) {
      res.status(404).json({ detail: 'Webhook not found' });
      return;
    }
    audit(req, 'webhook.deleted', { target: `webhook:${req.params.id}` });
    res.json({ success: true });
  }),
);

router.post(
  '/:id/test',
  authMiddleware,
  requirePermission('webhooks.manage'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (!(await ownWebhook(req, res))) return;
    try {
      const result = await testWebhook(req.params.id, req.user!);
      audit(req, 'webhook.tested', {
        target: `webhook:${req.params.id}`,
        metadata: { success: result.success },
      });
      res.json(result);
    } catch (err) {
      res.status(404).json({ detail: err instanceof Error ? err.message : 'Failed' });
    }
  }),
);

router.get(
  '/:id/deliveries',
  authMiddleware,
  requirePermission('webhooks.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (!(await ownWebhook(req, res))) return;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;
    const status = req.query.status as string | undefined;
    res.json(listDeliveries(req.params.id, { limit, cursor, status }));
  }),
);

export default router;
