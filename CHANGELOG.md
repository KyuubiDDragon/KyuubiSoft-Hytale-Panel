# Changelog

All notable changes to the Hytale Server Manager will be documented in this file.

## [1.6.0] - 2026-01-18

### Added

- **Chat Log System**: Complete overhaul of chat message storage
  - Daily file rotation: Messages stored in `data/chat/global/YYYY-MM-DD.json`
  - Per-player chat logs: `data/chat/players/{name}/YYYY-MM-DD.json`
  - Unlimited message history (no more 1000 message limit)
  - UUID tracking for each chat message (tracks players across name changes)
  - Time range filter in Chat view: 7 days, 14 days, 30 days, or all
  - Shows available days count in the UI

- **Player Chat Tab**: Enhanced chat functionality in player detail modal
  - Shows player-specific chat history with time filter
  - UUID linked to player for tracking

### Fixed

- **Chat Event Detection**: Fixed PlayerChatEvent not being captured
  - Changed from `eventRegistry.register()` to `eventRegistry.registerGlobal()` based on Serilum's Chat-History plugin
  - Chat messages now properly captured and broadcasted via WebSocket

### Changed

- **KyuubiSoft API Plugin v1.1.6**:
  - Fixed chat event registration using `registerGlobal()` for global chat listener
  - Added UUID to chat message broadcasts
  - Removed debug logging for cleaner server logs
  - Removed unused log interceptor code

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
