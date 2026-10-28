/**
 * Which servers a user or an API key may use.
 *
 *   GET /api/auth/me/servers               — the caller's own servers
 *   GET /api/auth/users/:username/servers  — users.view
 *   PUT /api/auth/users/:username/servers  — users.edit
 *   GET /api/auth/api-keys/:id/servers     — apikeys.manage, own keys
 *   PUT /api/auth/api-keys/:id/servers     — apikeys.manage, own keys
 *
 * The lists only narrow access: null = every server (for a key: every server
 * its owner may use). Admins ('*') ignore their own list. Nobody hands out a
 * server they cannot use themselves, and a caller with a server list only
 * changes accounts that stay inside its own servers.
 */
import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  requirePermission,
  accessibleServerIds,
  effectivePermissions,
} from '../middleware/permissions.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { getUser, allowedServersOf, setUserAllowedServers } from '../services/users.js';
import { getUserPermissions } from '../services/roles.js';
import { getOwnApiKey, setApiKeyServerIds } from '../services/apiKeys.js';
import { installServerListCleanup } from '../services/serverLists.js';
import {
  checkAccountWithinCaller,
  checkServersWithinCaller,
  readServerList,
} from '../services/accountPolicy.js';
import { isDemoMode } from '../services/demoData.js';
import { audit } from '../services/audit.js';

const router = Router();

// Also installed explicitly at startup; idempotent.
installServerListCleanup();

/** The servers the caller may use: its own list narrowed by its API key's. */
router.get(
  '/me/servers',
  authMiddleware,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const ids = await accessibleServerIds(req);
    res.json({ allowedServers: ids, unrestricted: ids === null });
  }),
);

router.get(
  '/users/:username/servers',
  authMiddleware,
  requirePermission('users.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const target = await getUser(req.params.username);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const allowedServers = allowedServersOf(target);
    const isAdmin = (await getUserPermissions(target.username)).includes('*');
    res.json({
      username: target.username,
      allowedServers,
      // An admin role ignores the list (it is kept for a later demotion).
      unrestricted: isAdmin || allowedServers === null,
    });
  }),
);

router.put(
  '/users/:username/servers',
  authMiddleware,
  requirePermission('users.edit'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Servers updated (simulated)' });
      return;
    }
    const list = await readServerList(req.body, 'allowedServers');
    if (!list.ok) {
      res.status(list.status).json(list.body);
      return;
    }
    const target = await getUser(req.params.username);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const callerIds = await accessibleServerIds(req);
    const refusal =
      (await checkAccountWithinCaller(await effectivePermissions(req), callerIds, target)) ??
      checkServersWithinCaller(callerIds, list.value);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
    const user = await setUserAllowedServers(target.username, list.value);
    audit(req, 'user.servers_changed', {
      target: `user:${target.username}`,
      metadata: { allowedServers: list.value },
    });
    res.json({ success: true, username: user.username, allowedServers: list.value });
  }),
);

router.get(
  '/api-keys/:id/servers',
  authMiddleware,
  requirePermission('apikeys.manage'),
  (req: AuthenticatedRequest, res: Response) => {
    const key = getOwnApiKey(req.user!, req.params.id);
    if (!key) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ id: key.id, serverIds: key.serverIds });
  },
);

router.put(
  '/api-keys/:id/servers',
  authMiddleware,
  requirePermission('apikeys.manage'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const list = await readServerList(req.body, 'serverIds');
    if (!list.ok) {
      res.status(list.status).json(list.body);
      return;
    }
    // A key without a list follows its owner. That is only "no more than the
    // caller has" when the caller is not itself a key with a list.
    const callerIds = await accessibleServerIds(req);
    const keyLimited = Array.isArray(req.apiKey?.serverIds);
    const refusal =
      list.value === null && !keyLimited ? null : checkServersWithinCaller(callerIds, list.value);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
    if (!setApiKeyServerIds(req.user!, req.params.id, list.value)) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    audit(req, 'apikey.servers_changed', {
      target: `apikey:${req.params.id}`,
      metadata: { serverIds: list.value },
    });
    res.json({ success: true, id: req.params.id, serverIds: list.value });
  }),
);

export default router;
