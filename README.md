<div align="center">

# KyuubiSoft Panel - Hytale Server Management

### Vollautomatisches Docker-Setup mit Web Admin Panel by KyuubiSoft

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)
[![Discord](https://img.shields.io/badge/Discord-Support%20Server-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://dsc.gg/kyuubisoft)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue?style=for-the-badge)](LICENSE)

<img src="https://img.shields.io/badge/KyuubiSoft_Panel-v2.1.1-orange?style=for-the-badge" alt="KyuubiSoft Panel v2.1.1"/>
<img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"/>
<img src="https://img.shields.io/badge/Node.js-Backend-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"/>
<img src="https://img.shields.io/badge/Vue.js-Frontend-4FC08D?style=for-the-badge&logo=vue.js&logoColor=white" alt="Vue.js"/>

---

**[Deutsch](#deutsch)** | **[English](#english)** | **[Upgrade v2.0](#upgrade-auf-v20)** | **[Commands](docs/COMMANDS.md)** | **[Changelog](CHANGELOG.md)**

</div>

---

## Demo Video

<div align="center">

[![KyuubiSoft Panel Demo](https://img.youtube.com/vi/9DudIP-Os_0/maxresdefault.jpg)](https://youtu.be/9DudIP-Os_0)

**[Watch Demo Video on YouTube](https://youtu.be/9DudIP-Os_0)**

</div>

---

## Deutsch

KyuubiSoft Panel - Vollautomatisches Docker-Setup für Hytale Server mit modernem Web-basiertem Admin Panel.

### Features

| Feature | Beschreibung |
|---------|--------------|
| **Auto-Download** | Automatischer Server-Download via offiziellem Hytale Downloader |
| **Web Admin Panel** | Modernes UI mit Dark Theme und Echtzeit-Updates |
| **Multi-User** | Mehrere Benutzer mit anpassbaren Rollen und Berechtigungen |
| **Live Console** | Echtzeit-Logs mit Filterung und Auto-Scroll |
| **Performance Monitor** | CPU, RAM, JVM Heap und Spieler-Statistiken mit Graphen |
| **Spieler Verwaltung** | Kick, Ban, Teleport, Gamemode, Items geben, Heal und mehr |
| **Spieler Statistiken** | Top-Spieler, Spielzeit-Tracking, Aktivitäts-Trends |
| **Mods & Plugins** | Upload, Aktivieren/Deaktivieren, Config Editor, Modtale & StackMart Integration |
| **Backups** | Automatische und manuelle Backups mit Restore |
| **Scheduler** | Geplante Backups, automatische Neustarts mit Warnungen |
| **Server Broadcasts** | Nachrichten an alle Spieler, geplante Ankündigungen |
| **Quick Commands** | Ein-Klick Befehle für häufige Server-Aktionen |
| **Quick Settings** | Schnelleinstellungen für ServerName, MOTD, MaxPlayers |
| **Whitelist & Bans** | Komplette Zugriffskontrolle |
| **Rollen & Berechtigungen** | Flexibles Berechtigungssystem mit Custom Roles |
| **Activity Log** | Alle Admin-Aktionen werden protokolliert |
| **Asset Explorer** | Durchsuche und analysiere Hytale Assets |
| **Mehrsprachig** | Deutsch, Englisch und Portugiesisch |

---

## Upgrade auf v2.0

### Wichtige Änderungen in v2.0

Version 2.0 bringt **erhöhte Sicherheit** und erfordert zusätzliche Konfiguration.

#### Neue Pflicht-Variablen

| Variable | Beschreibung | Beispiel |
|----------|--------------|----------|
| `JWT_SECRET` | Geheimer Schlüssel für Token-Signierung (min. 32 Zeichen) | `openssl rand -base64 48` |
| `CORS_ORIGINS` | Erlaubte Origins für API-Zugriffe | `http://localhost:18080` |
| `MANAGER_USERNAME` | Admin-Benutzername | `admin` |
| `MANAGER_PASSWORD` | Admin-Passwort (min. 12 Zeichen empfohlen) | `MeinSicheresPasswort123` |

#### Sicherheitsmodus

```env
# strict (Standard): Server startet nicht ohne sichere Konfiguration
# warn: Server startet mit Warnungen (NUR für geschlossene Netzwerke!)
SECURITY_MODE=strict
```

Im `strict` Modus prüft der Server:
- JWT_SECRET ist gesetzt und min. 32 Zeichen
- MANAGER_PASSWORD ist nicht "admin" oder zu kurz
- CORS_ORIGINS ist konfiguriert

#### Container läuft als Non-Root User

Der Manager-Container läuft jetzt als User `manager` (UID 9999) statt als root. Dies kann zu **Berechtigungsproblemen** führen, wenn du von v1.x upgradest.

**Fix für bestehende Installationen:**
```bash
# Auf dem Host ausführen (HOST_DATA_PATH anpassen!)
sudo chown -R 9999:9999 /opt/hytale
sudo chmod -R g+rw /opt/hytale
```

#### Hytale Built-in Backup deaktiviert

Die eingebaute Backup-Funktion des Hytale Servers (`ENABLE_BACKUP`) erstellt leere 0KB .zip Dateien und ist daher standardmäßig deaktiviert.

**Empfehlung:** Nutze stattdessen die **Scheduler-Backups** im Web Panel:
1. Panel öffnen → Scheduler
2. "Auto Backups" aktivieren
3. Uhrzeit und Aufbewahrung einstellen

Diese erstellen funktionierende `.tar.gz` Backups.

#### Migration Checkliste

- [ ] `.env` Datei mit neuen Variablen aktualisieren (siehe `.env.example`)
- [ ] `JWT_SECRET` generieren: `openssl rand -base64 48`
- [ ] `CORS_ORIGINS` setzen (z.B. `http://localhost:18080` oder deine Domain)
- [ ] Sicheres `MANAGER_PASSWORD` setzen (nicht "admin"!)
- [ ] Berechtigungen auf Host-Volumes korrigieren (siehe oben)
- [ ] Container neu bauen: `docker-compose build`
- [ ] Container starten: `docker-compose up -d`

---

### Quick Start mit Portainer

#### 1. Stack hinzufügen
- Portainer → Stacks → Add Stack
- Name: `hytale`
- Build method: Repository
- Repository URL: `https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel`

#### 2. Environment Variables (WICHTIG!)

**Pflicht-Variablen für v2.0:**

| Variable | Wert |
|----------|------|
| `JWT_SECRET` | (generieren mit `openssl rand -base64 48`) |
| `CORS_ORIGINS` | `http://DEINE-SERVER-IP:18080` |
| `MANAGER_USERNAME` | `admin` |
| `MANAGER_PASSWORD` | `DeinSicheresPasswort` |

#### 3. Server-Dateien

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

#### 4. Server authentifizieren

Nach dem ersten Start muss der Hytale-Server authentifiziert werden:

```bash
docker attach hytale
/auth login device
```

Link im Browser öffnen, Code eingeben, fertig.

### KyuubiSoft Panel

Das Admin Panel ist unter `http://SERVER-IP:18080` erreichbar.

> **Wichtig:** In v2.0 gibt es keinen Standard-Login mehr! Du musst `MANAGER_USERNAME` und `MANAGER_PASSWORD` in den Environment Variables setzen.

**Panel Features:**
- Dashboard mit Server-Status und Ressourcen
- Live Console mit Log-Filterung und Command-Historie
- Performance Monitoring mit Echtzeit-Graphen (CPU, RAM, JVM Heap)
- **Spieler Statistiken** mit Top-Spielern und Aktivitäts-Charts
- Spieler Verwaltung mit erweiterten Aktionen
- Whitelist & Ban System
- **Rollen-Management** mit anpassbaren Berechtigungen
- Mods & Plugins mit Upload, Config Editor und **Modtale/StackMart Integration**
- Backup System mit Restore-Funktion
- **Scheduler** für automatische Backups und Neustarts
- **Server Broadcasts** und geplante Ankündigungen
- **Quick Commands** für häufige Aktionen
- **Quick Settings** für Servername, MOTD, Passwort, MaxPlayers
- **Asset Explorer** zum Durchsuchen der Hytale Assets
- Server Config Editor
- Activity Log für alle Aktionen
- Multi-User mit flexiblem Rollen-System

### Benutzerrollen

| Rolle | Rechte |
|-------|--------|
| **Administrator** | Vollzugriff auf alle Funktionen |
| **Moderator** | Spielerverwaltung und Chat-Moderation |
| **Operator** | Server-Verwaltung und technische Aufgaben |
| **Viewer** | Nur Lesezugriff |

Rollen können im Panel unter "Roles" angepasst werden. Du kannst auch eigene Rollen erstellen.

### Umgebungsvariablen

#### Pflicht (v2.0)

| Variable | Beschreibung |
|----------|--------------|
| `JWT_SECRET` | Geheimer Schlüssel (min. 32 Zeichen) - `openssl rand -base64 48` |
| `CORS_ORIGINS` | Erlaubte Origins (z.B. `http://localhost:18080`) |
| `MANAGER_USERNAME` | Admin-Benutzername |
| `MANAGER_PASSWORD` | Admin-Passwort (min. 12 Zeichen empfohlen) |

#### Server

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `JAVA_MIN_RAM` | 3G | Minimaler RAM |
| `JAVA_MAX_RAM` | 4G | Maximaler RAM |
| `SERVER_PORT` | 5520 | UDP Port |
| `AUTH_MODE` | authenticated | `offline` für LAN-only |
| `TZ` | Europe/Berlin | Zeitzone |

#### Download

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `USE_HYTALE_DOWNLOADER` | false | Offiziellen Downloader nutzen |
| `HYTALE_PATCHLINE` | release | `release` oder `pre-release` |
| `AUTO_UPDATE` | false | Bei Neustart nach Updates suchen |
| `SERVER_JAR_URL` | - | URL zu HytaleServer.jar |
| `ASSETS_URL` | - | URL zu Assets.zip |

#### Manager Panel

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `MANAGER_PORT` | 18080 | Web Panel Port |
| `SECURITY_MODE` | strict | `strict` oder `warn` |
| `TRUST_PROXY` | false | Für Reverse Proxy (nginx, traefik) |

#### Backups (Hytale Built-in - nicht empfohlen)

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `ENABLE_BACKUP` | false | Hytale Built-in Backup (erstellt leere Dateien!) |
| `BACKUP_FREQUENCY` | 30 | Backup-Intervall in Minuten |

> **Hinweis:** Nutze stattdessen die Scheduler-Backups im Web Panel!

### Netzwerk

Hytale nutzt **UDP Port 5520** (QUIC), nicht TCP.

Router Port-Forwarding:
- Protokoll: **UDP**
- Port: **5520**

### Volumes

| Volume | Inhalt |
|--------|--------|
| `hytale-server` | Server JAR + Assets |
| `hytale-data` | Welten, Configs, Panel-Daten |
| `hytale-backups` | Backups |
| `hytale-plugins` | Server Plugins |
| `hytale-mods` | Server Mods |
| `hytale-downloader` | Downloader + Credentials |
| `hytale-auth` | Server Auth Credentials |

### Befehle

```bash
# Logs anzeigen
docker logs -f hytale

# Console öffnen (verlassen: Ctrl+P, Ctrl+Q)
docker attach hytale

# Neustart
docker restart hytale

# Container neu bauen nach Update
docker-compose build && docker-compose up -d
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
| **Multi-User** | Multiple users with customizable roles and permissions |
| **Live Console** | Real-time logs with filtering and auto-scroll |
| **Performance Monitor** | CPU, RAM, JVM Heap and player statistics with graphs |
| **Player Management** | Kick, ban, teleport, gamemode, give items, heal and more |
| **Player Statistics** | Top players, playtime tracking, activity trends |
| **Mods & Plugins** | Upload, enable/disable, config editor, Modtale & StackMart integration |
| **Backups** | Automatic and manual backups with restore |
| **Scheduler** | Scheduled backups, automatic restarts with warnings |
| **Server Broadcasts** | Messages to all players, scheduled announcements |
| **Quick Commands** | One-click commands for common server actions |
| **Quick Settings** | Fast config for ServerName, MOTD, MaxPlayers |
| **Whitelist & Bans** | Complete access control |
| **Roles & Permissions** | Flexible permission system with custom roles |
| **Activity Log** | All admin actions are logged |
| **Asset Explorer** | Browse and analyze Hytale assets |
| **Multilingual** | German, English and Portuguese |

---

## Upgrade to v2.0

### Important Changes in v2.0

Version 2.0 brings **enhanced security** and requires additional configuration.

#### New Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | Secret key for token signing (min. 32 characters) | `openssl rand -base64 48` |
| `CORS_ORIGINS` | Allowed origins for API access | `http://localhost:18080` |
| `MANAGER_USERNAME` | Admin username | `admin` |
| `MANAGER_PASSWORD` | Admin password (min. 12 characters recommended) | `MySecurePassword123` |

#### Security Mode

```env
# strict (default): Server won't start without secure configuration
# warn: Server starts with warnings (ONLY for closed networks!)
SECURITY_MODE=strict
```

In `strict` mode, the server checks:
- JWT_SECRET is set and at least 32 characters
- MANAGER_PASSWORD is not "admin" or too short
- CORS_ORIGINS is configured

#### Container Runs as Non-Root User

The manager container now runs as user `manager` (UID 9999) instead of root. This may cause **permission issues** when upgrading from v1.x.

**Fix for existing installations:**
```bash
# Run on host (adjust HOST_DATA_PATH!)
sudo chown -R 9999:9999 /opt/hytale
sudo chmod -R g+rw /opt/hytale
```

#### Hytale Built-in Backup Disabled

The built-in backup function of the Hytale server (`ENABLE_BACKUP`) creates empty 0KB .zip files and is therefore disabled by default.

**Recommendation:** Use **Scheduler Backups** in the web panel instead:
1. Open panel → Scheduler
2. Enable "Auto Backups"
3. Set time and retention

These create working `.tar.gz` backups.

#### Migration Checklist

- [ ] Update `.env` file with new variables (see `.env.example`)
- [ ] Generate `JWT_SECRET`: `openssl rand -base64 48`
- [ ] Set `CORS_ORIGINS` (e.g., `http://localhost:18080` or your domain)
- [ ] Set secure `MANAGER_PASSWORD` (not "admin"!)
- [ ] Fix permissions on host volumes (see above)
- [ ] Rebuild containers: `docker-compose build`
- [ ] Start containers: `docker-compose up -d`

---

### Quick Start with Portainer

#### 1. Add Stack
- Portainer → Stacks → Add Stack
- Name: `hytale`
- Build method: Repository
- Repository URL: `https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel`

#### 2. Environment Variables (IMPORTANT!)

**Required variables for v2.0:**

| Variable | Value |
|----------|-------|
| `JWT_SECRET` | (generate with `openssl rand -base64 48`) |
| `CORS_ORIGINS` | `http://YOUR-SERVER-IP:18080` |
| `MANAGER_USERNAME` | `admin` |
| `MANAGER_PASSWORD` | `YourSecurePassword` |

#### 3. Server Files

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

#### 4. Server Authentication

After first start, the Hytale server needs to be authenticated:

```bash
docker attach hytale
/auth login device
```

Open link in browser, enter code, done.

### KyuubiSoft Panel

The admin panel is available at `http://SERVER-IP:18080`.

> **Important:** In v2.0 there is no default login! You must set `MANAGER_USERNAME` and `MANAGER_PASSWORD` in the environment variables.

**Panel Features:**
- Dashboard with server status and resources
- Live console with log filtering and command history
- Performance monitoring with real-time graphs (CPU, RAM, JVM Heap)
- **Player Statistics** with top players and activity charts
- Player management with extended actions
- Whitelist & ban system
- **Role Management** with customizable permissions
- Mods & plugins with upload, config editor and **Modtale/StackMart integration**
- Backup system with restore function
- **Scheduler** for automatic backups and restarts
- **Server Broadcasts** and scheduled announcements
- **Quick Commands** for common actions
- **Quick Settings** for server name, MOTD, password, max players
- **Asset Explorer** for browsing Hytale assets
- Server config editor
- Activity log for all actions
- Multi-user with flexible role system

### User Roles

| Role | Permissions |
|------|-------------|
| **Administrator** | Full access to all features |
| **Moderator** | Player management and chat moderation |
| **Operator** | Server management and technical tasks |
| **Viewer** | Read-only access |

Roles can be customized in the panel under "Roles". You can also create custom roles.

### Environment Variables

#### Required (v2.0)

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret key (min. 32 characters) - `openssl rand -base64 48` |
| `CORS_ORIGINS` | Allowed origins (e.g., `http://localhost:18080`) |
| `MANAGER_USERNAME` | Admin username |
| `MANAGER_PASSWORD` | Admin password (min. 12 characters recommended) |

#### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `JAVA_MIN_RAM` | 3G | Minimum RAM |
| `JAVA_MAX_RAM` | 4G | Maximum RAM |
| `SERVER_PORT` | 5520 | UDP Port |
| `AUTH_MODE` | authenticated | `offline` for LAN-only |
| `TZ` | Europe/Berlin | Timezone |

#### Download

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_HYTALE_DOWNLOADER` | false | Use official downloader |
| `HYTALE_PATCHLINE` | release | `release` or `pre-release` |
| `AUTO_UPDATE` | false | Check for updates on restart |
| `SERVER_JAR_URL` | - | URL to HytaleServer.jar |
| `ASSETS_URL` | - | URL to Assets.zip |

#### Manager Panel

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_PORT` | 18080 | Web panel port |
| `SECURITY_MODE` | strict | `strict` or `warn` |
| `TRUST_PROXY` | false | For reverse proxy (nginx, traefik) |

#### Backups (Hytale Built-in - not recommended)

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_BACKUP` | false | Hytale built-in backup (creates empty files!) |
| `BACKUP_FREQUENCY` | 30 | Backup interval in minutes |

> **Note:** Use scheduler backups in the web panel instead!

### Network

Hytale uses **UDP port 5520** (QUIC), not TCP.

Router port forwarding:
- Protocol: **UDP**
- Port: **5520**

### Volumes

| Volume | Content |
|--------|---------|
| `hytale-server` | Server JAR + Assets |
| `hytale-data` | Worlds, configs, panel data |
| `hytale-backups` | Backups |
| `hytale-plugins` | Server plugins |
| `hytale-mods` | Server mods |
| `hytale-downloader` | Downloader + Credentials |
| `hytale-auth` | Server auth credentials |

### Commands

```bash
# View logs
docker logs -f hytale

# Open console (exit: Ctrl+P, Ctrl+Q)
docker attach hytale

# Restart
docker restart hytale

# Rebuild containers after update
docker-compose build && docker-compose up -d
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

- **[Changelog](CHANGELOG.md)** - Recent changes and updates
- **[Server Commands](docs/COMMANDS.md)** - Complete list of all Hytale server commands
- [Hytale Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)
- [Hytale Downloader](https://downloader.hytale.com/hytale-downloader.zip)

---

<div align="center">

## Support

If you find this project helpful, consider supporting me!

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://dsc.gg/kyuubisoft)

**Discord Support Server:** [dsc.gg/kyuubisoft](https://dsc.gg/kyuubisoft)

---

KyuubiSoft Panel - Made with :heart: by [KyuubiSoft](https://github.com/KyuubiDDragon)

</div>
