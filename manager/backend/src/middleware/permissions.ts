import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { getUserPermissions } from '../services/roles.js';
import { Permission } from '../types/permissions.js';

/**
 * Effective permission set for a request. Resolves both JWT-authenticated
 * users (role-derived permissions) and API-key callers (scopes are the
 * permission set; the key's owner does not get extra rights through their
 * role — keys are intentionally restrictive).
 */
async function effectivePermissions(req: AuthenticatedRequest): Promise<string[]> {
  if (req.apiKey) {
    return req.apiKey.scopes;
  }
  if (!req.user) return [];
  return getUserPermissions(req.user);
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

    const userPermissions = await effectivePermissions(req);

    // Admin wildcard grants all permissions
    if (userPermissions.includes('*')) {
      next();
      return;
    }

    // Check if ALL required permissions are present
    const hasAllPermissions = permissions.every((permission) =>
      userPermissions.includes(permission)
    );

    if (!hasAllPermissions) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: permissions,
      });
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

    const userPermissions = await effectivePermissions(req);

    // Admin wildcard grants all permissions
    if (userPermissions.includes('*')) {
      next();
      return;
    }

    // Check if ANY of the required permissions is present
    const hasAnyPermission = permissions.some((permission) =>
      userPermissions.includes(permission)
    );

    if (!hasAnyPermission) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: permissions,
      });
      return;
    }

    next();
  };
}
