/**
 * Server-scope middleware.
 *
 *  - serverScopeMiddleware: mounted at /api/servers/:serverId/*, copies the
 *    route parameter onto req.serverId after validating that the id exists in
 *    the registry. While MULTISERVER_ENABLED is off only the compose server is
 *    reachable this way.
 *  - legacyServerScope: mounted on the legacy /api/<resource> routes, sets
 *    req.serverId to the default server. Handlers downstream therefore always
 *    see a concrete id and pass it to docker.ts / scheduler.ts etc.
 *  - requireServerFiles: 409 when the manager can't see the server's files,
 *    instead of a route silently working on another server's folders.
 *  - composeServerOnly: 409 for routes that still read the compose server's
 *    files and therefore can't serve any other server yet.
 *
 * A rejection only goes to an authenticated caller; anyone else gets the
 * usual 401, so the answer doesn't tell which server ids exist. One about a
 * particular server only goes to callers who may use that server.
 */
import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { authMiddleware } from './auth.js';
import { mayAccessServer, serverNotAllowed } from './permissions.js';
import { config } from '../config.js';
import { getDefaultId } from '../services/servers.js';
import {
  checkServerFiles,
  getServerContext,
  UnknownServerError,
  type ServerContext,
} from '../services/serverContext.js';

export const MULTISERVER_DISABLED_BODY = {
  detail:
    'Multiserver is disabled on this panel, only the primary server can be managed (set MULTISERVER_ENABLED=true to enable the experimental feature)',
  code: 'MULTISERVER_DISABLED',
} as const;

const SERVER_NOT_FOUND_BODY = { detail: 'Server not found' } as const;

interface Rejection {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Answers `rejection` once the caller is authenticated. For a rejection about
 * an existing server (`serverId`), a caller outside that server's access list
 * gets the permission check's 403 instead, so they learn nothing about it.
 */
function rejectAfterAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  rejection: Rejection,
  serverId?: string,
): void {
  const send = async () => {
    if (serverId && !(await mayAccessServer(req, serverId))) {
      res.status(403).json(serverNotAllowed(serverId));
      return;
    }
    res.status(rejection.status).json(rejection.body);
  };
  const afterAuth = (err?: unknown) => {
    if (err) next(err);
    else send().catch(next);
  };
  if (req.user) {
    afterAuth();
    return;
  }
  Promise.resolve()
    .then(() => authMiddleware(req, res, afterAuth))
    .catch(next);
}

/** The request's server, or null after answering (unknown id) or forwarding an error. */
async function contextOrReject(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  serverId: string | undefined,
): Promise<ServerContext | null> {
  try {
    return await getServerContext(serverId);
  } catch (err) {
    if (err instanceof UnknownServerError) {
      rejectAfterAuth(req, res, next, { status: 404, body: SERVER_NOT_FOUND_BODY });
    } else {
      next(err);
    }
    return null;
  }
}

export async function serverScopeMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const serverId = (req.params as { serverId?: string }).serverId;
  if (!serverId) {
    next();
    return;
  }
  const ctx = await contextOrReject(req, res, next, serverId);
  if (!ctx) return;
  if (!config.multiserverEnabled && ctx.kind !== 'compose') {
    rejectAfterAuth(req, res, next, { status: 403, body: MULTISERVER_DISABLED_BODY }, ctx.id);
    return;
  }
  req.serverId = ctx.id;
  next();
}

export async function legacyServerScope(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.serverId === undefined) {
    try {
      req.serverId = await getDefaultId();
    } catch (err) {
      next(err);
      return;
    }
  }
  next();
}

export async function requireServerFiles(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ctx = await contextOrReject(req, res, next, req.serverId);
  if (!ctx) return;
  const files = checkServerFiles(ctx);
  if (!files.available) {
    rejectAfterAuth(
      req,
      res,
      next,
      {
        status: 409,
        body: {
          success: false,
          code: 'server_files_unavailable',
          reason: files.reason,
          error: files.detail,
          detail: files.detail,
        },
      },
      ctx.id,
    );
    return;
  }
  next();
}

/** `feature` names what is refused, e.g. "World configs". */
export function composeServerOnly(feature: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const ctx = await contextOrReject(req, res, next, req.serverId);
    if (!ctx) return;
    if (ctx.kind !== 'compose') {
      rejectAfterAuth(
        req,
        res,
        next,
        {
          status: 409,
          body: {
            success: false,
            reason: 'compose_server_only',
            error: `${feature} can only be used on the primary server so far.`,
          },
        },
        ctx.id,
      );
      return;
    }
    next();
  };
}
