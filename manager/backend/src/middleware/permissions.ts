import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/index.js';
import { getUserPermissions } from '../services/roles.js';
import { Permission } from '../types/permissions.js';
import { isDemoModeEnabled, isDemoUser, getDemoPermissions } from '../services/demo.js';

/**
 * Get permissions for a user, handling demo users specially
 */
async function getEffectivePermissions(username: string): Promise<string[]> {
  // Check if this is a demo user
  if (isDemoModeEnabled() && isDemoUser(username)) {
    return getDemoPermissions();
  }
  return getUserPermissions(username);
}

/**
 * Middleware factory that requires ALL specified permissions (AND logic).
 * If the user has the '*' permission (admin wildcard), all permissions are granted.
 */
export function requirePermission(...permissions: Permission[]) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const username = req.user;

    if (!username) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userPermissions = await getEffectivePermissions(username);

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
    const username = req.user;

    if (!username) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userPermissions = await getEffectivePermissions(username);

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
