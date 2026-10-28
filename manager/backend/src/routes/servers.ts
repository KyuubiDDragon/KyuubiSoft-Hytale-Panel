/**
 * /api/servers — multi-server registry endpoints.
 *
 * CRUD over the servers.json registry plus a default-server pointer used by
 * the legacy /api/server/* backward-compat proxy. POST /api/servers also
 * creates (and optionally starts) the matching Docker container via
 * services/dockerImageManager.ts; DELETE removes it and, on request, moves
 * the server's folder to the trash (services/instanceData.ts).
 *
 * Multiserver is gated by MULTISERVER_ENABLED (config.multiserverEnabled).
 * While the flag is off, creating servers and moving the default away from
 * the compose server are refused; listing and deleting extra servers stay
 * available so leftovers can be cleaned up.
 *
 * Paths starting with `_` are panel routes, never server ids.
 */
import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  requirePermission,
  filterAccessibleServers,
  requireServerAccess,
  requireAllServerAccess,
} from '../middleware/permissions.js';
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
  notifyServerAdded,
  type DeleteBlockReason,
  type ServerInstance,
} from '../services/servers.js';
import {
  checkHeapFitsLimit,
  createInstanceContainer,
  deleteInstanceContainer,
  instanceHostRoot,
  resolveInstanceTemplate,
  updateInstanceLimits,
  type DeleteResult,
  type InstanceTemplate,
  type LimitsUpdateResult,
} from '../services/dockerImageManager.js';
import {
  checkInstanceDataMovable,
  getServerFilesState,
  listInstanceTrash,
  moveInstanceToTrash,
  prepareInstanceDirs,
  purgeInstanceTrashEntry,
  readPanelJavaMaxRam,
} from '../services/instanceData.js';
import {
  allocateInstancePorts,
  withPortLock,
  GAME_PORT_MAX,
  type PortAllocation,
} from '../services/portAllocator.js';
import { reconcileServers } from '../services/serverReconcile.js';
import { stopServerAndRun } from '../services/serverLifecycle.js';
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function invalidBody(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'invalid_body',
    detail: 'Invalid request',
    issues: error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  });
}

/** Express 4 does not catch rejected handlers; answer 500 instead of hanging. */
function internalError(res: Response, where: string, err: unknown): void {
  console.error(`[servers] ${where} failed:`, err);
  if (!res.headersSent) res.status(500).json({ detail: errorText(err), code: 'INTERNAL_ERROR' });
}

/**
 * Registry entry plus what the panel sees right now. `state` is
 * `waiting_for_files` when the container is set up but the game files are
 * missing: the entrypoint then waits for them instead of starting a server.
 */
async function describeServer(s: ServerInstance) {
  const files = await getServerFilesState(s);
  return {
    ...s,
    kind: isComposeServer(s) ? ('compose' as const) : ('managed' as const),
    files,
    state: s.status === 'ready' && files === 'missing' ? ('waiting_for_files' as const) : s.status,
  };
}

router.get(
  '/',
  authMiddleware,
  requirePermission('servers.list'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      // Only the servers the caller may use (user and API-key server lists).
      const visible = await filterAccessibleServers(req, await listServers());
      res.json({
        servers: await Promise.all(visible.map(describeServer)),
        defaultId: await getDefaultId(),
        multiserverEnabled: config.multiserverEnabled,
      });
    } catch (err) {
      internalError(res, 'GET /', err);
    }
  },
);

// ------------------------------------------------------------------
// Default pointer
// ------------------------------------------------------------------

async function getDefaultPointer(_req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    res.json({ defaultId: await getDefaultId() });
  } catch (err) {
    internalError(res, 'GET default', err);
  }
}

async function putDefaultPointer(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { id } = (req.body ?? {}) as { id?: unknown };
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ detail: 'id required' });
    return;
  }
  try {
    const target = await getServer(id);
    if (!target) {
      res.status(400).json({ detail: 'Unknown server id' });
      return;
    }
    // Every server-bound route resolves the request's server, so the default
    // only decides where the legacy routes go. Setup and first-run install
    // stay on the compose server either way.
    if (!isComposeServer(target) && !config.multiserverEnabled) {
      res.status(403).json(MULTISERVER_DISABLED);
      return;
    }
    await setDefaultId(id);
    audit(req, 'server.default_changed', { target: `server:${id}` });
    res.json({ success: true, defaultId: id });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed' });
  }
}

router.get('/_default', authMiddleware, requirePermission('servers.list'), getDefaultPointer);
// Moving the default retargets every user's legacy routes: callers with every server only.
router.put(
  '/_default',
  authMiddleware,
  requirePermission('servers.manage'),
  requireAllServerAccess(),
  putDefaultPointer,
);

// Older clients use /default for the pointer, which hides the compose server
// (id "default") from /:id. A GET, and a PUT with an `id`, stay the pointer;
// a PUT without `id` edits the compose server like PUT /:id.
router.get('/default', authMiddleware, requirePermission('servers.list'), getDefaultPointer);
router.put(
  '/default',
  (req, _res, next) => {
    if (req.body && typeof req.body === 'object' && 'id' in req.body) next();
    else next('route');
  },
  authMiddleware,
  requirePermission('servers.manage'),
  requireAllServerAccess(),
  putDefaultPointer,
);

// ------------------------------------------------------------------
// Reconcile and trash (before /:id so the names never read as ids)
// ------------------------------------------------------------------

router.post(
  '/_reconcile',
  authMiddleware,
  requirePermission('servers.manage'),
  requireAllServerAccess(),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const report = await reconcileServers();
      audit(req, 'server.reconciled', {
        metadata: { changes: report.changes.length, orphans: report.orphans.length },
      });
      res.json(report);
    } catch (err) {
      res.status(502).json({ detail: errorText(err), code: 'DOCKER_UNAVAILABLE' });
    }
  },
);

router.get(
  '/_trash',
  authMiddleware,
  requirePermission('servers.delete'),
  requireAllServerAccess(),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      res.json({ entries: await listInstanceTrash() });
    } catch (err) {
      internalError(res, 'GET /_trash', err);
    }
  },
);

const PURGE_FAILURE = {
  invalid: 400,
  not_found: 404,
  unavailable: 409,
  failed: 500,
} as const;

/**
 * The only way instance files are deleted for good. `?confirm=<entry>` must
 * repeat the entry name, so a stray request cannot purge anything.
 */
router.delete(
  '/_trash/:entry',
  authMiddleware,
  requirePermission('servers.delete'),
  requireAllServerAccess(),
  async (req: AuthenticatedRequest, res: Response) => {
    const entry = req.params.entry;
    if (req.query.confirm !== entry) {
      res.status(400).json({
        detail: 'Repeat the trash entry name in ?confirm= to delete it permanently',
        code: 'CONFIRMATION_REQUIRED',
      });
      return;
    }
    try {
      const result = await purgeInstanceTrashEntry(entry);
      audit(req, 'server.trash_purged', {
        metadata: { entry, ...(result.ok ? {} : { error: result.error }) },
        success: result.ok,
      });
      if (!result.ok) {
        res
          .status(PURGE_FAILURE[result.code])
          .json({ detail: result.error, code: 'TRASH_PURGE_FAILED' });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      internalError(res, 'DELETE /_trash/:entry', err);
    }
  },
);

router.get(
  '/:id',
  authMiddleware,
  requirePermission('servers.list'),
  requireServerAccess('id'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const s = await getServer(req.params.id);
      if (!s) {
        res.status(404).json({ detail: 'Server not found' });
        return;
      }
      res.json({ server: await describeServer(s) });
    } catch (err) {
      internalError(res, 'GET /:id', err);
    }
  },
);

// ------------------------------------------------------------------
// Create
// ------------------------------------------------------------------

const MIN_MEMORY_BYTES = 512 * 1024 * 1024;

const limitsSchema = z
  .object({
    memory: z.number().int().min(MIN_MEMORY_BYTES).optional(),
    cpus: z.number().min(0.1).max(1024).optional(),
  })
  .strict();

const mapPortSchema = z.number().int().min(1024).max(65535);

// No containerName: the panel always generates it (hytale-srv-<id>). No
// plugin port: the plugin listens on 18085 inside the container and is never
// published. Unknown keys are dropped.
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    serverPort: z.number().int().min(1024).max(GAME_PORT_MAX).optional(),
    webMapPort: mapPortSchema.optional(),
    webMapWsPort: mapPortSchema.optional(),
    autoStart: z.boolean().optional(),
    limits: limitsSchema.optional(),
    // The panel picks the image (primary container or HYTALE_IMAGE). Only
    // read to refuse a different one instead of silently ignoring it.
    image: z.string().optional(),
  })
  .refine((b) => b.webMapPort === undefined || b.webMapPort !== b.webMapWsPort, {
    message: 'webMapPort and webMapWsPort must differ',
    path: ['webMapWsPort'],
  });

type CreateBody = z.infer<typeof createSchema>;

interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

function portFailure(allocation: Exclude<PortAllocation, { ok: true }>): Outcome {
  switch (allocation.code) {
    case 'conflict':
      return {
        status: 409,
        body: {
          detail: allocation.conflicts
            .map((c) => `${c.field} ${c.port}/${c.proto} is already used by ${c.owner}`)
            .join('; '),
          code: 'PORT_CONFLICT',
          conflicts: allocation.conflicts,
        },
      };
    case 'exhausted':
      return {
        status: 409,
        body: { detail: `No free host port left for ${allocation.field}`, code: 'NO_FREE_PORT' },
      };
    case 'docker_unavailable':
      return {
        status: 503,
        body: {
          detail: `Cannot check the host ports, Docker is not reachable: ${allocation.error}`,
          code: 'DOCKER_UNAVAILABLE',
        },
      };
  }
}

/** What the operator has to know before the new server can actually run. */
function setupHints(instance: ServerInstance, template: InstanceTemplate): string[] {
  const serverDir = `${instanceHostRoot(instance)}/server`;
  if (template.env.USE_HYTALE_DOWNLOADER === 'true') {
    return [
      'The new server downloads the game files on its first start. The Hytale downloader needs ' +
        "a login for it: follow the link in the new server's console.",
    ];
  }
  return [
    `The new server has no game files yet and the Hytale downloader is off (USE_HYTALE_DOWNLOADER). ` +
      `It waits until HytaleServer.jar and Assets.zip are in ${serverDir}.`,
  ];
}

async function provisionServer(body: CreateBody, actor: string): Promise<Outcome> {
  const { autoStart, image, limits, name, ...ports } = body;
  const resolved = await resolveInstanceTemplate();
  if (!resolved.ok) {
    return { status: 503, body: { detail: resolved.error, code: 'INSTANCE_TEMPLATE_UNAVAILABLE' } };
  }
  const template = resolved.template;
  if (image !== undefined && image !== template.image && image !== template.imageName) {
    return {
      status: 400,
      body: {
        detail: `The image cannot be chosen per server; new servers use "${template.imageName ?? template.image}" (set HYTALE_IMAGE to change it)`,
        code: 'IMAGE_NOT_SELECTABLE',
      },
    };
  }
  // A new server has no panel settings yet: it starts with the inherited heap.
  const heapProblem = limits?.memory
    ? checkHeapFitsLimit(template.env.JAVA_MAX_RAM, limits.memory)
    : null;
  if (heapProblem) {
    return { status: 400, body: { detail: heapProblem, code: 'MEMORY_LIMIT_TOO_SMALL' } };
  }

  const allocation = await allocateInstancePorts(ports, await listServers());
  if (!allocation.ok) return portFailure(allocation);

  const instance = await createServerInstance({
    name,
    ...allocation.ports,
    ...(limits ? { limits } : {}),
    createdBy: actor,
  });
  const dirWarning = await prepareInstanceDirs(instance);
  const result = await createInstanceContainer(instance, { autoStart, template });
  const server = await describeServer((await getServer(instance.id)) ?? instance);
  const warnings = [...template.warnings, ...(dirWarning ? [dirWarning] : [])];
  if (!result.ok) {
    return {
      status: 502,
      body: {
        detail: result.error,
        code: result.code === 'start' ? 'CONTAINER_START_FAILED' : 'CONTAINER_CREATE_FAILED',
        server,
        container: { error: result.error },
        warnings,
      },
    };
  }
  await notifyServerAdded(instance.id);
  return {
    status: 201,
    body: {
      server,
      container: { id: result.containerId, started: result.started, image: result.image },
      warnings: [...warnings, ...setupHints(instance, template)],
    },
  };
}

router.post(
  '/',
  authMiddleware,
  requirePermission('servers.create'),
  requireAllServerAccess(),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!config.multiserverEnabled) {
      res.status(403).json(MULTISERVER_DISABLED);
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    try {
      // One create at a time: two requests must not pick the same free port.
      const outcome = await withPortLock(() => provisionServer(parsed.data, req.user!));
      const server = outcome.body.server as { id?: string; name?: string } | undefined;
      if (server?.id) {
        audit(req, 'server.container_created', {
          target: `server:${server.id}`,
          metadata: {
            name: server.name,
            ...(outcome.status === 201 ? { container: outcome.body.container } : {}),
            ...(outcome.status === 201 ? {} : { error: outcome.body.detail }),
          },
          success: outcome.status === 201,
        });
      }
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      internalError(res, 'POST /', err);
    }
  },
);

// ------------------------------------------------------------------
// Update
// ------------------------------------------------------------------

const LIMITS_FAILURE: Record<
  Exclude<LimitsUpdateResult, { ok: true }>['code'],
  { status: number; code: string }
> = {
  not_found: { status: 409, code: 'CONTAINER_MISSING' },
  not_managed: { status: 409, code: 'CONTAINER_NOT_MANAGED' },
  heap: { status: 400, code: 'MEMORY_LIMIT_TOO_SMALL' },
  docker_error: { status: 502, code: 'CONTAINER_UPDATE_FAILED' },
};

// Status, ports, paths and image are the panel's to set; only these may change.
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    limits: limitsSchema.optional(),
  })
  .strict();

router.put(
  '/:id',
  authMiddleware,
  requirePermission('servers.manage'),
  requireServerAccess('id'),
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    try {
      const current = await getServer(req.params.id);
      if (!current) {
        res.status(404).json({ detail: 'Server not found' });
        return;
      }
      const { name, limits } = parsed.data;
      if (limits) {
        if (isComposeServer(current)) {
          res.status(409).json({
            detail:
              "The compose server's limits are set in docker-compose.yml (DOCKER_MEMORY_LIMIT, DOCKER_CPU_LIMIT)",
            code: 'COMPOSE_LIMITS',
          });
          return;
        }
        const applied = await updateInstanceLimits(current, limits, {
          panelMaxRam: await readPanelJavaMaxRam(current),
        });
        if (!applied.ok) {
          const { status, code } = LIMITS_FAILURE[applied.code];
          res.status(status).json({ detail: applied.error, code });
          return;
        }
      }
      const updated = await updateServerInstance(current.id, {
        name,
        ...(limits ? { limits: { ...current.limits, ...limits } } : {}),
      });
      if (!updated) {
        res.status(404).json({ detail: 'Server not found' });
        return;
      }
      audit(req, 'server.instance_updated', {
        target: `server:${current.id}`,
        metadata: { ...(name ? { name } : {}), ...(limits ? { limits } : {}) },
      });
      res.json({ server: await describeServer(updated) });
    } catch (err) {
      internalError(res, 'PUT /:id', err);
    }
  },
);

// ------------------------------------------------------------------
// Delete
// ------------------------------------------------------------------

const isTrueFlag = (v: unknown): boolean => v === 'true' || v === '1';

const DELETE_FAILURE: Record<
  Exclude<DeleteResult, { ok: true }>['code'],
  { status: number; code: string }
> = {
  not_managed: { status: 409, code: 'CONTAINER_NOT_MANAGED' },
  // The server could not be stopped or another operation runs on it.
  stop_failed: { status: 409, code: 'SERVER_STOP_FAILED' },
  docker_error: { status: 502, code: 'CONTAINER_REMOVE_FAILED' },
};

const DATA_CHECK_FAILURE = {
  layout: 'INSTANCE_DATA_LAYOUT',
  unavailable: 'INSTANCE_DATA_UNAVAILABLE',
} as const;

router.delete(
  '/:id',
  authMiddleware,
  requirePermission('servers.delete'),
  requireServerAccess('id'),
  async (req: AuthenticatedRequest, res: Response) => {
    // removeData: move the server's folder to the trash (never deleted here).
    const removeData = isTrueFlag(req.query.removeData);
    // keepContainer: drop only the registry entry and leave the container
    // alone — the way out for entries whose container the panel won't touch.
    const keepContainer = isTrueFlag(req.query.keepContainer);
    const id = req.params.id;
    if (removeData && keepContainer) {
      res.status(400).json({
        detail:
          'removeData and keepContainer cannot be combined: a kept container still uses the folder',
        code: 'INVALID_DELETE_OPTIONS',
      });
      return;
    }

    try {
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

      // Before anything is stopped: the data step must be possible at all.
      if (removeData) {
        const check = await checkInstanceDataMovable(instance);
        if (!check.ok) {
          res.status(409).json({ detail: check.error, code: DATA_CHECK_FAILURE[check.code] });
          return;
        }
      }

      // Tear down the container before the registry entry so we don't leave an
      // orphan running with ports bound and no entry pointing at it.
      if (!keepContainer) {
        const containerResult = await deleteInstanceContainer(instance, {
          // A running server saves through `/stop` like every other stop path,
          // and nothing else (restore, rollback) runs on it while it is removed.
          whileStopped: (remove) =>
            stopServerAndRun(id, { reason: 'delete', actor: req.user, rejectIfBusy: true }, remove),
        });
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
          const { status, code } = DELETE_FAILURE[containerResult.code];
          res.status(status).json({
            detail: containerResult.error,
            code,
            containerName: instance.containerName,
          });
          return;
        }
      }

      let data: Record<string, unknown> = { kept: true, hostPath: instanceHostRoot(instance) };
      if (removeData) {
        const moved = await moveInstanceToTrash(instance);
        if (!moved.ok) {
          // The container is gone, the entry stays: deleting again retries the move.
          await updateServerInstance(id, { status: 'broken' });
          audit(req, 'server.data_trashed', {
            target: `server:${id}`,
            metadata: { error: moved.error },
            success: false,
          });
          res.status(500).json({ detail: moved.error, code: 'INSTANCE_DATA_MOVE_FAILED' });
          return;
        }
        data = { trashEntry: moved.entry, hostPath: moved.hostPath };
        audit(req, 'server.data_trashed', { target: `server:${id}`, metadata: data });
      }

      const ok = await deleteServerInstance(id);
      if (!ok) {
        res
          .status(409)
          .json({ detail: 'Cannot delete server', code: 'SERVER_NOT_DELETABLE', data });
        return;
      }
      audit(req, 'server.container_deleted', {
        target: `server:${id}`,
        metadata: { containerName: instance.containerName, containerKept: keepContainer },
      });
      res.json({
        success: true,
        container: keepContainer ? { ok: true, kept: true } : { ok: true },
        data,
      });
    } catch (err) {
      internalError(res, 'DELETE /:id', err);
    }
  },
);

export default router;
