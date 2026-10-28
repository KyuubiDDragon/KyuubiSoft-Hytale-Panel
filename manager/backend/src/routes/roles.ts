import { logger } from '../utils/logger.js';
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission, effectivePermissions } from '../middleware/permissions.js';
import { getAllRoles, getRole, createRole, updateRole, deleteRole } from '../services/roles.js';
import {
  checkPermissionsWithinCaller,
  coversPermissions,
  readPermissionList,
  refuse,
  type Refusal,
} from '../services/accountPolicy.js';
import { PERMISSIONS, PermissionEntry, type Role } from '../types/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { logActivity } from '../services/activityLog.js';
import { isDemoMode, getDemoRoles } from '../services/demoData.js';

const router = Router();

/**
 * May the caller change or delete this role? System roles only by an admin,
 * any other role only by someone holding all of its permissions — so nobody
 * reshapes a role more powerful than their own.
 */
function checkRoleChange(callerPerms: readonly string[], role: Role): Refusal | null {
  if (role.isSystem && !callerPerms.includes('*')) {
    return refuse(403, 'Only an admin can change system roles', 'SYSTEM_ROLE_PROTECTED');
  }
  if (!coversPermissions(callerPerms, role.permissions)) {
    return refuse(
      403,
      'Cannot change a role with more permissions than your own',
      'ROLE_EXCEEDS_YOURS',
    );
  }
  return null;
}

/** The permissions of a role body: catalog only, none beyond the caller's own. */
function checkNewPermissions(
  callerPerms: readonly string[],
  value: unknown,
): { ok: true; value: PermissionEntry[] } | ({ ok: false } & Refusal) {
  const list = readPermissionList(value);
  if (!list.ok) return list;
  const refusal = checkPermissionsWithinCaller(callerPerms, list.value);
  return refusal ? { ok: false, ...refusal } : { ok: true, value: list.value as PermissionEntry[] };
}

// GET / - List all roles
router.get(
  '/',
  authMiddleware,
  requirePermission('roles.view'),
  async (_req: Request, res: Response) => {
    // Demo mode: return demo roles
    if (isDemoMode()) {
      res.json({ roles: getDemoRoles() });
      return;
    }

    try {
      const roles = await getAllRoles();
      res.json({ roles });
    } catch (error) {
      logger.error('Failed to get roles:', error);
      res.status(500).json({ error: 'Failed to get roles' });
    }
  },
);

// GET /permissions - List all available permissions
router.get(
  '/permissions',
  authMiddleware,
  requirePermission('roles.view'),
  async (_req: Request, res: Response) => {
    try {
      res.json({ permissions: PERMISSIONS });
    } catch (error) {
      logger.error('Failed to get permissions:', error);
      res.status(500).json({ error: 'Failed to get permissions' });
    }
  },
);

// GET /:id - Get single role
router.get(
  '/:id',
  authMiddleware,
  requirePermission('roles.view'),
  async (req: Request, res: Response) => {
    // Demo mode: return demo role
    if (isDemoMode()) {
      const demoRoles = getDemoRoles();
      const role = demoRoles.find((r) => r.id === req.params.id);
      if (!role) {
        res.status(404).json({ error: 'Role not found' });
        return;
      }
      res.json(role);
      return;
    }

    try {
      const { id } = req.params;
      const role = await getRole(id);

      if (!role) {
        res.status(404).json({ error: 'Role not found' });
        return;
      }

      res.json(role);
    } catch (error) {
      logger.error('Failed to get role:', error);
      res.status(500).json({ error: 'Failed to get role' });
    }
  },
);

// POST / - Create new role
router.post(
  '/',
  authMiddleware,
  requirePermission('roles.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: simulate role creation
    if (isDemoMode()) {
      const { name, description, permissions, color } = req.body;
      res.status(201).json({
        success: true,
        message: '[DEMO] Role created (simulated)',
        role: {
          id: `demo-${Date.now()}`,
          name,
          description,
          permissions: permissions || [],
          color,
          isDefault: false,
          isSystem: false,
        },
      });
      return;
    }

    try {
      const { name, description, permissions, color } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Name is required' });
        return;
      }

      if (!description || typeof description !== 'string') {
        res.status(400).json({ error: 'Description is required' });
        return;
      }

      // SECURITY: only catalog permissions, and none the creator lacks ('*' only an admin).
      const checked = checkNewPermissions(await effectivePermissions(req), permissions);
      if (!checked.ok) {
        res.status(checked.status).json(checked.body);
        return;
      }

      const role = await createRole({
        name,
        description,
        permissions: checked.value,
        color,
      });

      // Log activity
      await logActivity(
        req.user || 'unknown',
        'create_role',
        'user',
        true,
        name,
        `Created role: ${name}`,
      );

      res.status(201).json({ success: true, role });
    } catch (error) {
      logger.error('Failed to create role:', error);
      const message = error instanceof Error ? error.message : 'Failed to create role';
      res.status(400).json({ error: message });
    }
  },
);

// PUT /:id - Update role
router.put(
  '/:id',
  authMiddleware,
  requirePermission('roles.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: simulate role update
    if (isDemoMode()) {
      const { id } = req.params;
      const demoRoles = getDemoRoles();
      const existingRole = demoRoles.find((r) => r.id === id);
      res.json({
        success: true,
        message: '[DEMO] Role updated (simulated)',
        role: existingRole || { id, ...req.body },
      });
      return;
    }

    try {
      const { id } = req.params;
      const { name, description, permissions, color } = req.body;

      const existing = await getRole(id);
      if (!existing) {
        res.status(404).json({ error: 'Role not found' });
        return;
      }
      // SECURITY: no reshaping a system role (unless admin) or a role beyond
      // the caller's own rights, and no granting permissions the caller lacks —
      // which also rules out widening one's own role.
      const callerPerms = await effectivePermissions(req);
      const refusal = checkRoleChange(callerPerms, existing);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }

      const updates: {
        name?: string;
        description?: string;
        permissions?: PermissionEntry[];
        color?: string;
      } = {};

      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (permissions !== undefined) {
        const checked = checkNewPermissions(callerPerms, permissions);
        if (!checked.ok) {
          res.status(checked.status).json(checked.body);
          return;
        }
        // The administrator role always keeps every permission.
        if (existing.id === 'admin' && !checked.value.includes('*')) {
          res.status(400).json({
            error: 'The administrator role always keeps every permission',
            code: 'SYSTEM_ROLE_PROTECTED',
          });
          return;
        }
        updates.permissions = checked.value;
      }
      if (color !== undefined) updates.color = color;

      const role = await updateRole(id, updates);

      // Log activity
      await logActivity(
        req.user || 'unknown',
        'update_role',
        'user',
        true,
        role.name,
        `Updated role: ${role.name}`,
      );

      res.json({ success: true, role });
    } catch (error) {
      logger.error('Failed to update role:', error);
      const message = error instanceof Error ? error.message : 'Failed to update role';
      res.status(400).json({ error: message });
    }
  },
);

// DELETE /:id - Delete role
router.delete(
  '/:id',
  authMiddleware,
  requirePermission('roles.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: simulate role deletion
    if (isDemoMode()) {
      const { id } = req.params;
      const demoRoles = getDemoRoles();
      const role = demoRoles.find((r) => r.id === id);

      if (role?.isSystem) {
        res.status(400).json({ error: 'Cannot delete system roles' });
        return;
      }

      res.json({ success: true, message: '[DEMO] Role deleted (simulated)' });
      return;
    }

    try {
      const { id } = req.params;

      // Get role first to check isSystem flag
      const role = await getRole(id);

      if (!role) {
        res.status(404).json({ error: 'Role not found' });
        return;
      }

      if (role.isSystem) {
        res.status(400).json({ error: 'Cannot delete system roles' });
        return;
      }
      // SECURITY: no deleting a role beyond the caller's own rights.
      const refusal = checkRoleChange(await effectivePermissions(req), role);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }

      await deleteRole(id);

      // Log activity
      await logActivity(
        req.user || 'unknown',
        'delete_role',
        'user',
        true,
        role.name,
        `Deleted role: ${role.name}`,
      );

      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to delete role:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete role';
      res.status(400).json({ error: message });
    }
  },
);

export default router;
