/**
 * Server-scope middleware.
 *
 * Mounted at /api/servers/:serverId/*, copies the route parameter onto
 * req.serverId after validating that the id exists in the registry. Routes
 * downstream read req.serverId and pass it to docker.ts / scheduler.ts etc.
 *
 * The legacy /api/server/* (no id) callers don't go through this middleware
 * — their req.serverId stays undefined and the service layer resolves to
 * the default server.
 */
import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { getServer } from '../services/servers.js';

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
  const server = await getServer(serverId);
  if (!server) {
    res.status(404).json({ detail: 'Server not found' });
    return;
  }
  req.serverId = serverId;
  next();
}
