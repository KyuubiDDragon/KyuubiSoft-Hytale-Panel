import { readFile, writeFile, mkdir, rename, access } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  Permission,
  Role,
  RolesData,
  DEFAULT_ROLES,
  PermissionEntry,
} from '../types/permissions.js';
import { getUser, getAllUsers, invalidateUserTokens } from './users.js';

// Path to roles file in the persistent data volume
const DATA_DIR = process.env.DATA_PATH || '/app/data';
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

// Ensure data directory exists
async function ensureDataDir(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

// Read roles from file
async function readRoles(): Promise<RolesData> {
  try {
    const content = await readFile(ROLES_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    // If file doesn't exist, initialize with defaults
    const data = createDefaultRolesData();
    await writeRoles(data);
    return data;
  }
}

// Write roles to file using atomic write (write to .tmp then rename)
async function writeRoles(data: RolesData): Promise<void> {
  await ensureDataDir();
  data.lastModified = new Date().toISOString();

  const tmpFile = `${ROLES_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpFile, ROLES_FILE);
}

// Create default roles data structure
// Uses fixed IDs for system roles to maintain backward compatibility
function createDefaultRolesData(): RolesData {
  const now = new Date().toISOString();

  // Map role names to fixed IDs for backward compatibility
  const roleIdMap: Record<string, string> = {
    'Administrator': 'admin',
    'Moderator': 'moderator',
    'Operator': 'operator',
    'Viewer': 'viewer',
  };

  const roles: Role[] = DEFAULT_ROLES.map((roleTemplate) => ({
    id: roleIdMap[roleTemplate.name] || randomUUID(),
    ...roleTemplate,
    createdAt: now,
    updatedAt: now,
  }));

  return {
    roles,
    version: 1,
    lastModified: now,
  };
}

// Check if roles file exists
async function rolesFileExists(): Promise<boolean> {
  try {
    await access(ROLES_FILE);
    return true;
  } catch {
    return false;
  }
}

// Migrate system role descriptions from German to English
async function migrateSystemRoleDescriptions(data: RolesData): Promise<boolean> {
  // Map of old German descriptions to new English descriptions
  const descriptionMigrations: Record<string, string> = {
    'Vollzugriff auf alle Funktionen': 'Full access to all features',
    'Spielerverwaltung und Chat-Moderation': 'Player management and chat moderation',
    'Serververwaltung und technische Aufgaben': 'Server management and technical tasks',
    'Nur-Lese-Zugriff auf grundlegende Informationen': 'Read-only access to basic information',
  };

  let migrated = false;

  for (const role of data.roles) {
    if (role.isSystem && descriptionMigrations[role.description]) {
      console.log(`[Roles] Migrating description for role "${role.name}" from German to English`);
      role.description = descriptionMigrations[role.description];
      role.updatedAt = new Date().toISOString();
      migrated = true;
    }
  }

  return migrated;
}

// Initialize roles on startup - creates file with DEFAULT_ROLES if it doesn't exist
export async function initializeRoles(): Promise<void> {
  await ensureDataDir();

  if (!(await rolesFileExists())) {
    const data = createDefaultRolesData();
    await writeRoles(data);
  } else {
    // Check for migrations on existing data
    const data = await readRoles();
    const migrated = await migrateSystemRoleDescriptions(data);
    if (migrated) {
      data.version += 1;
      await writeRoles(data);
      console.log('[Roles] Migration completed - system role descriptions updated to English');
    }
  }
}

// Get all roles
export async function getAllRoles(): Promise<Role[]> {
  const data = await readRoles();
  return data.roles;
}

// Get role by ID
export async function getRole(id: string): Promise<Role | null> {
  const data = await readRoles();
  return data.roles.find((r) => r.id === id) || null;
}

// Create new custom role
export async function createRole(roleData: {
  name: string;
  description: string;
  permissions: PermissionEntry[];
  color?: string;
}): Promise<Role> {
  const data = await readRoles();
  const now = new Date().toISOString();

  // Check if role name already exists
  if (data.roles.some((r) => r.name === roleData.name)) {
    throw new Error('Role name already exists');
  }

  const newRole: Role = {
    id: randomUUID(),
    name: roleData.name,
    description: roleData.description,
    permissions: roleData.permissions,
    isSystem: false,
    color: roleData.color,
    createdAt: now,
    updatedAt: now,
  };

  data.roles.push(newRole);
  data.version += 1;
  await writeRoles(data);

  return newRole;
}

// Update role
export async function updateRole(
  id: string,
  updates: {
    name?: string;
    description?: string;
    permissions?: PermissionEntry[];
    color?: string;
    isSystem?: boolean;
  }
): Promise<Role> {
  const data = await readRoles();
  const roleIndex = data.roles.findIndex((r) => r.id === id);

  if (roleIndex === -1) {
    throw new Error('Role not found');
  }

  const role = data.roles[roleIndex];

  // Check if trying to change isSystem flag on a system role
  if (role.isSystem && updates.isSystem !== undefined && updates.isSystem !== role.isSystem) {
    throw new Error('Cannot change isSystem flag on system roles');
  }

  // Check if new name conflicts with existing role
  if (updates.name && updates.name !== role.name) {
    if (data.roles.some((r) => r.name === updates.name && r.id !== id)) {
      throw new Error('Role name already exists');
    }
  }

  // Check if permissions are being changed
  const permissionsChanged = updates.permissions !== undefined &&
    JSON.stringify(updates.permissions.sort()) !== JSON.stringify(role.permissions.sort());

  // Apply updates (excluding isSystem for system roles)
  if (updates.name !== undefined) {
    data.roles[roleIndex].name = updates.name;
  }
  if (updates.description !== undefined) {
    data.roles[roleIndex].description = updates.description;
  }
  if (updates.permissions !== undefined) {
    data.roles[roleIndex].permissions = updates.permissions;
  }
  if (updates.color !== undefined) {
    data.roles[roleIndex].color = updates.color;
  }
  // Only allow changing isSystem for non-system roles
  if (!role.isSystem && updates.isSystem !== undefined) {
    data.roles[roleIndex].isSystem = updates.isSystem;
  }

  data.roles[roleIndex].updatedAt = new Date().toISOString();
  data.version += 1;
  await writeRoles(data);

  // If permissions changed, invalidate tokens for all users with this role
  if (permissionsChanged) {
    await invalidateUsersWithRole(id);
  }

  return data.roles[roleIndex];
}

// Invalidate tokens for all users with a specific role
async function invalidateUsersWithRole(roleId: string): Promise<void> {
  try {
    const users = await getAllUsers();
    for (const user of users) {
      if (user.roleId === roleId) {
        await invalidateUserTokens(user.username);
      }
    }
  } catch {
    // Log error but don't fail the role update
    console.error('Failed to invalidate user tokens for role:', roleId);
  }
}

// Delete role (only if isSystem is false and no users have this role)
export async function deleteRole(id: string): Promise<void> {
  const data = await readRoles();
  const role = data.roles.find((r) => r.id === id);

  if (!role) {
    throw new Error('Role not found');
  }

  if (role.isSystem) {
    throw new Error('Cannot delete system roles');
  }

  // Note: In a full implementation, you would check if any users have this role
  // For now, we'll import the users service dynamically to avoid circular dependencies
  // This check should be done at the API layer or by checking the users file directly

  data.roles = data.roles.filter((r) => r.id !== id);
  data.version += 1;
  await writeRoles(data);
}

// Get all permissions for a user by looking up their role
export async function getUserPermissions(username: string): Promise<PermissionEntry[]> {
  const user = await getUser(username);

  if (!user) {
    return [];
  }

  const roleId = user.roleId;

  if (!roleId) {
    return [];
  }

  // First try to find role by ID (UUID)
  let role = await getRole(roleId);

  if (role) {
    return role.permissions;
  }

  // If not found by UUID, try to match by legacy role name
  // This handles cases where roleId is 'admin', 'moderator', etc.
  const roles = await getAllRoles();
  const roleNameMap: Record<string, string> = {
    admin: 'Administrator',
    moderator: 'Moderator',
    operator: 'Operator',
    viewer: 'Viewer',
  };

  const roleName = roleNameMap[roleId] || roleId;
  role = roles.find(
    (r) => r.name.toLowerCase() === roleName.toLowerCase() || r.id === roleId
  ) ?? null;

  if (role) {
    return role.permissions;
  }

  return [];
}

// Check if user has specific permission (handle '*' wildcard for admin)
export async function hasPermission(
  username: string,
  permission: Permission
): Promise<boolean> {
  const permissions = await getUserPermissions(username);

  // Admin wildcard grants all permissions
  if (permissions.includes('*')) {
    return true;
  }

  return permissions.includes(permission);
}
