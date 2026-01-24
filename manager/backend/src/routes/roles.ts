import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import {
  getAllRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
} from '../services/roles.js';
import { PERMISSIONS, Permission } from '../types/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { logActivity } from '../services/activityLog.js';
import { isDemoMode, getDemoRoles } from '../services/demoData.js';

const router = Router();

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
      console.error('Failed to get roles:', error);
      res.status(500).json({ error: 'Failed to get roles' });
    }
  }
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
      console.error('Failed to get permissions:', error);
      res.status(500).json({ error: 'Failed to get permissions' });
    }
  }
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
      const role = demoRoles.find(r => r.id === req.params.id);
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
      console.error('Failed to get role:', error);
      res.status(500).json({ error: 'Failed to get role' });
    }
  }
);

// POST / - Create new role
router.post(
  '/',
  authMiddleware,
  requirePermission('roles.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
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

      if (!permissions || !Array.isArray(permissions)) {
        res.status(400).json({ error: 'Permissions must be an array' });
        return;
      }

      const role = await createRole({
        name,
        description,
        permissions,
        color,
      });

      // Log activity
      await logActivity(
        req.user || 'unknown',
        'create_role',
        'user',
        true,
        name,
        `Created role: ${name}`
      );

      res.status(201).json({ success: true, role });
    } catch (error) {
      console.error('Failed to create role:', error);
      const message = error instanceof Error ? error.message : 'Failed to create role';
      res.status(400).json({ error: message });
    }
  }
);

// PUT /:id - Update role
router.put(
  '/:id',
  authMiddleware,
  requirePermission('roles.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { name, description, permissions, color } = req.body;

      const updates: {
        name?: string;
        description?: string;
        permissions?: Permission[];
        color?: string;
      } = {};

      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (permissions !== undefined) updates.permissions = permissions;
      if (color !== undefined) updates.color = color;

      const role = await updateRole(id, updates);

      // Log activity
      await logActivity(
        req.user || 'unknown',
        'update_role',
        'user',
        true,
        role.name,
        `Updated role: ${role.name}`
      );

      res.json({ success: true, role });
    } catch (error) {
      console.error('Failed to update role:', error);
      const message = error instanceof Error ? error.message : 'Failed to update role';
      res.status(400).json({ error: message });
    }
  }
);

// DELETE /:id - Delete role
router.delete(
  '/:id',
  authMiddleware,
  requirePermission('roles.manage'),
  async (req: AuthenticatedRequest, res: Response) => {
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

      await deleteRole(id);

      // Log activity
      await logActivity(
        req.user || 'unknown',
        'delete_role',
        'user',
        true,
        role.name,
        `Deleted role: ${role.name}`
      );

      res.json({ success: true });
    } catch (error) {
      console.error('Failed to delete role:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete role';
      res.status(400).json({ error: message });
    }
  }
);

export default router;
