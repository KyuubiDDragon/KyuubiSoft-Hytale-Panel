/**
 * /api/servers — multi-server registry endpoints.
 *
 * Pure CRUD over the servers.json registry plus a default-server pointer
 * used by the legacy /api/server/* backward-compat proxy. POST /api/servers
 * now also creates (and optionally starts) the matching Docker container
 * via services/dockerImageManager.ts; DELETE removes it.
 */
import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  listServers, getServer, createServerInstance, updateServerInstance,
  deleteServerInstance, getDefaultId, setDefaultId,
} from '../services/servers.js';
import { createInstanceContainer, deleteInstanceContainer } from '../services/dockerImageManager.js';
import { audit } from '../services/audit.js';
import { z } from 'zod';

const router = Router();

router.get('/', authMiddleware, requirePermission('servers.list'), async (_req: AuthenticatedRequest, res: Response) => {
  res.json({ servers: await listServers(), defaultId: await getDefaultId() });
});

router.get('/default', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  res.json({ defaultId: await getDefaultId() });
});

router.put('/default', authMiddleware, requirePermission('servers.list'), async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.body as { id?: string };
  if (!id) { res.status(400).json({ detail: 'id required' }); return; }
  try {
    await setDefaultId(id);
    audit(req, 'server.default_changed', { target: `server:${id}` });
    res.json({ success: true, defaultId: id });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed' });
  }
});

router.get('/:id', authMiddleware, requirePermission('servers.list'), async (req: AuthenticatedRequest, res: Response) => {
  const s = await getServer(req.params.id);
  if (!s) { res.status(404).json({ detail: 'Server not found' }); return; }
  res.json({ server: s });
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  containerName: z.string().min(1).optional(),
  serverPort: z.number().int().min(1024).max(65535).optional(),
  webMapPort: z.number().int().min(1024).max(65535).optional(),
  webMapWsPort: z.number().int().min(1024).max(65535).optional(),
  pluginPort: z.number().int().min(1024).max(65535).optional(),
  autoStart: z.boolean().optional(),
  image: z.string().min(1).optional(),
});

router.post('/', authMiddleware, requirePermission('servers.create'), async (req: AuthenticatedRequest, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
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
      metadata: { name: instance.name, containerId: containerResult.containerId, started: containerResult.started },
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
});

router.put('/:id', authMiddleware, requirePermission('servers.create'), async (req: AuthenticatedRequest, res: Response) => {
  const { name, status } = req.body as { name?: string; status?: 'ready' | 'creating' | 'broken' };
  const updated = await updateServerInstance(req.params.id, { name, status });
  if (!updated) { res.status(404).json({ detail: 'Server not found' }); return; }
  audit(req, 'server.instance_updated', { target: `server:${req.params.id}` });
  res.json({ server: updated });
});

router.delete('/:id', authMiddleware, requirePermission('servers.delete'), async (req: AuthenticatedRequest, res: Response) => {
  const removeData = req.query.removeData === 'true' || req.query.removeData === '1';
  const instance = await getServer(req.params.id);
  if (!instance) { res.status(404).json({ detail: 'Server not found' }); return; }

  // Tear down the container first so we don't leave an orphan running with
  // ports bound when the registry entry has already disappeared.
  const containerResult = await deleteInstanceContainer(instance, { removeData });
  const ok = await deleteServerInstance(req.params.id);
  if (!ok) {
    res.status(409).json({ detail: 'Cannot delete server (last remaining or not found)' });
    return;
  }
  audit(req, 'server.container_deleted', {
    target: `server:${req.params.id}`,
    metadata: { containerOk: containerResult.ok, error: containerResult.ok ? undefined : containerResult.error },
    success: containerResult.ok,
  });
  res.json({ success: true, container: containerResult });
});

export default router;
