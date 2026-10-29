/**
 * One definition of the panel's pages: router guard, sidebar, mobile
 * navigation and command palette all read from here, so a page is shown
 * exactly to the people who may open it.
 *
 * `permission` is a backend permission (see the backend's permission list);
 * a page without one is open to every signed-in account.
 */

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean
    public?: boolean
    isSetup?: boolean
    /** Permission needed to open the page. */
    permission?: string
    /** The page shows data of every server: not for accounts limited to some servers. */
    allServers?: boolean
  }
}

export type NavGroup = 'main' | 'management' | 'data' | 'admin'

export interface NavEntry {
  /** Route name. */
  name: string
  path: string
  icon: string
  /** i18n key of the page title. */
  labelKey: string
  group: NavGroup
  permission?: string
  /** Shows data of every server; hidden from accounts limited to some servers. */
  allServers?: boolean
  /** Position in the phone's bottom bar; entries without one only appear in the menu. */
  quick?: number
}

export const NAV_ENTRIES: readonly NavEntry[] = [
  {
    name: 'dashboard',
    path: '/',
    icon: 'dashboard',
    labelKey: 'nav.dashboard',
    group: 'main',
    permission: 'dashboard.view',
    quick: 1,
  },
  {
    name: 'console',
    path: '/console',
    icon: 'console',
    labelKey: 'nav.console',
    group: 'main',
    permission: 'console.view',
    quick: 2,
  },
  {
    name: 'performance',
    path: '/performance',
    icon: 'performance',
    labelKey: 'nav.performance',
    group: 'main',
    permission: 'performance.view',
    quick: 4,
  },
  {
    name: 'statistics',
    path: '/statistics',
    icon: 'statistics',
    labelKey: 'nav.statistics',
    group: 'main',
    permission: 'players.view',
  },
  {
    name: 'crashes',
    path: '/crashes',
    icon: 'console',
    labelKey: 'nav.crashes',
    group: 'main',
    permission: 'server.view_status',
  },
  {
    name: 'updates',
    path: '/updates',
    icon: 'download',
    labelKey: 'nav.updates',
    group: 'main',
    permission: 'updates.view',
  },
  { name: 'help', path: '/help', icon: 'help', labelKey: 'nav.help', group: 'main' },
  {
    name: 'wiki',
    path: '/wiki',
    icon: 'help',
    labelKey: 'nav.wiki',
    group: 'main',
    permission: 'wiki.view',
  },
  {
    name: 'players',
    path: '/players',
    icon: 'players',
    labelKey: 'nav.players',
    group: 'management',
    permission: 'players.view',
    quick: 3,
  },
  {
    name: 'playtime',
    path: '/playtime',
    icon: 'statistics',
    labelKey: 'nav.playtime',
    group: 'management',
    permission: 'players.view',
  },
  {
    name: 'liveMap',
    path: '/live-map',
    icon: 'worlds',
    labelKey: 'nav.liveMap',
    group: 'management',
    permission: 'players.view',
  },
  {
    name: 'avatarInventory',
    path: '/avatar-inventory',
    icon: 'avatarInventory',
    labelKey: 'nav.avatarInventory',
    group: 'management',
    permission: 'players.view',
  },
  {
    name: 'chat',
    path: '/chat',
    icon: 'chat',
    labelKey: 'nav.chat',
    group: 'management',
    permission: 'chat.view',
  },
  {
    name: 'whitelist',
    path: '/whitelist',
    icon: 'whitelist',
    labelKey: 'nav.whitelist',
    group: 'management',
    permission: 'players.whitelist',
  },
  {
    name: 'permissions',
    path: '/permissions',
    icon: 'permissions',
    labelKey: 'nav.permissions',
    group: 'management',
    permission: 'players.permissions',
  },
  {
    name: 'worlds',
    path: '/worlds',
    icon: 'worlds',
    labelKey: 'nav.worlds',
    group: 'management',
    permission: 'worlds.view',
  },
  {
    name: 'mods',
    path: '/mods',
    icon: 'mods',
    labelKey: 'nav.mods',
    group: 'management',
    permission: 'mods.view',
  },
  {
    name: 'modStatus',
    path: '/mod-status',
    icon: 'statistics',
    labelKey: 'nav.modStatus',
    group: 'management',
    permission: 'mods.panel.view',
  },
  {
    name: 'assets',
    path: '/assets',
    icon: 'assets',
    labelKey: 'nav.assets',
    group: 'management',
    permission: 'assets.view',
  },
  {
    name: 'backups',
    path: '/backups',
    icon: 'backup',
    labelKey: 'nav.backups',
    group: 'data',
    permission: 'backups.view',
  },
  {
    name: 'scheduler',
    path: '/scheduler',
    icon: 'scheduler',
    labelKey: 'nav.scheduler',
    group: 'data',
    permission: 'scheduler.view',
  },
  {
    name: 'eventActions',
    path: '/event-actions',
    icon: 'scheduler',
    labelKey: 'nav.eventActions',
    group: 'data',
    permission: 'scheduler.view',
  },
  {
    name: 'replay',
    path: '/replay',
    icon: 'backup',
    labelKey: 'nav.replay',
    group: 'data',
    permission: 'replay.view',
  },
  {
    name: 'configuration',
    path: '/configuration',
    icon: 'configuration',
    labelKey: 'nav.configuration',
    group: 'data',
    permission: 'config.view',
  },
  {
    name: 'files',
    path: '/files',
    icon: 'files',
    labelKey: 'nav.files',
    group: 'data',
    permission: 'files.read',
  },
  {
    name: 'settings',
    path: '/settings',
    icon: 'settings',
    labelKey: 'nav.settings',
    group: 'data',
    permission: 'settings.view',
  },
  {
    name: 'servers',
    path: '/servers',
    icon: 'configuration',
    labelKey: 'nav.servers',
    group: 'admin',
    permission: 'servers.list',
  },
  {
    name: 'users',
    path: '/users',
    icon: 'users',
    labelKey: 'nav.users',
    group: 'admin',
    permission: 'users.view',
  },
  {
    name: 'roles',
    path: '/roles',
    icon: 'roles',
    labelKey: 'nav.roles',
    group: 'admin',
    permission: 'roles.view',
  },
  {
    name: 'activity',
    path: '/activity',
    icon: 'activity',
    labelKey: 'nav.activityLog',
    group: 'admin',
    permission: 'activity.view',
    allServers: true,
  },
  {
    name: 'audit',
    path: '/audit',
    icon: 'activity',
    labelKey: 'nav.audit',
    group: 'admin',
    permission: 'audit.view',
  },
  {
    name: 'webhooks',
    path: '/webhooks',
    icon: 'scheduler',
    labelKey: 'nav.webhooks',
    group: 'admin',
    permission: 'webhooks.view',
  },
  {
    name: 'security',
    path: '/security',
    icon: 'settings',
    labelKey: 'nav.security',
    group: 'admin',
  },
]

/** Pages that are opened from elsewhere and have no menu entry of their own. */
const UNLISTED_ROUTE_PERMISSIONS: Record<string, string | undefined> = {
  playerProfile: 'players.view',
}

const ROUTE_PERMISSIONS: Record<string, string | undefined> = {
  ...Object.fromEntries(NAV_ENTRIES.map((e) => [e.name, e.permission])),
  ...UNLISTED_ROUTE_PERMISSIONS,
}

/** Permission a route needs; undefined when any signed-in account may open it. */
export function routePermission(routeName: string): string | undefined {
  return ROUTE_PERMISSIONS[routeName]
}

export type HasPermission = (permission: string) => boolean

/** What the account's server access adds to its permissions. */
export interface AccessContext {
  /** The account is limited to some servers. */
  hasServerList?: boolean
}

export function canOpen(
  entry: Pick<NavEntry, 'permission' | 'allServers'>,
  has: HasPermission,
  access: AccessContext = {},
): boolean {
  if (entry.allServers && access.hasServerList) return false
  return !entry.permission || has(entry.permission)
}

/** Whether a route (by name) shows data of every server. */
export function routeNeedsAllServers(routeName: string): boolean {
  return NAV_ENTRIES.some((e) => e.name === routeName && e.allServers === true)
}

/** The entries an account may open, in menu order. */
export function visibleEntries(has: HasPermission, access: AccessContext = {}): NavEntry[] {
  return NAV_ENTRIES.filter((e) => canOpen(e, has, access))
}

/** The entries for the phone's bottom bar, in their fixed order. */
export function quickEntries(has: HasPermission, access: AccessContext = {}): NavEntry[] {
  return visibleEntries(has, access)
    .filter((e) => e.quick !== undefined)
    .sort((a, b) => (a.quick ?? 0) - (b.quick ?? 0))
}

/** Where to send someone who may not open the page they asked for. */
export function firstOpenPath(has: HasPermission, access: AccessContext = {}): string | null {
  return visibleEntries(has, access)[0]?.path ?? null
}
