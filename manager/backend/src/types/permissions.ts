/**
 * Permission system type definitions
 * Defines all available permissions, roles, and related interfaces
 */

// All available permissions - values used for fallback display
export const PERMISSIONS = {
  // Dashboard
  'dashboard.view': 'View dashboard',
  'dashboard.stats': 'View dashboard statistics',

  // Server
  'server.view_status': 'View server status',
  'server.start': 'Start server',
  'server.stop': 'Stop server',
  'server.restart': 'Restart server',
  'server.quick_settings': 'Edit quick settings',

  // Console
  'console.view': 'View console',
  'console.execute': 'Execute console commands',

  // Performance
  'performance.view': 'View performance metrics',

  // Players
  'players.view': 'View player list',
  'players.edit': 'Edit player data',
  'players.kick': 'Kick players',
  'players.ban': 'Ban players',
  'players.unban': 'Unban players',
  'players.whitelist': 'Manage whitelist',
  'players.op': 'Manage operator status',
  'players.permissions': 'Manage player permissions',
  'players.teleport': 'Teleport players',
  'players.kill': 'Kill players',
  'players.respawn': 'Respawn players',
  'players.gamemode': 'Change game mode',
  'players.give': 'Give items',
  'players.heal': 'Heal players',
  'players.effects': 'Manage effects',
  'players.clear_inventory': 'Clear inventory',
  'players.message': 'Send messages',

  // Chat
  'chat.view': 'View chat',
  'chat.send': 'Send chat messages',

  // Backups
  'backups.view': 'View backups',
  'backups.create': 'Create backups',
  'backups.restore': 'Restore backups',
  'backups.delete': 'Delete backups',
  'backups.download': 'Download backups',

  // Scheduler
  'scheduler.view': 'View scheduler',
  'scheduler.edit': 'Edit scheduler',

  // Worlds
  'worlds.view': 'View worlds',
  'worlds.manage': 'Manage worlds',

  // Mods
  'mods.view': 'View mods',
  'mods.install': 'Install mods',
  'mods.delete': 'Delete mods',
  'mods.config': 'Edit mod configuration',
  'mods.toggle': 'Enable/disable mods',

  // Plugins
  'plugins.view': 'View plugins',
  'plugins.install': 'Install plugins',
  'plugins.delete': 'Delete plugins',
  'plugins.config': 'Edit plugin configuration',
  'plugins.toggle': 'Enable/disable plugins',

  // Config
  'config.view': 'View configuration',
  'config.edit': 'Edit configuration',

  // Assets
  'assets.view': 'View assets',
  'assets.manage': 'Manage assets',

  // Users
  'users.view': 'View users',
  'users.create': 'Create users',
  'users.edit': 'Edit users',
  'users.delete': 'Delete users',

  // Roles
  'roles.view': 'View roles',
  'roles.manage': 'Manage roles',

  // Activity
  'activity.view': 'View activity log',
  'activity.clear': 'Clear activity log',

  // Hytale Auth
  'hytale_auth.manage': 'Manage Hytale authentication',

  // Settings
  'settings.view': 'View settings',
  'settings.edit': 'Edit settings',

  // Updates (Hytale native update system)
  'updates.view': 'View update status',
  'updates.check': 'Check for updates',
  'updates.download': 'Download updates',
  'updates.apply': 'Apply updates (restart server)',
  'updates.config': 'Configure auto-update settings',
} as const;

// Permission type derived from the keys
export type Permission = keyof typeof PERMISSIONS;

// Wildcard permission for admin access
export const WILDCARD_PERMISSION = '*' as const;

// Type for permission entries (including wildcard)
export type PermissionEntry = Permission | typeof WILDCARD_PERMISSION;

// Role interface
export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: PermissionEntry[];
  isSystem: boolean;
  color?: string;
  createdAt: string;
  updatedAt: string;
}

// RolesData interface for the JSON file structure
export interface RolesData {
  roles: Role[];
  version: number;
  lastModified: string;
}

// Helper function to get all permission keys
export const getAllPermissions = (): Permission[] => {
  return Object.keys(PERMISSIONS) as Permission[];
};

// Helper function to get permissions by category
export const getPermissionsByCategory = (category: string): Permission[] => {
  return getAllPermissions().filter((p) => p.startsWith(`${category}.`));
};

// Permission categories for UI grouping
export const PERMISSION_CATEGORIES = [
  'dashboard',
  'server',
  'console',
  'performance',
  'players',
  'chat',
  'backups',
  'scheduler',
  'worlds',
  'mods',
  'plugins',
  'config',
  'assets',
  'users',
  'roles',
  'activity',
  'hytale_auth',
  'settings',
  'updates',
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

// Default role templates
export const DEFAULT_ROLES: Omit<Role, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Administrator',
    description: 'Full access to all features',
    permissions: ['*'],
    isSystem: true,
    color: '#ef4444',
  },
  {
    name: 'Moderator',
    description: 'Player management and chat moderation',
    permissions: [
      'dashboard.view',
      'dashboard.stats',
      'server.view_status',
      'console.view',
      'performance.view',
      'players.view',
      'players.kick',
      'players.ban',
      'players.unban',
      'players.whitelist',
      'chat.view',
      'chat.send',
      'activity.view',
    ],
    isSystem: true,
    color: '#3b82f6',
  },
  {
    name: 'Operator',
    description: 'Server management and technical tasks',
    permissions: [
      'dashboard.view',
      'dashboard.stats',
      'server.view_status',
      'server.start',
      'server.stop',
      'server.restart',
      'server.quick_settings',
      'console.view',
      'console.execute',
      'performance.view',
      'players.view',
      'players.kick',
      'players.op',
      'chat.view',
      'chat.send',
      'backups.view',
      'backups.create',
      'backups.restore',
      'scheduler.view',
      'scheduler.edit',
      'worlds.view',
      'worlds.manage',
      'mods.view',
      'mods.install',
      'mods.config',
      'mods.toggle',
      'plugins.view',
      'plugins.install',
      'plugins.config',
      'plugins.toggle',
      'config.view',
      'config.edit',
      'activity.view',
    ],
    isSystem: true,
    color: '#22c55e',
  },
  {
    name: 'Viewer',
    description: 'Read-only access to basic information',
    permissions: [
      'dashboard.view',
      'dashboard.stats',
      'server.view_status',
      'console.view',
      'performance.view',
      'players.view',
      'chat.view',
      'backups.view',
      'scheduler.view',
      'worlds.view',
      'mods.view',
      'plugins.view',
      'config.view',
      'assets.view',
      'activity.view',
    ],
    isSystem: true,
    color: '#6b7280',
  },
];

// Helper to check if a role has a specific permission
export const hasPermission = (
  role: Role,
  permission: Permission
): boolean => {
  if (role.permissions.includes('*')) {
    return true;
  }
  return role.permissions.includes(permission);
};

// Helper to check if a role has any of the specified permissions
export const hasAnyPermission = (
  role: Role,
  permissions: Permission[]
): boolean => {
  if (role.permissions.includes('*')) {
    return true;
  }
  return permissions.some((p) => role.permissions.includes(p));
};

// Helper to check if a role has all of the specified permissions
export const hasAllPermissions = (
  role: Role,
  permissions: Permission[]
): boolean => {
  if (role.permissions.includes('*')) {
    return true;
  }
  return permissions.every((p) => role.permissions.includes(p));
};
