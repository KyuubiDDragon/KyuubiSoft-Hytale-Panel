# Features

Complete overview of all KyuubiSoft Hytale Panel features.

---

## Dashboard

The dashboard provides a quick overview of server status:

- **Server Status** - Online/Offline with uptime
- **Player Count** - Current and maximum players
- **Resource Usage** - CPU and RAM in real-time
- **Quick Actions** - Start, Stop, Restart buttons
- **Activity Feed** - Recent admin actions

---

## Live Console

Real-time server logging with advanced features:

### Features
- **Real-time Logs** - Live streaming via WebSocket
- **Log Filtering** - By level (INFO, WARN, ERROR)
- **Search Function** - Search through logs
- **Auto-Scroll** - Automatic scrolling to new entries
- **Command History** - Access to previous commands
- **Copy** - Copy logs to clipboard
- **Load All Logs** - Up to 10,000 lines

### Execute Commands
```
/say Hello World!
/time set day
/weather clear
```

---

## Performance Monitor

Detailed performance monitoring:

### Metrics
| Metric | Description |
|--------|-------------|
| CPU | Processor usage in % |
| RAM | Memory usage (Used/Total) |
| JVM Heap | Java Heap Memory |
| TPS | Ticks Per Second (with plugin) |
| MSPT | Milliseconds Per Tick |

### Graphs
- Real-time graphs with history
- Adjustable time period
- Export functionality

---

## Player Management

Comprehensive player management with all necessary actions:

### Player List
- **Online Players** - Currently connected players
- **Offline Players** - All players who ever joined
- **Search Function** - Quick player search

### Player Actions

| Action | Description | Permission |
|--------|-------------|------------|
| **Kick** | Remove player from server | `players.kick` |
| **Ban** | Permanently ban player | `players.ban` |
| **Unban** | Remove ban | `players.unban` |
| **Teleport** | Teleport to coordinates/player | `players.teleport` |
| **Gamemode** | Change game mode (Creative/Adventure) | `players.gamemode` |
| **Give** | Give items | `players.give` |
| **Heal** | Heal player | `players.heal` |
| **Kill** | Kill player | `players.kill` |
| **Respawn** | Respawn player | `players.respawn` |
| **Effects** | Apply/remove status effects | `players.effects` |
| **Clear Inventory** | Clear player inventory | `players.clear_inventory` |
| **Message** | Send private message | `players.message` |

### Player Details (with Plugin)
- **Overview** - Name, UUID, Position, Gamemode
- **Inventory** - Item display with icons
- **Appearance** - Player skin/appearance
- **Chat History** - All messages from player
- **Death Positions** - Last death locations with teleport option

---

## Player Statistics

Detailed statistics and analytics:

- **Top Players** - Sorted by playtime
- **Playtime Tracking** - Total playtime per player
- **Activity Trends** - Daily/Weekly activity
- **Engagement Metrics** - Average session duration

---

## Chat System

Complete chat management:

- **Global Chat** - All messages
- **Player Chat** - Messages filtered by player
- **Time Filter** - 7/14/30 days or all
- **Search Function** - Search by content
- **UUID Tracking** - Track players across name changes

---

## Whitelist & Bans

Server access control:

### Whitelist
- Add/remove players from whitelist
- Enable/disable whitelist
- Import/Export functionality

### Banlist
- Ban/unban players
- Specify ban reason
- View ban history

---

## Backup System

Robust backup management:

### Manual Backups
- **Create Backup** - With optional name
- **Restore Backup** - Full restoration
- **Download Backup** - As .tar.gz archive
- **Delete Backup** - Remove old backups

### Automatic Backups
- Configurable in Scheduler
- Retention policy (number to keep)
- Scheduled creation

### Backup Contents
- World data
- Player data
- Configuration files
- Mods & Plugins

---

## Scheduler

Automated tasks and scheduling:

### Auto-Backups
- Configure schedule
- Retention policy
- Notifications

### Auto-Restart
- Scheduled restarts
- Countdown warnings
- Player notification before restart

### Server Broadcasts
- Scheduled announcements
- Recurring messages
- Event-based broadcasts

### Quick Commands
- Custom quick commands
- One-click execution
- Categorization

---

## World Management

Overview of all server worlds:

- **World List** - All loaded worlds
- **World Statistics** - Size, player count
- **World Information** - Seed, spawn position

---

## Mods & Plugins

### Mod Management
- **Upload** - Upload .jar files
- **Enable/Disable** - Toggle mods on/off
- **Configuration** - Edit mod config files
- **Delete** - Remove mods

### Plugin Management
- Same features as mods
- Separate plugin folder

### Mod Stores
- **Modtale Integration** - Browse and install mods
- **StackMart Integration** - Discover resources

---

## Asset Explorer

Browse and analyze Hytale assets:

### Features
- **Directory Browser** - Navigate through assets
- **File Viewer** - JSON, images, text, hex
- **Search** - Plaintext, Glob, Regex
- **Download** - Download assets

### Supported Formats
- JSON files with syntax highlighting
- Images (PNG, JPG, etc.)
- Text files
- Binary files (Hex view)

---

## Configuration Editor

Edit server configuration directly:

### Supported Formats
- JSON
- Properties
- YAML
- TOML
- INI

### Features
- Syntax highlighting
- Validation
- Backup before changes

---

## WebMap Integration

Live server map with EasyWebMap mod:

- **Real-time Map** - Live world view
- **Player Positions** - Players on the map
- **Zones/Regions** - Display areas
- **HTTPS Proxy** - Proxied through panel

Access: `http://your-server:18081`

---

## Activity Log

Complete audit trail of all admin actions:

### Logged Actions
- User logins
- Server Start/Stop/Restart
- Player actions (Kick, Ban, etc.)
- Configuration changes
- Backup operations
- User/Role changes

### Features
- Filter by category
- Filter by user
- Timestamps
- Success/Failure status

---

## Hytale Auth

Server authentication management:

- **Device Login** - OAuth authentication
- **View Status** - Authentication status
- **Reset Credentials** - If issues occur
- **Persistence Mode** - Memory or Encrypted

---

## Official Downloader

Automatic server download:

- **Automatic Download** - Download server files
- **Select Patchline** - Release or Pre-Release
- **Update Check** - Check for new versions
- **Auto-Update** - Automatic updates (optional)

---

## Multi-Language Support

The panel supports multiple languages:

| Language | Code |
|----------|------|
| German | `de` |
| English | `en` |
| Portuguese | `pt` |

Language selection in Panel under **Settings**.

---

## Next Steps

- [[User-Management]] - Set up users and roles
- [[API-Documentation]] - Use the REST API
- [[Server-Commands]] - All available commands
