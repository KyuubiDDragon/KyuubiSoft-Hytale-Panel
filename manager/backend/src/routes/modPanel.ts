/**
 * Mod status page: status snapshots and admin actions that KS mods register
 * with the KyuubiSoft API plugin (`PanelRegistry`), proxied per server.
 *
 *   GET  /api/mod-panel                              providers (mods.panel.view)
 *   GET  /api/mod-panel/:id                          snapshot  (mods.panel.view)
 *   POST /api/mod-panel/:id/actions/:actionId        run       (mods.panel.action, audited;
 *                                                    dangerous ones also console.execute.admin)
 *
 * Also mounted under /api/servers/:serverId/mod-panel. Everything the plugin
 * returns is validated (schemas/modPanel.ts); mod text reaches the frontend as
 * plain strings only.
 */
import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as kyuubiApi from '../services/kyuubiApi.js';
import { audit } from '../services/audit.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import { logger } from '../utils/logger.js';
import { actorFromRequest, holdsCommandTier } from '../services/commandPolicy.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  MOD_PANEL_ACTION_ID,
  MOD_PANEL_PROVIDER_ID,
  ModPanelActionRequestSchema,
  ModPanelActionResultSchema,
  ModPanelListSchema,
  ModPanelSnapshotResponseSchema,
  type ModPanelProvider,
} from '../schemas/modPanel.js';

const router = Router();

/** Why the mod panel cannot be shown; the page explains each case. */
export type ModPanelUnavailableReason =
  'offline' | 'auth' | 'unsupported' | 'unavailable' | 'error';

const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/;
const MAX_AUDITED_PARAM_LENGTH = 200;
// Parameter names whose values must not end up in the audit log in clear text.
const SECRET_PARAM = /passw(or)?d|passphrase|secret|token|api[_.-]?key|credential|webhook|url/i;

/** UI language from ?locale= / body.locale, else the browser's first Accept-Language tag. */
function callerOf(req: AuthenticatedRequest, explicitLocale?: unknown): kyuubiApi.ModPanelCaller {
  const candidates = [
    explicitLocale,
    req.query.locale,
    String(req.headers['accept-language'] ?? '')
      .split(/[,;]/)[0]
      ?.trim(),
  ];
  const locale = candidates.find((c): c is string => typeof c === 'string' && LOCALE.test(c));
  return { actor: req.user, locale };
}

function unavailableReason(r: kyuubiApi.ModPanelPluginResponse): ModPanelUnavailableReason {
  if (r.authError) return 'auth';
  if (r.status === 0) return 'offline';
  const code = (r.body as { code?: unknown } | null)?.code;
  if (r.status === 503 && code === 'mod_panel_unavailable') return 'unavailable';
  // Plugin without the registry: its generic router answers 404 without our code.
  if (r.status === 404 && code !== 'not_found') return 'unsupported';
  return 'error';
}

function pluginError(r: kyuubiApi.ModPanelPluginResponse): string {
  const message = (r.body as { error?: unknown } | null)?.error;
  return typeof message === 'string' ? message.slice(0, 300) : (r.error ?? `HTTP ${r.status}`);
}

function sendInvalid(res: Response, what: string, issues: string): void {
  logger.warn(`[ModPanel] invalid ${what} from plugin: ${issues}`);
  res.status(502).json({ error: 'Invalid response from the KyuubiSoft API plugin' });
}

// GET /api/mod-panel - registered providers
router.get(
  '/',
  authMiddleware,
  requirePermission('mods.panel.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const r = await kyuubiApi.getModPanelProviders(req.serverId, callerOf(req));
    if (!r.ok) {
      res.json({
        available: false,
        reason: unavailableReason(r),
        error: pluginError(r),
        ...(r.authError ? { authError: r.authError } : {}),
        providers: [],
      });
      return;
    }
    const parsed = ModPanelListSchema.safeParse(r.body);
    if (!parsed.success) return sendInvalid(res, 'provider list', parsed.error.message);
    res.json({ available: true, ...parsed.data });
  }),
);

// GET /api/mod-panel/:id - one provider's snapshot
router.get(
  '/:id',
  authMiddleware,
  requirePermission('mods.panel.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    if (!MOD_PANEL_PROVIDER_ID.test(id)) {
      res.status(400).json({ error: 'Invalid provider id' });
      return;
    }
    const r = await kyuubiApi.getModPanelSnapshot(id, req.serverId, callerOf(req));
    if (!r.ok) {
      const reason = unavailableReason(r);
      if (r.status === 404 && reason === 'error') {
        res.status(404).json({ error: 'Unknown mod provider' });
        return;
      }
      res.status(502).json({ error: pluginError(r), reason });
      return;
    }
    const parsed = ModPanelSnapshotResponseSchema.safeParse(r.body);
    if (!parsed.success) return sendInvalid(res, 'snapshot', parsed.error.message);
    res.json(parsed.data);
  }),
);

/** Params as written to the audit log: plain values, long text clipped, secrets masked. */
function auditedParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (SECRET_PARAM.test(key) && value !== null && value !== '') out[key] = '***';
    else out[key] = typeof value === 'string' ? value.slice(0, MAX_AUDITED_PARAM_LENGTH) : value;
  }
  return out;
}

type DeclaredAction =
  | { kind: 'found'; action: ModPanelProvider['actions'][number] }
  | { kind: 'refused'; status: string; httpStatus: number; body: Record<string, unknown> };

/**
 * The action as the plugin declares it. Whether an action is dangerous comes
 * from this list, never from the client.
 */
async function declaredAction(
  req: AuthenticatedRequest,
  id: string,
  actionId: string,
): Promise<DeclaredAction> {
  const r = await kyuubiApi.getModPanelProviders(req.serverId, callerOf(req));
  if (!r.ok) {
    const code = (r.body as { code?: unknown } | null)?.code;
    return {
      kind: 'refused',
      status: typeof code === 'string' ? code : `http_${r.status}`,
      httpStatus: 502,
      body: { error: pluginError(r), reason: unavailableReason(r) },
    };
  }
  const parsed = ModPanelListSchema.safeParse(r.body);
  if (!parsed.success) {
    logger.warn(`[ModPanel] invalid provider list from plugin: ${parsed.error.message}`);
    return {
      kind: 'refused',
      status: 'invalid_response',
      httpStatus: 502,
      body: { error: 'Invalid response from the KyuubiSoft API plugin' },
    };
  }
  const action = parsed.data.providers
    .find((p) => p.id === id)
    ?.actions.find((a) => a.id === actionId);
  if (!action) {
    return {
      kind: 'refused',
      status: 'not_found',
      httpStatus: 404,
      body: { error: 'Unknown mod provider or action' },
    };
  }
  return { kind: 'found', action };
}

// POST /api/mod-panel/:id/actions/:actionId - run an admin action
router.post(
  '/:id/actions/:actionId',
  authMiddleware,
  requirePermission('mods.panel.action'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { id, actionId } = req.params;
    if (!MOD_PANEL_PROVIDER_ID.test(id) || !MOD_PANEL_ACTION_ID.test(actionId)) {
      res.status(400).json({ error: 'Invalid provider or action id' });
      return;
    }
    const body = ModPanelActionRequestSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'Invalid request', details: body.error.issues });
      return;
    }
    const target = `mod:${id}/${actionId}`;
    const metadata = {
      serverId: req.serverId ?? null,
      params: auditedParams(body.data.params),
      confirmed: body.data.confirmed === true,
    };

    // SECURITY: mod actions run inside the game server with full rights. One
    // the mod marks dangerous (wipe data, grant rights, …) is treated like an
    // admin console command: it needs console.execute.admin on the target
    // server on top of mods.panel.action.
    const declared = await declaredAction(req, id, actionId);
    if (declared.kind === 'refused') {
      audit(req, 'mod_panel.action', {
        target,
        metadata: { ...metadata, status: declared.status },
        success: false,
      });
      res.status(declared.httpStatus).json(declared.body);
      return;
    }
    if (
      declared.action.dangerous &&
      !(await holdsCommandTier(actorFromRequest(req), 'console.execute.admin', req.serverId))
    ) {
      audit(req, 'mod_panel.action', {
        target,
        metadata: { ...metadata, status: 'admin_required' },
        success: false,
      });
      res.status(403).json({
        error: 'The mod marks this action as dangerous: it also needs console.execute.admin',
        code: 'admin_required',
      });
      return;
    }

    const r = await kyuubiApi.runModPanelAction(
      id,
      actionId,
      { params: body.data.params, confirmed: body.data.confirmed },
      req.serverId,
      callerOf(req, body.data.locale),
    );

    if (!r.ok) {
      const code = (r.body as { code?: unknown } | null)?.code;
      const error = pluginError(r);
      audit(req, 'mod_panel.action', {
        target,
        metadata: {
          ...metadata,
          status: typeof code === 'string' ? code : `http_${r.status}`,
          error,
        },
        success: false,
      });
      if (r.status === 400 || r.status === 409) {
        res.status(r.status).json({ error, ...(typeof code === 'string' ? { code } : {}) });
      } else if (r.status === 404 && code === 'not_found') {
        res.status(404).json({ error: 'Unknown mod provider or action' });
      } else {
        res.status(502).json({ error, reason: unavailableReason(r) });
      }
      return;
    }

    const parsed = ModPanelActionResultSchema.safeParse(r.body);
    if (!parsed.success) {
      audit(req, 'mod_panel.action', {
        target,
        metadata: { ...metadata, status: 'invalid_response' },
        success: false,
      });
      return sendInvalid(res, 'action result', parsed.error.message);
    }
    audit(req, 'mod_panel.action', {
      target,
      metadata: {
        ...metadata,
        status: parsed.data.status,
        message: parsed.data.message ?? null,
        durationMs: parsed.data.durationMs ?? null,
      },
      success: parsed.data.success,
    });
    res.json(parsed.data);
  }),
);

export default router;
