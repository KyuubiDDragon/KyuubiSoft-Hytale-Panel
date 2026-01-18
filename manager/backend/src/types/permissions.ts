/**
 * Permission system type definitions
 * Defines all available permissions, roles, and related interfaces
 */

// All available permissions with German descriptions
export const PERMISSIONS = {
  // Dashboard
  'dashboard.view': 'Dashboard anzeigen',
  'dashboard.stats': 'Dashboard-Statistiken anzeigen',

  // Server
  'server.view_status': 'Serverstatus anzeigen',
  'server.start': 'Server starten',
  'server.stop': 'Server stoppen',
  'server.restart': 'Server neustarten',
  'server.quick_settings': 'Schnelleinstellungen bearbeiten',

  // Console
  'console.view': 'Konsole anzeigen',
  'console.execute': 'Konsolenbefehle ausführen',

  // Performance
  'performance.view': 'Performance-Metriken anzeigen',

  // Players
  'players.view': 'Spielerliste anzeigen',
  'players.kick': 'Spieler kicken',
  'players.ban': 'Spieler bannen',
  'players.unban': 'Spieler entbannen',
  'players.whitelist': 'Whitelist verwalten',
  'players.op': 'Operator-Status verwalten',
  'players.permissions': 'Spielerberechtigungen verwalten',
  'players.teleport': 'Spieler teleportieren',
  'players.kill': 'Spieler töten',
  'players.respawn': 'Spieler respawnen',
  'players.gamemode': 'Spielmodus ändern',
  'players.give': 'Items geben',
  'players.heal': 'Spieler heilen',
  'players.effects': 'Effekte verwalten',
  'players.clear_inventory': 'Inventar leeren',
  'players.message': 'Nachrichten senden',

  // Chat
  'chat.view': 'Chat anzeigen',
  'chat.send': 'Chatnachrichten senden',

  // Backups
  'backups.view': 'Backups anzeigen',
  'backups.create': 'Backups erstellen',
  'backups.restore': 'Backups wiederherstellen',
  'backups.delete': 'Backups löschen',
  'backups.download': 'Backups herunterladen',

  // Scheduler
  'scheduler.view': 'Zeitplaner anzeigen',
  'scheduler.edit': 'Zeitplaner bearbeiten',

  // Worlds
  'worlds.view': 'Welten anzeigen',
  'worlds.manage': 'Welten verwalten',

  // Mods
  'mods.view': 'Mods anzeigen',
  'mods.install': 'Mods installieren',
  'mods.delete': 'Mods löschen',

  // Plugins
  'plugins.view': 'Plugins anzeigen',
  'plugins.install': 'Plugins installieren',
  'plugins.delete': 'Plugins löschen',

  // Config
  'config.view': 'Konfiguration anzeigen',
  'config.edit': 'Konfiguration bearbeiten',

  // Assets
  'assets.view': 'Assets anzeigen',
  'assets.manage': 'Assets verwalten',

  // Users
  'users.view': 'Benutzer anzeigen',
  'users.create': 'Benutzer erstellen',
  'users.edit': 'Benutzer bearbeiten',
  'users.delete': 'Benutzer löschen',

  // Roles
  'roles.view': 'Rollen anzeigen',
  'roles.manage': 'Rollen verwalten',

  // Activity
  'activity.view': 'Aktivitätslog anzeigen',
  'activity.clear': 'Aktivitätslog löschen',

  // Hytale Auth
  'hytale_auth.manage': 'Hytale-Authentifizierung verwalten',

  // Settings
  'settings.view': 'Einstellungen anzeigen',
  'settings.edit': 'Einstellungen bearbeiten',
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
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

// Default role templates
export const DEFAULT_ROLES: Omit<Role, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Administrator',
    description: 'Vollzugriff auf alle Funktionen',
    permissions: ['*'],
    isSystem: true,
    color: '#ef4444',
  },
  {
    name: 'Moderator',
    description: 'Spielerverwaltung und Chat-Moderation',
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
    description: 'Serververwaltung und technische Aufgaben',
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
      'plugins.view',
      'plugins.install',
      'config.view',
      'config.edit',
      'activity.view',
    ],
    isSystem: true,
    color: '#22c55e',
  },
  {
    name: 'Viewer',
    description: 'Nur-Lese-Zugriff auf grundlegende Informationen',
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
