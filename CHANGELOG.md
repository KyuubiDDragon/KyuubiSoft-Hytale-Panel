# Changelog

All notable changes to the Hytale Server Manager will be documented in this file.

## [1.7.1] - 2026-01-19

### Added

- **Command Help Page**: Complete in-game /help GUI recreation for the panel
  - 70+ commands organized in 8 categories (Player, Admin, World, Teleport, Entities, Blocks, XP, Debug)
  - Live search functionality to filter commands by name, description, or usage
  - Copy-to-clipboard for quick command usage
  - Permission display for each command
  - Tips for relative coordinates (~) and target selectors (@a, @p, @r, @s)
  - Full localization in English, German, and Portuguese

- **Accept Early Plugins Option**: New toggle in Settings page
  - Enable/disable the `--accept-early-plugins` server flag
  - Allows loading of early-stage plugins before server fully starts
  - Warning about potential instability with early plugins

### Fixed

- **Online Players Display**: Players now show correctly after deleting player/world folders
  - Fixed edge case where deleted player data caused display issues

- **Player Commands via Plugin API**: Commands now work correctly through the API
  - Gamemode changes work properly
  - Kill command functions correctly
  - Respawn command fixed
  - Teleport commands work as expected

- **JVM Memory Display**: No longer shows 0/0 MB
  - Fixed memory stats retrieval from server
  - Proper display of used/total heap memory

- **Performance Monitor Graphs**: Charts now fill available space correctly
  - Fixed layout issues causing graphs to be too small
  - Responsive sizing for different screen sizes

- **Modtale Plugins Installation**: Plugins now install to correct `/mods` directory
  - Fixed path resolution for Modtale downloads

- **Chat Log Localization**: Fully localized in English and German
  - All UI elements properly translated
  - Date/time formatting respects locale

## [1.7.0] - 2026-01-18

### Added

- **Granular Permission System**: Complete role-based access control
  - 53 individual permissions across 18 categories
  - Custom role creation with color badges
  - Permission categories: Dashboard, Server, Console, Performance, Players, Chat, Backups, Scheduler, Worlds, Mods, Plugins, Config, Assets, Users, Roles, Activity, Hytale Auth, Settings
  - Wildcard `*` permission for full admin access
  - System roles (Administrator, Moderator, Operator, Viewer) with predefined permissions

- **i18n for Permission Descriptions**: Internationalized permission management
  - All 53 permissions have translated descriptions in German, English, and Portuguese
  - Nested translation structure for proper vue-i18n compatibility
  - Permission display shows human-readable name with technical key below

- **Styled Permission Checkboxes**: Improved UI for role permission editing
  - Custom styled checkboxes matching app design (orange when checked)
  - Replaced standard HTML checkboxes with accessible peer-checked pattern

- **Enhanced Player Menu**: Complete redesign of the player management interface
  - Click on any player (online or offline) to open detailed player modal
  - Tabbed interface: Overview, Inventory, Appearance, Chat, Deaths
  - Player avatar display in modal header (searched from game assets)
  - Unified player list showing both online and offline players with status indicators

- **Player Inventory Display**: View player inventory from saved JSON files
  - Shows all inventory slots with item icons from extracted game assets
  - Hotbar, main inventory, and tools sections
  - Item tooltips with item names and quantities
  - Item icon caching for fast loading

- **Player Appearance Tab**: View equipped items
  - Head, chest, legs, feet equipment slots
  - Visual display with item icons

- **Death Positions Tab**: Track player death locations
  - List of recent death positions with coordinates
  - World/dimension information
  - Teleport button to send player back to death location
  - Day information showing when death occurred

- **Player Actions**: New actions available via plugin API
  - Heal player to full health
  - Clear player inventory
  - Give items with autocomplete (item names with icons)
  - Teleport to coordinates or death position
  - Kick, ban, whitelist management

- **Item Autocomplete**: Smart item selection for give command
  - Search items by name with live filtering
  - Item icons displayed in dropdown
  - Quantity input field

- **Chat Log System**: Complete overhaul of chat message storage
  - Daily file rotation: Messages stored in `data/chat/global/YYYY-MM-DD.json`
  - Per-player chat logs: `data/chat/players/{name}/YYYY-MM-DD.json`
  - Unlimited message history (no more 1000 message limit)
  - UUID tracking for each chat message (tracks players across name changes)
  - Time range filter in Chat view: 7 days, 14 days, 30 days, or all
  - Shows available days count in the UI

- **Chat Page**: Dedicated page for global chat history
  - Real-time updates via WebSocket
  - Search and filter functionality
  - Player name coloring
  - Pagination for large chat logs

### Fixed

- **User Creation Role Assignment**: Fixed users always being created with "Viewer" role
  - Frontend API was sending `role` instead of `roleId` in request body
  - Backend expected `roleId` parameter, fell back to default 'viewer'
  - Custom role selection now works correctly when creating users

- **Empty Navigation Sections**: Hide sidebar sections when user has no permissions
  - Added `v-if` conditions to Main, Management, and Data sections
  - Sections now hide completely if user has no items with required permissions
  - Admin section already had this behavior

- **Mods & Plugins Page Permission Handling**: Fixed page crash with partial permissions
  - Changed from `Promise.all` to `Promise.allSettled` for loading mods/plugins
  - Checks user permissions before making API calls
  - Users with only `mods.view` can now see mods without `plugins.view`
  - Error only shows if both requests fail (not due to missing permissions)

- **Chat Endpoint Permissions**: Fixed chat requiring `players.view` instead of `chat.view`
  - Changed `/api/players/chat` endpoint from `players.view` to `chat.view`
  - Changed `/api/players/:name/chat` endpoint from `players.view` to `chat.view`
  - Sidebar and backend now use consistent `chat.view` permission

- **Chat Event Detection**: Fixed PlayerChatEvent not being captured
  - Changed from `eventRegistry.register()` to `eventRegistry.registerGlobal()` based on Serilum's Chat-History plugin
  - Chat messages now properly captured and broadcasted via WebSocket

- **Online Player Detection**: Improved accuracy of online status
  - Plugin API used as source of truth for online players
  - Fallback to console commands when plugin unavailable

- **Item Icon Loading**: Fixed various issues with item icon display
  - Better path searching with namespace stripping
  - Fallback search when exact match not found
  - In-memory caching for performance

### Changed

- **Permission Display Order**: Improved readability in role editor
  - Human-readable permission name now displayed prominently on top
  - Technical permission key (e.g., `activity.clear`) shown smaller below
  - Removed monospace font from name, applied to technical key instead

- **KyuubiSoft API Plugin v1.1.6**:
  - Fixed chat event registration using `registerGlobal()` for global chat listener
  - Added UUID to chat message broadcasts
  - Added player action endpoints (heal, clearInventory, giveItem, teleport)
  - Added death position tracking with world coordinates
  - Removed debug logging for cleaner server logs

## [1.5.0] - 2025-01-17

### Added

- **Asset Explorer**: New feature to browse and analyze Hytale game assets
  - Extract and browse the contents of Assets.zip from the server
  - Directory navigation with breadcrumb trail
  - File viewers for different content types:
    - JSON viewer with syntax highlighting
    - Image preview (PNG, JPG, GIF, WebP, BMP, SVG)
    - Text viewer for config files, scripts, UI files, shaders
    - Hex viewer for binary files
  - Advanced search functionality:
    - Plain text search in filenames
    - Glob patterns (`*.json`, `sign*.json`, `data/**/*.png`)
    - Regex support (`/sign\d+\.json/i`)
    - File type filter dropdown (JSON, Images, UI, Shaders, etc.)
    - Content search within text files
  - Async extraction with live progress display (file count, current file)
  - Handles large archives (3GB+) without timeout or memory issues
  - Persistent cache via Docker volume (survives container rebuilds)
  - Assets are excluded from backups (server-provided data)
  - Automatic update detection when Assets.zip changes

- **Reverse Proxy Support**: Added `TRUST_PROXY` environment variable for domain routing behind reverse proxies
  - Enables proper handling of `X-Forwarded-*` headers when running behind nginx, traefik, caddy, etc.
  - Required for HTTPS access via custom domains (e.g., `manager.example.com`)
  - Set `TRUST_PROXY=true` in `.env` when using a reverse proxy

- **Patchline Toggle**: Added UI toggle in Settings to switch between "release" and "pre-release" patchlines without editing the .env file
  - Panel stores patchline preference in `/opt/hytale/data/panel-config.json`
  - When patchline changes, server files (HytaleServer.jar, Assets.zip, .hytale-version) are automatically deleted to trigger redownload on next container restart
  - Shows restart banner when patchline is changed

- **Dashboard Patchline Badge**: Added colored badge in Dashboard Server Info card showing current patchline
  - Green badge for "release"
  - Orange badge for "pre-release"
  - Falls back to panel setting when server info unavailable

- **Mod Store Localization**: Added multi-language support for mod descriptions and hints
  - Mod entries now support localized descriptions (DE, EN, PT-BR)
  - Added hints field for additional mod-specific information (e.g., port configuration notes)
  - EasyWebMap includes hint about configuring WEBMAP_PORT in .env

- **Translations**: Added German, English, and Brazilian Portuguese translations for:
  - Patchline settings and labels
  - Restart notifications
  - Mod store hints
  - Console reconnect and load all buttons

- **Console Reconnect Button**: Added manual reconnect button that appears when WebSocket connection is lost
  - Allows users to manually reconnect without refreshing the page

- **Console Load All Logs**: Added button to load all available logs from the server
  - Backend limit increased from 1,000 to 10,000 logs
  - `tail=0` parameter loads all available logs

- **Enhanced Update Check**: Update check now shows both release and pre-release versions
  - Backend checks both patchlines in parallel for faster results
  - Dashboard displays version cards for both release and pre-release
  - Active patchline is highlighted with colored border
  - "Update available!" indicator shown for each patchline with updates

### Fixed

- **Manager Container Healthcheck**: Fixed container showing "unhealthy" status
  - Increased healthcheck start-period from 5s to 30s
  - Added wget to alpine image for healthcheck command
  - Healthcheck now properly waits for application startup

- **Update Check Patchline**: Fixed hardcoded 'release' patchline in update check endpoint to use configured patchline setting

- **Console Log Stream**: Fixed log streaming issues where updates would stop arriving
  - Backend now automatically restarts log stream after 3 seconds when it ends or errors
  - Added Docker multiplexed stream demultiplexing to properly parse 8-byte header frames
  - WebSocket reconnection now uses exponential backoff (3s, 6s, 12s, 24s, 48s)
  - Added automatic retry after 30 seconds even when max reconnect attempts reached

- **Console Auto-Scroll**: Fixed auto-scroll not always scrolling to bottom
  - Added 100ms polling interval to continuously check if scroll is needed
  - Scroll function now retries multiple times to ensure DOM is fully rendered
  - Uses `flush: 'post'` and `requestAnimationFrame` for reliable timing

- **Console Store Reactivity**: Fixed logs not always updating in the UI
  - Changed from `slice()` to `splice()` for in-place array modification
  - Added update counter (`logsUpdated`) for guaranteed reactivity

- **Dashboard Patchline Display**: Fixed dashboard showing wrong patchline after switching
  - Now prioritizes panel setting (user's configuration) over plugin value
  - Plugin value is only used as fallback when panel setting unavailable

- **Backup Download**: Fixed "Missing or invalid authorization header" error when downloading backups
  - Changed from direct URL open to blob download via axios with auth header
  - Creates temporary download link for the file blob

- **Backup Size Display**: Fixed Hytale server backups showing as 0 MB
  - Added support for additional backup formats (.bak, .backup, backup_*, hytale_*)
  - Small files now show at least 0.01 MB instead of rounding to 0
  - Hytale server backups (backup_*) are now correctly detected as "auto" type
  - Added error handling for files with permission issues
