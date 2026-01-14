# Hytale Dedicated Server - Docker

[Deutsch](#deutsch) | [English](#english)

---

## Deutsch

Vollautomatisches Docker-Setup für Hytale Server mit Web-basiertem Admin Panel.

### Features

- Automatischer Server-Download via offiziellem Hytale Downloader
- Web-basiertes Admin Panel für Server-Verwaltung
- Automatische Backups
- Performance Monitoring
- Whitelist/Ban Verwaltung
- Permissions System

### Quick Start mit Portainer

#### 1. Stack hinzufügen
- Portainer → Stacks → Add Stack
- Name: `hytale`
- Build method: Repository
- Repository URL: `https://github.com/DEIN-USER/hytale-docker`

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
docker cp Server/HytaleServer.jar hytale-beta:/opt/hytale/server/
docker cp Assets.zip hytale-beta:/opt/hytale/server/
docker restart hytale-beta
```

#### 3. Server authentifizieren

Nach dem ersten Start muss der Hytale-Server authentifiziert werden:

```bash
docker attach hytale-beta
/auth login device
```

Link im Browser öffnen, Code eingeben, fertig.

### Admin Panel

Das Admin Panel ist unter `http://SERVER-IP:3000` erreichbar.

Standard-Login:
- User: `admin`
- Password: `admin` (bitte ändern!)

Features:
- Dashboard mit Server-Status und Ressourcen
- Live Console mit Log-Filterung
- Performance Monitoring mit Graphen
- Spieler Verwaltung
- Whitelist & Ban System
- Permissions Verwaltung
- Backup System
- Config Editor

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

Hytale nutzt UDP Port 5520 (QUIC), nicht TCP.

Router Port-Forwarding:
- Protokoll: UDP
- Port: 5520

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
docker logs -f hytale-beta

# Console öffnen (verlassen: Ctrl+P, Ctrl+Q)
docker attach hytale-beta

# Manuelles Backup
docker exec hytale-beta /opt/hytale/backup.sh

# Neustart
docker restart hytale-beta
```

### Updates

Mit Hytale Downloader:
```bash
docker stop hytale-beta
docker volume rm hytale-server
docker start hytale-beta
```

---

## English

Fully automated Docker setup for Hytale Server with web-based admin panel.

### Features

- Automatic server download via official Hytale Downloader
- Web-based admin panel for server management
- Automatic backups
- Performance monitoring
- Whitelist/ban management
- Permissions system

### Quick Start with Portainer

#### 1. Add Stack
- Portainer → Stacks → Add Stack
- Name: `hytale`
- Build method: Repository
- Repository URL: `https://github.com/YOUR-USER/hytale-docker`

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
docker cp Server/HytaleServer.jar hytale-beta:/opt/hytale/server/
docker cp Assets.zip hytale-beta:/opt/hytale/server/
docker restart hytale-beta
```

#### 3. Server Authentication

After first start, the Hytale server needs to be authenticated:

```bash
docker attach hytale-beta
/auth login device
```

Open link in browser, enter code, done.

### Admin Panel

The admin panel is available at `http://SERVER-IP:3000`.

Default login:
- User: `admin`
- Password: `admin` (please change!)

Features:
- Dashboard with server status and resources
- Live console with log filtering
- Performance monitoring with graphs
- Player management
- Whitelist & ban system
- Permissions management
- Backup system
- Config editor

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

Hytale uses UDP port 5520 (QUIC), not TCP.

Router port forwarding:
- Protocol: UDP
- Port: 5520

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
docker logs -f hytale-beta

# Open console (exit: Ctrl+P, Ctrl+Q)
docker attach hytale-beta

# Manual backup
docker exec hytale-beta /opt/hytale/backup.sh

# Restart
docker restart hytale-beta
```

### Updates

With Hytale Downloader:
```bash
docker stop hytale-beta
docker volume rm hytale-server
docker start hytale-beta
```

---

## Links

- [Hytale Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)
- [Hytale Downloader](https://downloader.hytale.com/hytale-downloader.zip)
