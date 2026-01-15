<div align="center">

# KyuubiSoft Panel - Hytale Server Management

### Vollautomatisches Docker-Setup mit Web Admin Panel by KyuubiSoft

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)
[![Discord](https://img.shields.io/badge/Discord-KyuubiDDragon-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

<img src="https://img.shields.io/badge/KyuubiSoft_Panel-orange?style=for-the-badge" alt="KyuubiSoft Panel"/>
<img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"/>
<img src="https://img.shields.io/badge/Node.js-Backend-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"/>
<img src="https://img.shields.io/badge/Vue.js-Frontend-4FC08D?style=for-the-badge&logo=vue.js&logoColor=white" alt="Vue.js"/>

---

**[Deutsch](#deutsch)** | **[English](#english)** | **[Commands](docs/COMMANDS.md)**

</div>

---

## Screenshots

<div align="center">
<table>
<tr>
<td align="center"><strong>Dashboard</strong></td>
<td align="center"><strong>Console</strong></td>
</tr>
<tr>
<td><img src="docs/screenshots/dashboard.png" width="400" alt="Dashboard"/></td>
<td><img src="docs/screenshots/console.png" width="400" alt="Console"/></td>
</tr>
<tr>
<td align="center"><strong>Player Management</strong></td>
<td align="center"><strong>Performance</strong></td>
</tr>
<tr>
<td><img src="docs/screenshots/players.png" width="400" alt="Players"/></td>
<td><img src="docs/screenshots/performance.png" width="400" alt="Performance"/></td>
</tr>
</table>
</div>

---

## Deutsch

KyuubiSoft Panel - Vollautomatisches Docker-Setup für Hytale Server mit modernem Web-basiertem Admin Panel.

### Features

| Feature | Beschreibung |
|---------|--------------|
| **Auto-Download** | Automatischer Server-Download via offiziellem Hytale Downloader |
| **Web Admin Panel** | Modernes UI mit Dark Theme und Echtzeit-Updates |
| **Multi-User** | Mehrere Benutzer mit Rollen (Admin, Moderator, Operator, Viewer) |
| **Live Console** | Echtzeit-Logs mit Filterung und Auto-Scroll |
| **Performance Monitor** | CPU, RAM und Spieler-Statistiken mit Graphen |
| **Spieler Verwaltung** | Kick, Ban, Teleport, Gamemode, Items geben, Heal und mehr |
| **Spieler Statistiken** | Top-Spieler, Spielzeit-Tracking, Aktivitäts-Trends |
| **Mods & Plugins** | Upload, Aktivieren/Deaktivieren, Config Editor |
| **Backups** | Automatische und manuelle Backups mit Restore |
| **Geplante Backups** | Tägliche automatische Backups zu einstellbarer Uhrzeit |
| **Server Broadcasts** | Nachrichten an alle Spieler, geplante Ankündigungen |
| **Quick Commands** | Ein-Klick Befehle für häufige Server-Aktionen |
| **Quick Settings** | Schnelleinstellungen für ServerName, MOTD, MaxPlayers |
| **Whitelist & Bans** | Komplette Zugriffskontrolle |
| **Permissions** | Benutzer und Gruppen mit Berechtigungen |
| **Activity Log** | Alle Admin-Aktionen werden protokolliert |
| **Mehrsprachig** | Deutsch und Englisch |

### Quick Start mit Portainer

#### 1. Stack hinzufügen
- Portainer → Stacks → Add Stack
- Name: `hytale`
- Build method: Repository
- Repository URL: `https://github.com/KyuubiDDragon/Hytale-Server`

#### 2. Server-Dateien

**Option A: Offizieller Hytale Downloader (empfohlen)**

Lädt automatisch vom offiziellen Server. Erfordert einmaligen OAuth-Login.

| Variable | Wert |
|----------|------|
| `USE_HYTALE_DOWNLOADER` | `true` |

Beim ersten Start erscheint ein Link + Code im Log. Im Browser öffnen und einloggen.

**Option B: Eigene Download-URLs**

Lade die Dateien auf deinen NAS und gib die URLs an.

| Variable | Wert |
|----------|------|
| `SERVER_JAR_URL` | `https://dein-nas/HytaleServer.jar` |
| `ASSETS_URL` | `https://dein-nas/Assets.zip` |

Dateien findest du in: `%appdata%\Hytale\install\release\package\game\latest\`

**Option C: Manuell kopieren**

```bash
docker cp Server/HytaleServer.jar hytale:/opt/hytale/server/
docker cp Assets.zip hytale:/opt/hytale/server/
docker restart hytale
```

#### 3. Server authentifizieren

Nach dem ersten Start muss der Hytale-Server authentifiziert werden:

```bash
docker attach hytale
/auth login device
```

Link im Browser öffnen, Code eingeben, fertig.

### KyuubiSoft Panel

Das Admin Panel ist unter `http://SERVER-IP:18080` erreichbar.

**Standard-Login:**
| Feld | Wert |
|------|------|
| User | `admin` |
| Password | `admin` |

> **Wichtig:** Bitte Passwort nach dem ersten Login ändern!

**Panel Features:**
- Dashboard mit Server-Status und Ressourcen
- Live Console mit Log-Filterung und Command-Historie
- Performance Monitoring mit Echtzeit-Graphen
- **Spieler Statistiken** mit Top-Spielern und Aktivitäts-Charts
- Spieler Verwaltung mit erweiterten Aktionen
- Whitelist & Ban System
- Permissions Verwaltung (Benutzer & Gruppen)
- Mods & Plugins mit Upload und Config Editor
- Backup System mit Restore-Funktion
- **Geplante Backups** mit automatischer Rotation
- **Server Broadcasts** und geplante Ankündigungen
- **Quick Commands** für häufige Aktionen
- **Quick Settings** für Servername, MOTD, Passwort, MaxPlayers
- Server Config Editor
- Activity Log für alle Aktionen
- Multi-User mit Rollen-System (Admin, Moderator, Operator, Viewer)

### Benutzerrollen

| Rolle | Rechte |
|-------|--------|
| **Admin** | Vollzugriff auf alle Funktionen |
| **Moderator** | Server-Verwaltung, aber keine Benutzerverwaltung |
| **Operator** | Dashboard, Console, Performance, Server-Neustart |
| **Viewer** | Nur Lesezugriff |

### Umgebungsvariablen

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `JAVA_MIN_RAM` | 3G | Minimaler RAM |
| `JAVA_MAX_RAM` | 4G | Maximaler RAM |
| `SERVER_PORT` | 5520 | UDP Port |
| `ENABLE_BACKUP` | true | Auto-Backups aktivieren |
| `BACKUP_FREQUENCY` | 30 | Backup-Intervall in Minuten |
| `AUTH_MODE` | - | `offline` für LAN-only |
| `USE_HYTALE_DOWNLOADER` | false | Offiziellen Downloader nutzen |
| `HYTALE_PATCHLINE` | release | `release` oder `pre-release` |
| `SERVER_JAR_URL` | - | URL zu HytaleServer.jar |
| `ASSETS_URL` | - | URL zu Assets.zip |
| `MANAGER_USER` | admin | Admin Panel Benutzername |
| `MANAGER_PASSWORD` | admin | Admin Panel Passwort |

### Netzwerk

Hytale nutzt **UDP Port 5520** (QUIC), nicht TCP.

Router Port-Forwarding:
- Protokoll: **UDP**
- Port: **5520**

### Volumes

| Volume | Inhalt |
|--------|--------|
| `hytale-server` | Server JAR + Assets |
| `hytale-data` | Welten, Configs |
| `hytale-backups` | Automatische Backups |
| `hytale-plugins` | Server Plugins |
| `hytale-mods` | Server Mods |
| `hytale-downloader` | Downloader + Credentials |

### Befehle

```bash
# Logs anzeigen
docker logs -f hytale

# Console öffnen (verlassen: Ctrl+P, Ctrl+Q)
docker attach hytale

# Manuelles Backup
docker exec hytale /opt/hytale/backup.sh

# Neustart
docker restart hytale
```

### Updates

Mit Hytale Downloader:
```bash
docker stop hytale
docker volume rm hytale-server
docker start hytale
```

---

## English

KyuubiSoft Panel - Fully automated Docker setup for Hytale Server with modern web-based admin panel.

### Features

| Feature | Description |
|---------|-------------|
| **Auto-Download** | Automatic server download via official Hytale Downloader |
| **Web Admin Panel** | Modern UI with dark theme and real-time updates |
| **Multi-User** | Multiple users with roles (Admin, Moderator, Operator, Viewer) |
| **Live Console** | Real-time logs with filtering and auto-scroll |
| **Performance Monitor** | CPU, RAM and player statistics with graphs |
| **Player Management** | Kick, ban, teleport, gamemode, give items, heal and more |
| **Player Statistics** | Top players, playtime tracking, activity trends |
| **Mods & Plugins** | Upload, enable/disable, config editor |
| **Backups** | Automatic and manual backups with restore |
| **Scheduled Backups** | Daily automatic backups at configurable time |
| **Server Broadcasts** | Messages to all players, scheduled announcements |
| **Quick Commands** | One-click commands for common server actions |
| **Quick Settings** | Fast config for ServerName, MOTD, MaxPlayers |
| **Whitelist & Bans** | Complete access control |
| **Permissions** | Users and groups with permissions |
| **Activity Log** | All admin actions are logged |
| **Multilingual** | German and English |

### Quick Start with Portainer

#### 1. Add Stack
- Portainer → Stacks → Add Stack
- Name: `hytale`
- Build method: Repository
- Repository URL: `https://github.com/KyuubiDDragon/Hytale-Server`

#### 2. Server Files

**Option A: Official Hytale Downloader (recommended)**

Downloads automatically from official server. Requires one-time OAuth login.

| Variable | Value |
|----------|-------|
| `USE_HYTALE_DOWNLOADER` | `true` |

On first start, a link + code will appear in the log. Open in browser and login.

**Option B: Custom Download URLs**

Upload files to your NAS and provide the URLs.

| Variable | Value |
|----------|-------|
| `SERVER_JAR_URL` | `https://your-nas/HytaleServer.jar` |
| `ASSETS_URL` | `https://your-nas/Assets.zip` |

Files can be found in: `%appdata%\Hytale\install\release\package\game\latest\`

**Option C: Manual Copy**

```bash
docker cp Server/HytaleServer.jar hytale:/opt/hytale/server/
docker cp Assets.zip hytale:/opt/hytale/server/
docker restart hytale
```

#### 3. Server Authentication

After first start, the Hytale server needs to be authenticated:

```bash
docker attach hytale
/auth login device
```

Open link in browser, enter code, done.

### KyuubiSoft Panel

The admin panel is available at `http://SERVER-IP:18080`.

**Default login:**
| Field | Value |
|-------|-------|
| User | `admin` |
| Password | `admin` |

> **Important:** Please change password after first login!

**Panel Features:**
- Dashboard with server status and resources
- Live console with log filtering and command history
- Performance monitoring with real-time graphs
- **Player Statistics** with top players and activity charts
- Player management with extended actions
- Whitelist & ban system
- Permissions management (users & groups)
- Mods & plugins with upload and config editor
- Backup system with restore function
- **Scheduled Backups** with automatic rotation
- **Server Broadcasts** and scheduled announcements
- **Quick Commands** for common actions
- **Quick Settings** for server name, MOTD, password, max players
- Server config editor
- Activity log for all actions
- Multi-user with role system (Admin, Moderator, Operator, Viewer)

### User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full access to all features |
| **Moderator** | Server management, but no user management |
| **Operator** | Dashboard, console, performance, server restart |
| **Viewer** | Read-only access |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JAVA_MIN_RAM` | 3G | Minimum RAM |
| `JAVA_MAX_RAM` | 4G | Maximum RAM |
| `SERVER_PORT` | 5520 | UDP Port |
| `ENABLE_BACKUP` | true | Enable auto-backups |
| `BACKUP_FREQUENCY` | 30 | Backup interval in minutes |
| `AUTH_MODE` | - | `offline` for LAN-only |
| `USE_HYTALE_DOWNLOADER` | false | Use official downloader |
| `HYTALE_PATCHLINE` | release | `release` or `pre-release` |
| `SERVER_JAR_URL` | - | URL to HytaleServer.jar |
| `ASSETS_URL` | - | URL to Assets.zip |
| `MANAGER_USER` | admin | Admin panel username |
| `MANAGER_PASSWORD` | admin | Admin panel password |

### Network

Hytale uses **UDP port 5520** (QUIC), not TCP.

Router port forwarding:
- Protocol: **UDP**
- Port: **5520**

### Volumes

| Volume | Content |
|--------|---------|
| `hytale-server` | Server JAR + Assets |
| `hytale-data` | Worlds, Configs |
| `hytale-backups` | Automatic backups |
| `hytale-plugins` | Server plugins |
| `hytale-mods` | Server mods |
| `hytale-downloader` | Downloader + Credentials |

### Commands

```bash
# View logs
docker logs -f hytale

# Open console (exit: Ctrl+P, Ctrl+Q)
docker attach hytale

# Manual backup
docker exec hytale /opt/hytale/backup.sh

# Restart
docker restart hytale
```

### Updates

With Hytale Downloader:
```bash
docker stop hytale
docker volume rm hytale-server
docker start hytale
```

---

## Documentation

- **[Server Commands](docs/COMMANDS.md)** - Complete list of all Hytale server commands
- [Hytale Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)
- [Hytale Downloader](https://downloader.hytale.com/hytale-downloader.zip)

---

<div align="center">

## Support

If you find this project helpful, consider supporting me!

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)

**Discord:** KyuubiDDragon

---

KyuubiSoft Panel - Made with :heart: by [KyuubiSoft](https://github.com/KyuubiDDragon)

</div>
