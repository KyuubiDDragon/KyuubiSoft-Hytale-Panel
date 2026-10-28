import { readFile, mkdir, access } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  Permission,
  Role,
  RolesData,
  DEFAULT_ROLES,
  PermissionEntry,
} from '../types/permissions.js';
import { getUser, getAllUsers, invalidateUserTokens, allowedServersOf } from './users.js';
import { isDemoMode } from './demoData.js';
import { withFileLock, writeJsonAtomic } from '../utils/jsonStore.js';

// Path to roles file in the persistent data volume
const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
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

// Write roles to file atomically (own temp file, fsync, rename), one write at a
// time: several first reads that each create the defaults must not rename
// over each other (EPERM on Windows).
async function writeRoles(data: RolesData): Promise<void> {
  await ensureDataDir();
  data.lastModified = new Date().toISOString();
  await withFileLock(ROLES_FILE, () => writeJsonAtomic(ROLES_FILE, data));
}

// Map role names to fixed IDs for backward compatibility
const SYSTEM_ROLE_IDS: Record<string, string> = {
  Administrator: 'admin',
  Moderator: 'moderator',
  Operator: 'operator',
  Viewer: 'viewer',
};

// Lower-case names getUserPermissions resolves legacy role ids by, and the id each belongs to.
const LEGACY_ROLE_NAMES: Record<string, string> = {
  administrator: 'admin',
  admin: 'admin',
  moderator: 'moderator',
  operator: 'operator',
  viewer: 'viewer',
};

/**
 * Role names are unique regardless of case and never take a legacy role name,
 * another role's id or a role id an account still carries: an account whose
 * role id does not resolve is matched by name, so such a name would hand its
 * permissions to other accounts.
 */
async function assertRoleNameFree(data: RolesData, name: string, self: Role | null): Promise<void> {
  const lower = name.trim().toLowerCase();
  if (data.roles.some((r) => r !== self && r.name.trim().toLowerCase() === lower)) {
    throw new Error('Role name already exists');
  }
  const legacyId = LEGACY_ROLE_NAMES[lower];
  const takenIds = [
    ...data.roles.filter((r) => r !== self).map((r) => r.id),
    ...(await getAllUsers()).map((u) => u.roleId).filter((id) => id !== self?.id),
  ];
  if (
    (legacyId !== undefined && self?.id !== legacyId) ||
    takenIds.some((id) => typeof id === 'string' && id.toLowerCase() === lower)
  ) {
    throw new Error('Role name is reserved');
  }
}

/**
 * Permissions added after roles.json was first written. New installs get them
 * through DEFAULT_ROLES. An existing file runs each entry once: every built-in
 * role gets what DEFAULT_ROLES grants it of the listed permissions. Custom
 * roles stay as they are, and the id is recorded, so a permission an admin
 * removes from a built-in role later does not come back on the next start.
 */
const PERMISSION_MIGRATIONS: ReadonlyArray<{ id: string; permissions: readonly Permission[] }> = [
  { id: 'mod-panel-permissions', permissions: ['mods.panel.view', 'mods.panel.action'] },
];

/**
 * Permissions split off an existing one. An existing file runs each entry
 * once: every role holding `from`, built-in or custom, also gets `grant`, so
 * nobody loses what the role could do before the split. Recorded in
 * appliedMigrations like the entries above, so a later removal sticks.
 */
const IMPLIED_PERMISSION_MIGRATIONS: ReadonlyArray<{
  id: string;
  from: Permission;
  grant: readonly Permission[];
}> = [
  // Editing servers and reconciling their containers needed servers.create before.
  { id: 'servers-manage-permission', from: 'servers.create', grant: ['servers.manage'] },
];

// Create default roles data structure
// Uses fixed IDs for system roles to maintain backward compatibility
function createDefaultRolesData(): RolesData {
  const now = new Date().toISOString();

  const roles: Role[] = DEFAULT_ROLES.map((roleTemplate) => ({
    id: SYSTEM_ROLE_IDS[roleTemplate.name] || randomUUID(),
    ...roleTemplate,
    createdAt: now,
    updatedAt: now,
  }));

  return {
    roles,
    version: 1,
    lastModified: now,
    // DEFAULT_ROLES already contains every migrated permission.
    appliedMigrations: [...PERMISSION_MIGRATIONS, ...IMPLIED_PERMISSION_MIGRATIONS].map(
      (m) => m.id,
    ),
  };
}

/**
 * Give the built-in roles of an existing roles.json the permissions new
 * installs get (PERMISSION_MIGRATIONS). Idempotent: an applied migration is
 * skipped. Returns whether `data` changed.
 */
export function migrateSystemRolePermissions(data: RolesData): boolean {
  const applied = new Set(data.appliedMigrations ?? []);
  const pending = PERMISSION_MIGRATIONS.filter((m) => !applied.has(m.id));
  if (pending.length === 0) return false;

  for (const migration of pending) {
    for (const role of data.roles) {
      if (!role.isSystem || role.permissions.includes('*')) continue;
      const template = DEFAULT_ROLES.find((r) => SYSTEM_ROLE_IDS[r.name] === role.id);
      if (!template) continue;
      const missing = migration.permissions.filter(
        (p) => template.permissions.includes(p) && !role.permissions.includes(p),
      );
      if (missing.length === 0) continue;
      console.log(`[Roles] Granting ${missing.join(', ')} to built-in role "${role.name}"`);
      role.permissions = [...role.permissions, ...missing];
      role.updatedAt = new Date().toISOString();
    }
    applied.add(migration.id);
  }
  data.appliedMigrations = [...applied];
  return true;
}

/**
 * Give every role of an existing roles.json that holds a split-off
 * permission its new part (IMPLIED_PERMISSION_MIGRATIONS). Idempotent like
 * migrateSystemRolePermissions. Returns whether `data` changed.
 */
export function migrateImpliedPermissions(data: RolesData): boolean {
  const applied = new Set(data.appliedMigrations ?? []);
  const pending = IMPLIED_PERMISSION_MIGRATIONS.filter((m) => !applied.has(m.id));
  if (pending.length === 0) return false;

  for (const migration of pending) {
    for (const role of data.roles) {
      if (role.permissions.includes('*') || !role.permissions.includes(migration.from)) continue;
      const missing = migration.grant.filter((p) => !role.permissions.includes(p));
      if (missing.length === 0) continue;
      console.log(
        `[Roles] Granting ${missing.join(', ')} to role "${role.name}" (has ${migration.from})`,
      );
      role.permissions = [...role.permissions, ...missing];
      role.updatedAt = new Date().toISOString();
    }
    applied.add(migration.id);
  }
  data.appliedMigrations = [...applied];
  return true;
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
  // Demo mode: skip file initialization
  if (isDemoMode()) {
    console.log('[Roles] Demo mode - using in-memory demo roles');
    return;
  }

  await ensureDataDir();

  if (!(await rolesFileExists())) {
    const data = createDefaultRolesData();
    await writeRoles(data);
  } else {
    // Check for migrations on existing data
    const data = await readRoles();
    const migrated = await migrateSystemRoleDescriptions(data);
    const builtInGranted = migrateSystemRolePermissions(data);
    const impliedGranted = migrateImpliedPermissions(data);
    const granted = builtInGranted || impliedGranted;
    if (migrated || granted) {
      data.version += 1;
      await writeRoles(data);
      if (migrated) {
        console.log('[Roles] Migration completed - system role descriptions updated to English');
      }
      if (granted) console.log('[Roles] Migration completed - new permissions for built-in roles');
    }
  }
}

// Demo roles for demo mode
function getDemoRoles(): Role[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'admin',
      name: 'Administrator',
      description: 'Full access to all features',
      permissions: ['*'],
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'moderator',
      name: 'Moderator',
      description: 'Player management and chat moderation',
      permissions: [
        'players.view',
        'players.kick',
        'players.ban',
        'players.unban',
        'console.view',
        'chat.view',
        'server.view_status',
      ],
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'operator',
      name: 'Operator',
      description: 'Server management and technical tasks',
      permissions: [
        'server.view_status',
        'server.start',
        'server.stop',
        'server.restart',
        'console.view',
        'console.execute',
        'backups.view',
        'scheduler.view',
      ],
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'viewer',
      name: 'Viewer',
      description: 'Read-only access to basic information',
      permissions: ['server.view_status', 'players.view', 'console.view'],
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

// Get all roles
export async function getAllRoles(): Promise<Role[]> {
  // Demo mode: return in-memory demo roles
  if (isDemoMode()) {
    return getDemoRoles();
  }

  const data = await readRoles();
  return data.roles;
}

// Get role by ID
export async function getRole(id: string): Promise<Role | null> {
  // Demo mode: return from in-memory demo roles
  if (isDemoMode()) {
    return getDemoRoles().find((r) => r.id === id) || null;
  }

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

  await assertRoleNameFree(data, roleData.name, null);

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
  },
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
    await assertRoleNameFree(data, updates.name, role);
  }

  // Check if permissions are being changed
  const permissionsChanged =
    updates.permissions !== undefined &&
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
  // Demo mode: return hardcoded permissions without file I/O
  if (isDemoMode()) {
    const user = await getUser(username);
    if (!user) {
      return [];
    }

    // Admin gets all permissions
    if (user.roleId === 'admin') {
      return ['*'];
    }

    // Viewer (demo user) gets read-only permissions
    if (user.roleId === 'viewer') {
      return [
        'server.view_status',
        'players.view',
        'console.view',
        'performance.view',
        'backups.view',
        'scheduler.view',
        'mods.view',
        'plugins.view',
        'worlds.view',
        'chat.view',
        'activity.view',
      ];
    }

    return [];
  }

  const user = await getUser(username);

  if (!user) {
    return [];
  }

  const roleId = user.roleId;

  if (!roleId) {
    return [];
  }

  // SAFETY NET: the built-in system admin always has full access, regardless of
  // the state of roles.json. Without this, a real admin whose 'admin' role no
  // longer resolves cleanly from roles.json (edited/renamed via the Roles UI, a
  // migration, or a bad merge) would fall through to `return []` below and be
  // presented as a permission-less "viewer" — the exact "stuck as Betrachter
  // after F5" symptom. Mirrors the demo-mode shortcut above.
  if (roleId === 'admin') {
    return ['*'];
  }

  // First try to find role by ID (UUID)
  let role = await getRole(roleId);

  if (role) {
    return withoutAccountRightsIfLimited(user, role.permissions);
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
  role =
    roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase() || r.id === roleId) ?? null;

  if (role) {
    return withoutAccountRightsIfLimited(user, role.permissions);
  }

  return [];
}

/**
 * Panel-wide rights that a user with a server list does not get, whatever the
 * role says. Accounts, roles and other users' keys reach every server: an
 * account such a user creates, or a password they reset, would not be bound to
 * their list. The account list shows every account with its servers; webhooks,
 * panel settings and the audit log show or affect every server. A deliberately
 * coarse cut until these features know about servers.
 */
export const PANEL_WIDE_RIGHTS: ReadonlySet<string> = new Set([
  'users.view',
  'users.create',
  'users.edit',
  'users.delete',
  'roles.manage',
  'apikeys.manage.all',
  'webhooks.manage',
  'settings.edit',
  'audit.view',
  'audit.export',
  // One activity log for the whole panel.
  'activity.view',
  'activity.clear',
]);

function withoutAccountRightsIfLimited(
  user: Parameters<typeof allowedServersOf>[0],
  permissions: PermissionEntry[],
): PermissionEntry[] {
  if (permissions.includes('*') || allowedServersOf(user) === null) return permissions;
  return permissions.filter((p) => !PANEL_WIDE_RIGHTS.has(p));
}

/**
 * Resolve a role id (UUID or legacy name like 'admin') to its permission list.
 * Mirrors the resolution order in getUserPermissions. Returns [] for unknown
 * roles. Used to enforce that an actor can only assign roles whose permissions
 * are a subset of their own (no privilege escalation via user create/update).
 */
export async function getRolePermissions(roleId: string): Promise<PermissionEntry[]> {
  const role = await resolveRole(roleId);
  return role ? role.permissions : [];
}

// The role a role id stands for: by id, else by legacy name (as getUserPermissions does).
async function resolveRole(roleId: string): Promise<Role | null> {
  if (!roleId) return null;
  const role = await getRole(roleId);
  if (role) return role;
  const roles = await getAllRoles();
  const roleNameMap: Record<string, string> = {
    admin: 'Administrator',
    moderator: 'Moderator',
    operator: 'Operator',
    viewer: 'Viewer',
  };
  const roleName = roleNameMap[roleId] || roleId;
  return (
    roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase() || r.id === roleId) ?? null
  );
}

/** Does this role id stand for a role? The built-in admin always does. */
export async function roleExists(roleId: string): Promise<boolean> {
  return roleId === 'admin' || (await resolveRole(roleId)) !== null;
}

/**
 * Permissions effective for a user on a particular server. Resolves the
 * hybrid model: a global role from users.json plus optional per-server
 * role overrides in user.serverScopes[serverId].roleId.
 *
 * A user with an allowedServers list has no permissions at all on a server
 * outside it; the per-server overrides only apply inside the list.
 *
 * When serverId is omitted only the global role's permissions are returned
 * — that's the right answer for routes that aren't scoped to one server
 * (like /api/auth/me or /api/audit-log).
 */
export async function getUserPermissionsForServer(
  username: string,
  serverId?: string,
): Promise<PermissionEntry[]> {
  const global = await getUserPermissions(username);
  if (!serverId) return global;
  if (global.includes('*')) return global; // admins bypass scoping and the server list
  const user = await getUser(username);
  const allowed = allowedServersOf(user);
  if (allowed !== null && !allowed.includes(serverId)) return [];
  const userAny = user as unknown as { serverScopes?: Record<string, { roleId: string }> } | null;
  const scopedRoleId = userAny?.serverScopes?.[serverId]?.roleId;
  if (!scopedRoleId) return global;
  if (isDemoMode()) return global;
  const data = await readRoles();
  const role = data.roles.find((r) => r.id === scopedRoleId);
  if (!role) return global;
  // Per-server permissions ADD to the global set (least surprise: granting
  // a scoped operator role to a viewer makes them an operator on that server,
  // never less).
  return withoutAccountRightsIfLimited(
    user,
    Array.from(new Set([...global, ...role.permissions])) as PermissionEntry[],
  );
}

// Check if user has specific permission (handle '*' wildcard for admin)
export async function hasPermission(
  username: string,
  permission: Permission,
  serverId?: string,
): Promise<boolean> {
  const permissions = await getUserPermissionsForServer(username, serverId);

  // Admin wildcard grants all permissions
  if (permissions.includes('*')) {
    return true;
  }

  return permissions.includes(permission);
}

/**
 * The servers a user may use: null = every server (no allowedServers list, or
 * an admin '*' role, which ignores the list), otherwise the allowed ids.
 */
export async function getUserAllowedServers(username: string): Promise<string[] | null> {
  const global = await getUserPermissions(username);
  if (global.includes('*')) return null;
  return allowedServersOf(await getUser(username));
}

/** May the user act on this server at all (before any per-permission check)? */
export async function userMayAccessServer(username: string, serverId: string): Promise<boolean> {
  const allowed = await getUserAllowedServers(username);
  return allowed === null || allowed.includes(serverId);
}
