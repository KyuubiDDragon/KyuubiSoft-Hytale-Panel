import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import {
  PANEL_WIDE_RIGHTS,
  getUserPermissions,
  getUserPermissionsForServer,
  getUserAllowedServers,
} from '../services/roles.js';
import { Permission, getAllPermissions } from '../types/permissions.js';

/**
 * Effective permission set for a request. Resolves both JWT-authenticated
 * users (role-derived permissions) and API-key callers (scopes are the
 * permission set; the key's owner does not get extra rights through their
 * role — keys are intentionally restrictive).
 *
 * Routes that act on one server carry req.serverId: the scoped mounts under
 * /api/servers/:serverId/... and the legacy mounts, which act on the default
 * server. There the server lists apply: a user outside their allowedServers,
 * or a key outside its serverIds, has no permissions at all.
 */
export async function effectivePermissions(req: AuthenticatedRequest): Promise<string[]> {
  if (!req.user) return [];
  // Per-server role overrides and the user's server list; without a server
  // only the global role's permissions count.
  const ownerPerms = req.serverId
    ? await getUserPermissionsForServer(req.user, req.serverId)
    : await getUserPermissions(req.user);
  if (!req.apiKey) return ownerPerms;
  if (req.serverId && !keyCoversServer(req, req.serverId)) return [];
  // Bind the key to its owner's CURRENT rights (req.user is the key owner).
  // A key minted while the owner was admin must not outlive a demotion or
  // deletion: intersect the stored scopes with what the owner holds now.
  // Owner deleted ⇒ getUserPermissions returns [] ⇒ key has no rights.
  const scopes = ownerPerms.includes('*')
    ? req.apiKey.scopes
    : req.apiKey.scopes.filter((s) => (ownerPerms as string[]).includes(s));
  return Array.isArray(req.apiKey.serverIds) ? withoutKeyLimitEscapes(scopes) : scopes;
}

/**
 * A key with a server list gets none of the panel-wide rights and manages no
 * keys: a key or account it created would not carry the list. ('*' is spelled
 * out for the same reason.)
 */
function withoutKeyLimitEscapes(scopes: string[]): string[] {
  const expanded: string[] = scopes.includes('*') ? getAllPermissions() : scopes;
  return expanded.filter((s) => !PANEL_WIDE_RIGHTS.has(s) && s !== 'apikeys.manage');
}

// effectivePermissions() reads users.json; if that fails (corrupt file) the
// error goes to the global handler (500) instead of hanging the request.
async function effectivePermissionsOrForward(
  req: AuthenticatedRequest,
  next: NextFunction,
): Promise<string[] | null> {
  try {
    return await effectivePermissions(req);
  } catch (err) {
    next(err);
    return null;
  }
}

/** A key without a server list follows its owner's servers. */
function keyCoversServer(req: AuthenticatedRequest, serverId: string): boolean {
  const ids = req.apiKey?.serverIds;
  return ids === undefined || ids === null || ids.includes(serverId);
}

/**
 * The servers the caller may use, or null for every server: the user's
 * allowedServers (admins have no limit) narrowed by an API key's serverIds.
 */
export async function accessibleServerIds(req: AuthenticatedRequest): Promise<string[] | null> {
  if (!req.user) return [];
  const own = await getUserAllowedServers(req.user);
  const keyIds = req.apiKey?.serverIds ?? null;
  if (own === null) return keyIds === null ? null : [...keyIds];
  return keyIds === null ? own : own.filter((id) => keyIds.includes(id));
}

/** May the caller act on this server at all (before any permission check)? */
export async function mayAccessServer(
  req: AuthenticatedRequest,
  serverId: string,
): Promise<boolean> {
  const ids = await accessibleServerIds(req);
  return ids === null || ids.includes(serverId);
}

/** Only the servers the caller may use, in their original order. */
export async function filterAccessibleServers<T extends { id: string }>(
  req: AuthenticatedRequest,
  servers: readonly T[],
): Promise<T[]> {
  const ids = await accessibleServerIds(req);
  return ids === null ? [...servers] : servers.filter((s) => ids.includes(s.id));
}

export const SERVER_NOT_ALLOWED = 'SERVER_NOT_ALLOWED';
export const ALL_SERVERS_REQUIRED = 'ALL_SERVERS_REQUIRED';

/** The 403 body for a server outside the caller's server list. */
export function serverNotAllowed(serverId: string) {
  return { error: 'No access to this server', code: SERVER_NOT_ALLOWED, serverId };
}

// The 403 body: name the server when the server list is the reason, so the
// client can tell "not on this server" from a missing permission.
async function deniedBody(req: AuthenticatedRequest, required: Permission[]): Promise<object> {
  if (req.serverId) {
    try {
      if (!(await mayAccessServer(req, req.serverId))) return serverNotAllowed(req.serverId);
    } catch {
      // the generic answer below is still a denial
    }
  }
  return { error: 'Insufficient permissions', required };
}

/**
 * Middleware factory that requires ALL specified permissions (AND logic).
 * If the user has the '*' permission (admin wildcard), all permissions are granted.
 */
export function requirePermission(...permissions: Permission[]) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userPermissions = await effectivePermissionsOrForward(req, next);
    if (!userPermissions) return;

    // Admin wildcard grants all permissions
    if (userPermissions.includes('*')) {
      next();
      return;
    }

    // Check if ALL required permissions are present
    const hasAllPermissions = permissions.every((permission) =>
      userPermissions.includes(permission),
    );

    if (!hasAllPermissions) {
      res.status(403).json(await deniedBody(req, permissions));
      return;
    }

    next();
  };
}

/**
 * Middleware factory that requires ANY of the specified permissions (OR logic).
 * If the user has the '*' permission (admin wildcard), all permissions are granted.
 */
export function requireAnyPermission(...permissions: Permission[]) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userPermissions = await effectivePermissionsOrForward(req, next);
    if (!userPermissions) return;

    // Admin wildcard grants all permissions
    if (userPermissions.includes('*')) {
      next();
      return;
    }

    // Check if ANY of the required permissions is present
    const hasAnyPermission = permissions.some((permission) => userPermissions.includes(permission));

    if (!hasAnyPermission) {
      res.status(403).json(await deniedBody(req, permissions));
      return;
    }

    next();
  };
}

/**
 * Requires access to the server named by a route parameter (registry routes
 * such as /api/servers/:id, which do not set req.serverId). 403
 * SERVER_NOT_ALLOWED otherwise. Combine with requirePermission.
 */
export function requireServerAccess(param = 'id') {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const serverId = (req.params as Record<string, string | undefined>)[param] ?? '';
    let allowed: boolean;
    try {
      allowed = serverId !== '' && (await mayAccessServer(req, serverId));
    } catch (err) {
      next(err);
      return;
    }
    if (!allowed) {
      res.status(403).json(serverNotAllowed(serverId));
      return;
    }
    next();
  };
}

/**
 * Requires access to every server: for actions that change what all users get,
 * such as adding a server or moving the default. 403 ALL_SERVERS_REQUIRED for
 * a user or key with a server list.
 */
export function requireAllServerAccess() {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    let ids: string[] | null;
    try {
      ids = await accessibleServerIds(req);
    } catch (err) {
      next(err);
      return;
    }
    if (ids !== null) {
      res.status(403).json({
        error: 'Only accounts with access to every server may do this',
        code: ALL_SERVERS_REQUIRED,
      });
      return;
    }
    next();
  };
}
