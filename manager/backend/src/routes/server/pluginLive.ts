// Live data from the KyuubiSoft API plugin (2.1+): server status, plugin/mod
// load state, whitelist, bans, permissions, sessions and world-thread player
// reads. Read-only; mounted under /api/server and /api/servers/:id/server.
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncRoute } from '../../utils/asyncRoute.js';
import * as kyuubiApi from '../../services/kyuubiApi.js';
import type { PluginApiResponse } from '../../services/kyuubiApi.js';
import {
  liveFailureStatus,
  requireLiveInventory,
  toInventoryView,
} from '../../services/pluginLiveData.js';
import type { Permission } from '../../types/permissions.js';

const router = Router();

type ServerRequest = Request & { serverId?: string };

/**
 * Answer with the plugin's data, or with the status of its refusal
 * ({ success: false, error } as the other plugin routes do).
 */
function sendLive<T>(
  res: Response,
  result: PluginApiResponse & { data?: T },
  map?: (d: T) => unknown,
) {
  if (!result.success || result.data === undefined) {
    res.status(liveFailureStatus(result)).json({ success: false, error: result.error });
    return;
  }
  res.json({ success: true, data: map ? map(result.data) : result.data });
}

function liveRoute<T>(
  path: string,
  permission: Permission,
  fetch: (req: ServerRequest) => Promise<PluginApiResponse & { data?: T }>,
  map?: (data: T) => unknown,
) {
  router.get(
    path,
    authMiddleware,
    requirePermission(permission),
    asyncRoute(async (req: ServerRequest, res: Response) => {
      sendLive(res, await fetch(req), map);
    }),
  );
}

// GET /api/server/plugin/server-status - build, update, auth (no tokens), lifecycle
liveRoute('/plugin/server-status', 'server.view_status', (req) =>
  kyuubiApi.getServerStatusFromPlugin(req.serverId),
);

// GET /api/server/plugin/plugins - every plugin/mod with load state and errors
liveRoute('/plugin/plugins', 'server.view_status', (req) =>
  kyuubiApi.getLoadedPluginsFromPlugin(req.serverId),
);

// GET /api/server/plugin/access/whitelist - join-permission whitelist (0.7)
liveRoute('/plugin/access/whitelist', 'players.whitelist', (req) =>
  kyuubiApi.getWhitelistFromPlugin(req.serverId),
);

// GET /api/server/plugin/access/bans - bans with reason, expiry and author
liveRoute('/plugin/access/bans', 'players.ban', (req) => kyuubiApi.getBansFromPlugin(req.serverId));

// GET /api/server/plugin/permissions/groups
liveRoute('/plugin/permissions/groups', 'players.permissions', (req) =>
  kyuubiApi.getPermissionGroupsFromPlugin(req.serverId),
);

// GET /api/server/plugin/permissions/users
liveRoute('/plugin/permissions/users', 'players.permissions', (req) =>
  kyuubiApi.getPermissionUsersFromPlugin(req.serverId),
);

// GET /api/server/plugin/permissions/users/:uuid
liveRoute('/plugin/permissions/users/:uuid', 'players.permissions', (req) =>
  kyuubiApi.getPermissionUserFromPlugin(req.params.uuid, req.serverId),
);

// GET /api/server/plugin/sessions - online sessions (join time, ping, groups)
liveRoute('/plugin/sessions', 'players.view', (req) =>
  kyuubiApi.getSessionsFromPlugin(req.serverId),
);

// GET /api/server/plugin/players/:name/live - game mode, stats, ping, groups, skin
liveRoute('/plugin/players/:name/live', 'players.view', (req) =>
  kyuubiApi.getPlayerLiveFromPlugin(req.params.name, req.serverId),
);

// GET /api/server/plugin/players/:name/live/inventory - real inventory in the
// same shape as the saved-file inventory, so the player modal renders it as is.
// An older plugin's empty placeholder answers 501, so the modal keeps the file.
liveRoute(
  '/plugin/players/:name/live/inventory',
  'players.view',
  async (req) =>
    requireLiveInventory(
      await kyuubiApi.getPlayerLiveInventoryFromPlugin(req.params.name, req.serverId),
    ),
  toInventoryView,
);

export default router;
