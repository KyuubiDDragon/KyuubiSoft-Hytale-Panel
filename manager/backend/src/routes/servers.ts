/**
 * /api/servers — multi-server registry endpoints.
 *
 * Pure CRUD over the servers.json registry plus a default-server pointer
 * used by the legacy /api/server/* backward-compat proxy. POST /api/servers
 * now also creates (and optionally starts) the matching Docker container
 * via services/dockerImageManager.ts; DELETE removes it.
 *
 * Multiserver is gated by MULTISERVER_ENABLED (config.multiserverEnabled).
 * While the flag is off, creating servers and moving the default away from
 * the compose server are refused; listing and deleting extra servers stay
 * available so leftovers can be cleaned up.
 */
import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  listServers,
  getServer,
  createServerInstance,
  updateServerInstance,
  deleteServerInstance,
  getDefaultId,
  setDefaultId,
  isComposeServer,
  getDeleteBlockReason,
  type DeleteBlockReason,
} from '../services/servers.js';
import {
  createInstanceContainer,
  deleteInstanceContainer,
} from '../services/dockerImageManager.js';
import { audit } from '../services/audit.js';
import { config } from '../config.js';
import { z } from 'zod';

const router = Router();

const MULTISERVER_DISABLED = {
  detail:
    'Multiserver is disabled on this panel (set MULTISERVER_ENABLED=true to enable the experimental feature)',
  code: 'MULTISERVER_DISABLED',
} as const;

const DELETE_BLOCK_DETAIL: Record<Exclude<DeleteBlockReason, 'not_found'>, string> = {
  compose: 'The compose-stack server cannot be deleted',
  default: 'The default server cannot be deleted; make another server the default first',
  last: 'The last remaining server cannot be deleted',
};

router.get(
  '/',
  authMiddleware,
  requirePermission('servers.list'),
  async (_req: AuthenticatedRequest, res: Response) => {
    const servers = (await listServers()).map((s) => ({
      ...s,
      kind: isComposeServer(s) ? ('compose' as const) : ('managed' as const),
    }));
    res.json({
      servers,
      defaultId: await getDefaultId(),
      multiserverEnabled: config.multiserverEnabled,
    });
  },
);

router.get('/default', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  res.json({ defaultId: await getDefaultId() });
});

router.put(
  '/default',
  authMiddleware,
  requirePermission('servers.list'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.body as { id?: string };
    if (!id) {
      res.status(400).json({ detail: 'id required' });
      return;
    }
    if (!config.multiserverEnabled) {
      // Only allow pointing the default back at the compose server.
      const target = await getServer(id);
      if (!target || !isComposeServer(target)) {
        res.status(403).json(MULTISERVER_DISABLED);
        return;
      }
    }
    try {
      await setDefaultId(id);
      audit(req, 'server.default_changed', { target: `server:${id}` });
      res.json({ success: true, defaultId: id });
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed' });
    }
  },
);

router.get(
  '/:id',
  authMiddleware,
  requirePermission('servers.list'),
  async (req: AuthenticatedRequest, res: Response) => {
    const s = await getServer(req.params.id);
    if (!s) {
      res.status(404).json({ detail: 'Server not found' });
      return;
    }
    res.json({ server: s });
  },
);

// No containerName: the panel always generates it (hytale-srv-<id>). A
// client-supplied value is stripped by zod and ignored.
const createSchema = z.object({
  name: z.string().min(1).max(64),
  serverPort: z.number().int().min(1024).max(65535).optional(),
  webMapPort: z.number().int().min(1024).max(65535).optional(),
  webMapWsPort: z.number().int().min(1024).max(65535).optional(),
  pluginPort: z.number().int().min(1024).max(65535).optional(),
  autoStart: z.boolean().optional(),
  image: z.string().min(1).optional(),
});

router.post(
  '/',
  authMiddleware,
  requirePermission('servers.create'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!config.multiserverEnabled) {
      res.status(403).json(MULTISERVER_DISABLED);
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }
    const { autoStart, image, ...registryInput } = parsed.data;
    const instance = await createServerInstance({ ...registryInput, createdBy: req.user! });

    // Best-effort container creation. We always 200 on the registry write —
    // container errors are surfaced via the `container` field so the UI can
    // show the registry entry even if Docker barked.
    const containerResult = await createInstanceContainer(instance, { autoStart, image });
    if (containerResult.ok) {
      audit(req, 'server.container_created', {
        target: `server:${instance.id}`,
        metadata: {
          name: instance.name,
          containerId: containerResult.containerId,
          started: containerResult.started,
        },
      });
      res.json({
        server: { ...instance, status: 'ready' as const },
        container: { id: containerResult.containerId, started: containerResult.started },
      });
    } else {
      audit(req, 'server.container_created', {
        target: `server:${instance.id}`,
        metadata: { name: instance.name, error: containerResult.error },
        success: false,
      });
      res.status(201).json({
        server: { ...instance, status: 'broken' as const },
        container: { error: containerResult.error },
      });
    }
  },
);

router.put(
  '/:id',
  authMiddleware,
  requirePermission('servers.create'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { name, status } = req.body as {
      name?: string;
      status?: 'ready' | 'creating' | 'broken';
    };
    const updated = await updateServerInstance(req.params.id, { name, status });
    if (!updated) {
      res.status(404).json({ detail: 'Server not found' });
      return;
    }
    audit(req, 'server.instance_updated', { target: `server:${req.params.id}` });
    res.json({ server: updated });
  },
);

const isTrueFlag = (v: unknown): boolean => v === 'true' || v === '1';

router.delete(
  '/:id',
  authMiddleware,
  requirePermission('servers.delete'),
  async (req: AuthenticatedRequest, res: Response) => {
    const removeData = isTrueFlag(req.query.removeData);
    // keepContainer: drop only the registry entry and leave the container
    // alone — the way out for entries whose container the panel won't touch.
    const keepContainer = isTrueFlag(req.query.keepContainer);
    const id = req.params.id;

    // Registry policy first: nothing may happen to any container unless the
    // entry is actually deletable.
    const blocked = await getDeleteBlockReason(id);
    if (blocked === 'not_found') {
      res.status(404).json({ detail: 'Server not found' });
      return;
    }
    if (blocked) {
      res.status(409).json({
        detail: DELETE_BLOCK_DETAIL[blocked],
        code: 'SERVER_NOT_DELETABLE',
        reason: blocked,
      });
      return;
    }
    const instance = (await getServer(id))!;

    // Tear down the container before the registry entry so we don't leave an
    // orphan running with ports bound and no entry pointing at it.
    if (!keepContainer) {
      const containerResult = await deleteInstanceContainer(instance, { removeData });
      if (!containerResult.ok) {
        audit(req, 'server.container_deleted', {
          target: `server:${id}`,
          metadata: {
            containerName: instance.containerName,
            code: containerResult.code,
            error: containerResult.error,
          },
          success: false,
        });
        const notManaged = containerResult.code === 'not_managed';
        res.status(notManaged ? 409 : 502).json({
          detail: containerResult.error,
          code: notManaged ? 'CONTAINER_NOT_MANAGED' : 'CONTAINER_REMOVE_FAILED',
          containerName: instance.containerName,
        });
        return;
      }
    }

    const ok = await deleteServerInstance(id);
    if (!ok) {
      res.status(409).json({ detail: 'Cannot delete server', code: 'SERVER_NOT_DELETABLE' });
      return;
    }
    audit(req, 'server.container_deleted', {
      target: `server:${id}`,
      metadata: { containerName: instance.containerName, containerKept: keepContainer },
    });
    res.json({ success: true, container: keepContainer ? { ok: true, kept: true } : { ok: true } });
  },
);

export default router;
