<div align="center">

# KyuubiSoft Panel - Hytale Server Management

### Vollautomatisches Docker-Setup mit Web Admin Panel by KyuubiSoft

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)
[![Discord](https://img.shields.io/badge/Discord-Support%20Server-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://dsc.gg/kyuubisoft)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue?style=for-the-badge)](LICENSE)

<img src="https://img.shields.io/badge/KyuubiSoft_Panel-v3.0.0-orange?style=for-the-badge" alt="KyuubiSoft Panel v3.0.0"/>
<img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"/>
<img src="https://img.shields.io/badge/Node.js-Backend-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"/>
<img src="https://img.shields.io/badge/Vue.js-Frontend-4FC08D?style=for-the-badge&logo=vue.js&logoColor=white" alt="Vue.js"/>

---

**[Deutsch](#deutsch)** | **[English](#english)** | **[Erweiterte Funktionen](#erweiterte-funktionen)** | **[Advanced features](#advanced-features)** | **[Anhang: Upgrade v2.0](#anhang-upgrade-auf-v20)** | **[V3 Roadmap](docs/V3_ROADMAP.md)** | **[API Cheatsheet](docs/V3_API_CHEATSHEET.md)** | **[Commands](docs/COMMANDS.md)** | **[Changelog](CHANGELOG.md)**

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
| **Setup-Wizard** | Geführte Ersteinrichtung im Browser: Admin-Konto, Server-Download, Hytale-Login, Konfiguration |
| **Auto-Download** | Automatischer Server-Download via offiziellem Hytale Downloader |
| **Web Admin Panel** | Modernes UI mit Dark Theme und Echtzeit-Updates |
| **Multi-User** | Mehrere Benutzer mit anpassbaren Rollen und Berechtigungen, 2FA, API-Keys |
| **Live Console** | Echtzeit-Logs mit Filterung, Auto-Scroll und Befehlsverlauf (↑/↓) |
| **Performance Monitor** | CPU, RAM, JVM Heap und Spieler-Statistiken mit Graphen |
| **Spieler Verwaltung** | Kick, Ban, Teleport, Gamemode, Items geben, Heal und mehr |
| **Spieler Statistiken** | Top-Spieler, Spielzeit-Tracking, Aktivitäts-Trends |
| **Mods & Plugins** | Upload, Aktivieren/Deaktivieren, Config Editor, Modtale, StackMart & CurseForge |
| **Backups** | Automatische und manuelle Backups mit Restore |
| **Scheduler** | Geplante Backups, automatische Neustarts mit Warnungen |
| **Watchdog** | Absturzerkennung mit Ursache, Warnungen und optionalem Auto-Neustart |
| **Event-Aktionen** | Befehle, Ankündigungen oder Backups automatisch bei Server-Ereignissen auslösen |
| **Webhooks & Benachrichtigungen** | Discord, Slack oder eigene HTTP-Ziele; Web-Push aufs Handy |
| **Server Broadcasts** | Nachrichten an alle Spieler, geplante Ankündigungen |
| **Quick Commands** | Ein-Klick Befehle für häufige Server-Aktionen |
| **Quick Settings** | Schnelleinstellungen für ServerName, MOTD, MaxPlayers |
| **Whitelist & Bans** | Komplette Zugriffskontrolle |
| **Rollen & Berechtigungen** | Flexibles Berechtigungssystem mit Custom Roles |
| **Activity Log** | Alle Admin-Aktionen werden protokolliert |
| **Asset Explorer** | Durchsuche und analysiere Hytale Assets |
| **Multiserver** *(experimentell)* | Weitere Hytale-Server aus demselben Panel anlegen und verwalten |
| **Mehrsprachig** | Deutsch, Englisch und Portugiesisch |

---

### Quick Start

Voraussetzungen: ein Linux-Host (oder Docker Desktop) mit Docker und Docker Compose, ein offener **UDP-Port 5520** für Spieler und **TCP-Port 18080** für das Panel. Die Zugangsdaten legst du später im Setup-Wizard fest, du brauchst vorher kein Passwort und keinen JWT-Schlüssel zu erzeugen.

#### 1. Stack starten

**Mit Docker Compose:**

```bash
git clone https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel.git
cd KyuubiSoft-Hytale-Panel
cp .env.example .env
# .env bei Bedarf anpassen (HOST_DATA_PATH, JAVA_MAX_RAM, Ports) - siehe unten
docker compose up -d --build
```

> **Wichtig:** Lass `MANAGER_USERNAME`, `MANAGER_PASSWORD`, `JWT_SECRET` und `CORS_ORIGINS` in der `.env` leer (oder lösche die Zeilen), wenn du den Wizard nutzt. Ein gesetztes Passwort würde sonst beim ersten Start als Admin-Konto angelegt, und `.env.example` enthält dafür nur einen Platzhalter.

**Mit Portainer:**

1. Stacks → Add Stack, Name `hytale`, Build method **Repository**
2. Repository URL: `https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel`
3. Unter *Environment variables* nur setzen, was du abweichend brauchst (z. B. `HOST_DATA_PATH`, `JAVA_MAX_RAM`). Keine `.env`-Datei hochladen.
4. Deploy

#### 2. Setup-Wizard

Öffne `http://SERVER-IP:18080`. Solange die Einrichtung nicht abgeschlossen ist, startet das Panel im Setup-Modus und zeigt den Wizard:

1. **Systemprüfung**: Docker-Zugriff, Ports, Speicher und RAM, Schreibrechte
2. **Sprache** und **Admin-Konto**
3. **Download-Methode**: offizieller Hytale Downloader (empfohlen, einmaliger Browser-Login), eigene Download-URLs, manuell kopierte Dateien oder eine bereits vorhandene Installation
4. **Server-Download** und **Assets entpacken**
5. **Server-Anmeldung**: Hytale-Login per Geräte-Code im Browser. Das ersetzt `docker attach` und `/auth login device`.
6. **Server-Konfiguration**, **Sicherheit**, **Automatisierung** (Backups, Neustarts), **Performance**
7. **Plugin** (KyuubiSoft API), **Integrationen** (Modtale, StackMart, Live-Karte) und **Netzwerk** (lokal, LAN oder eigene Domain hinter einem Reverse Proxy)
8. **Zusammenfassung** und Start des Servers

Der Wizard erkennt eine bestehende Installation (vorhandene Server-Dateien, Welten, Benutzer) und übernimmt sie. Danach gilt die Konfiguration aus dem Panel, die Variablen `MANAGER_USERNAME` und `MANAGER_PASSWORD` werden nicht mehr gelesen.

#### 3. Spieler verbinden

Hytale nutzt **UDP Port 5520** (QUIC), nicht TCP. Router-Port-Forwarding: Protokoll **UDP**, Port **5520** (bzw. dein `SERVER_PORT`).

#### Alternative: Server-Dateien ohne Downloader

Statt des offiziellen Downloaders kannst du im Wizard **eigene URLs** angeben (`SERVER_JAR_URL`, `ASSETS_URL`) oder die Dateien selbst kopieren:

```bash
docker cp Server/HytaleServer.jar hytale:/opt/hytale/server/
docker cp Assets.zip hytale:/opt/hytale/server/
docker restart hytale
```

Die Dateien findest du in `%appdata%\Hytale\install\release\package\game\latest\`.

### KyuubiSoft Panel

Das Admin Panel ist unter `http://SERVER-IP:18080` erreichbar.

**Panel Features:**
- Dashboard mit Server-Status und Ressourcen
- Live Console mit Log-Filterung und Befehlsverlauf (↑/↓ blättert durch die zuletzt gesendeten Befehle, getrennt je Server, im Browser gespeichert)
- Performance Monitoring mit Echtzeit-Graphen (CPU, RAM, JVM Heap)
- **Spieler Statistiken** mit Top-Spielern und Aktivitäts-Charts
- Spieler Verwaltung mit erweiterten Aktionen
- Whitelist & Ban System
- **Rollen-Management** mit anpassbaren Berechtigungen
- Mods & Plugins mit Upload, Config Editor und **Modtale/StackMart/CurseForge-Integration**
- Backup System mit Restore-Funktion
- **Scheduler** für automatische Backups und Neustarts
- **Event-Aktionen** (Menüpunkt „Event-Aktionen“): Regeln, die bei Server-Ereignissen einen Befehl ausführen, eine Ankündigung senden oder ein Backup starten
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

### Login-Probleme & Passwort-Reset (CLI)

**Wichtig zu wissen:** Das Admin-Konto stammt aus dem Setup-Wizard. Nur wenn du ohne Wizard startest, legt das Panel beim allerersten Start ein Konto aus `MANAGER_USERNAME`/`MANAGER_PASSWORD` an (Datei `users.json` im Manager-Datenvolume). Danach gilt ausschließlich das Passwort aus dem Panel; Änderungen an `MANAGER_PASSWORD` in der `.env` haben **keine Wirkung** mehr.

Wenn du dich ausgesperrt hast (Passwort vergessen, 2FA-Gerät verloren), nutze das eingebaute Recovery-CLI im Manager-Container:

```bash
# Diagnose: Welche Credential-Quelle ist aktiv? Welche User existieren?
docker exec -it hytale-manager node dist/cli.js auth-status

# Passwort zurücksetzen (generiert ein sicheres Passwort und zeigt es an)
docker exec -it hytale-manager node dist/cli.js reset-password admin

# Passwort auf einen eigenen Wert setzen
docker exec -it hytale-manager node dist/cli.js reset-password admin 'MeinNeues-Passwort123'

# Neuen Admin-Account anlegen (falls users.json leer/beschädigt ist)
docker exec -it hytale-manager node dist/cli.js create-admin admin

# 2FA entfernen (Authenticator verloren)
docker exec -it hytale-manager node dist/cli.js disable-2fa admin

# Alle User auflisten
docker exec -it hytale-manager node dist/cli.js list-users
```

> Bei eigenem `STACK_NAME` heißt der Container entsprechend, z.B. `hytale-prod-manager`. Mit Docker Compose geht auch: `docker compose exec manager node dist/cli.js auth-status`
>
> Ein Passwort-Reset macht alle aktiven Sessions des Accounts sofort ungültig. Die Änderungen wirken ohne Neustart.

### Umgebungsvariablen

Alle Variablen mit Kommentaren stehen in [`.env.example`](.env.example). Hier die wichtigsten.

#### Zugang (nur ohne Setup-Wizard)

Mit dem Wizard nicht nötig. Der Wizard erzeugt das JWT-Secret selbst und legt Admin-Konto und erlaubte Origin in der Panel-Konfiguration ab.

| Variable | Beschreibung |
|----------|--------------|
| `JWT_SECRET` | Geheimer Schlüssel (min. 32 Zeichen) - `openssl rand -base64 48` |
| `CORS_ORIGINS` | Erlaubte Origins (z.B. `http://localhost:18080`) |
| `MANAGER_USERNAME` | Admin-Benutzername (nur für die **Erstanlage**, danach gilt `users.json`) |
| `MANAGER_PASSWORD` | Admin-Passwort (min. 12 Zeichen; nur für die **Erstanlage**, spätere Änderungen per Panel oder `reset-password`-CLI, siehe oben) |

#### Allgemein

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `HOST_DATA_PATH` | /opt/hytale | Ordner auf dem Host für alle Server-Daten (siehe „Host-Pfad und Inhalt“) |
| `STACK_NAME` | hytale | Präfix für Container- und Netzwerknamen (mehrere Stacks parallel) |
| `DOCKER_MEMORY_LIMIT` | 8G | RAM-Limit des Server-Containers; muss `JAVA_MAX_RAM` plus ein Viertel (höchstens 1.5G) fassen |
| `DOCKER_CPU_LIMIT` | 4 | CPU-Limit des Server-Containers |

#### Server

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `JAVA_MIN_RAM` | 3G | Minimaler RAM |
| `JAVA_MAX_RAM` | 4G | Maximaler RAM |
| `SERVER_PORT` | 5520 | UDP Port |
| `SERVER_BIND` | 0.0.0.0 | Adresse, auf der der Server lauscht |
| `SERVER_JAR` | HytaleServer.jar | Server JAR-Datei (z.B. `Hyinit-0.1.0-pre1.jar`) |
| `EXTRA_SERVER_ARGS` | - | Zusätzliche Server-Argumente |
| `EXTRA_JAVA_ARGS` | - | Zusätzliche JVM-Argumente |
| `AUTH_MODE` | authenticated | `offline` für LAN-only |
| `TZ` | Europe/Berlin | Zeitzone |
| `LOG_RETENTION_DAYS` | 14 | Server-Logs älter als N Tage beim Start löschen (`0` = aus) |
| `LOG_MAX_FILES` | 50 | Höchstens N Server-Logs behalten (`0` = unbegrenzt) |
| `FIX_OWNERSHIP` | true | Beim Start nur abweichende Datei-Besitzer auf UID 9999 setzen (`false` z. B. bei NFS mit root_squash) |
| `HYTALE_AUTH_KEY_FILE` | `auth/auth.passphrase` | Schlüsseldatei für die gespeicherten Server-Logindaten (`auth.enc`), wird automatisch erzeugt |
| `SERVER_STOP_TIMEOUT_SECONDS` | 120 | So lange darf der Server nach `/stop` speichern, bevor das Panel `docker stop` nutzt |

#### Download

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `USE_HYTALE_DOWNLOADER` | false | Offiziellen Downloader nutzen |
| `HYTALE_PATCHLINE` | release | `release` oder `pre-release` |
| `AUTO_UPDATE` | false | Bei Neustart nach Updates suchen (der Schalter im Panel hat Vorrang) |
| `DOWNLOADER_TIMEOUT` | 3600 | Downloader-Aufrufe brechen nach so vielen Sekunden ab |
| `SERVER_JAR_URL` | - | URL zu HytaleServer.jar |
| `ASSETS_URL` | - | URL zu Assets.zip |

#### Manager Panel

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `MANAGER_PORT` | 18080 | Web Panel Port |
| `SECURITY_MODE` | strict | `strict` oder `warn` |
| `TRUST_PROXY` | false | Für Reverse Proxy (nginx, traefik) |
| `WEBMAP_PORT` / `WEBMAP_WS_PORT` | 18081 / 18082 | Ports der Live-Karte (EasyWebMap) |
| `WEBMAP_BIND` | 0.0.0.0 | Host-Adresse der Kartenports; `127.0.0.1` = Karte nur über das Panel |
| `WATCHDOG_*` | siehe `.env.example` | Absturzerkennung, Warnschwellen und Auto-Neustart |
| `ARCHIVE_EXTRACT_MAX_GB` / `ARCHIVE_MAX_ENTRIES` | 50 / 500000 | Grenzen für Backup-Restore und Welt-Import |

Weitere Variablen (Multiserver, Metriken, ausgehende Verbindungen) stehen im Kapitel [Erweiterte Funktionen](#erweiterte-funktionen).

#### Backups (Hytale Built-in)

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `ENABLE_BACKUP` | false | Zusätzlich automatische native Server-Backups alle `BACKUP_FREQUENCY` Minuten |
| `BACKUP_FREQUENCY` | 30 | Backup-Intervall in Minuten |

Der Server schreibt native Backups immer nach `${HOST_DATA_PATH}/backups/native`, damit `/backup` und das Backup vor einem Update funktionieren. Automatische Backups mit Aufbewahrung planst du im Panel unter **Scheduler**.

### Netzwerk

Hytale nutzt **UDP Port 5520** (QUIC), nicht TCP.

Router Port-Forwarding:
- Protokoll: **UDP**
- Port: **5520**

### Host-Pfad und Inhalt

Die Daten liegen als Bind-Mounts unter `HOST_DATA_PATH` (Standard `/opt/hytale`), nicht in Docker-Volumes. So kannst du sie direkt sichern oder auf ein NAS legen.

| Host-Pfad | Inhalt |
|-----------|--------|
| `<HOST_DATA_PATH>/server` | Server JAR, `Assets.zip`, Server-Konfiguration, Logs |
| `<HOST_DATA_PATH>/data` | Welten und weitere Server-Daten |
| `<HOST_DATA_PATH>/backups` | Backups (native Server-Backups unter `backups/native`) |
| `<HOST_DATA_PATH>/plugins` | Server Plugins |
| `<HOST_DATA_PATH>/mods` | Server Mods |
| `<HOST_DATA_PATH>/prefabs` | Prefabs |
| `<HOST_DATA_PATH>/downloader` | Hytale Downloader und seine Zugangsdaten |
| `<HOST_DATA_PATH>/auth` | Gespeicherte Server-Logindaten (`auth.enc`) und Schlüsseldatei |
| `<HOST_DATA_PATH>/updater` | Update-Zwischenspeicher und Sicherung der Vorversion (Update Center, Rollback) |
| `<HOST_DATA_PATH>/assets` | Cache des Asset Explorers (entpackte Spiel-Assets) |
| `<HOST_DATA_PATH>/instances` | Ordner der Zusatz-Server (Multiserver), je Server eine ID |

Das einzige benannte Docker-Volume ist `<STACK_NAME>-manager-data` (Standard `hytale-manager-data`). Es enthält die Panel-Daten: `users.json`, `roles.json`, `config.json`, `servers.json`, die Datenbank `panel.sqlite` mit Audit-Log, API-Keys und Webhooks sowie die Replay-Segmente.

Die Container laufen als UID 9999. Passen die Besitzer der Host-Ordner nicht, korrigiert der Start sie (abschaltbar mit `FIX_OWNERSHIP=false`); das Panel prüft die Ordnerrechte außerdem unter *Einstellungen*.

### Befehle

```bash
# Logs anzeigen
docker logs -f hytale

# Neustart
docker restart hytale

# Container neu bauen nach Update
docker compose build && docker compose up -d
```

Die Server-Konsole bedienst du im Panel. Den Zugriff per `docker attach` beschreibt der [Anhang](#anhang-konsole-per-docker-attach).

### Updates

Server-Updates erledigt das Panel (Seite „Updates“, auf Wunsch automatisch). Um einen frischen Server-Download zu erzwingen, stoppe den Container und leere den Server-Ordner:

```bash
docker stop hytale
rm -rf "${HOST_DATA_PATH:-/opt/hytale}/server"/*
docker start hytale
```

Danach lädt der Start den Server erneut (Downloader-Zugang vorausgesetzt).

---

## English

KyuubiSoft Panel - Fully automated Docker setup for Hytale Server with modern web-based admin panel.

### Features

| Feature | Description |
|---------|-------------|
| **Setup Wizard** | Guided first-time setup in the browser: admin account, server download, Hytale login, configuration |
| **Auto-Download** | Automatic server download via official Hytale Downloader |
| **Web Admin Panel** | Modern UI with dark theme and real-time updates |
| **Multi-User** | Multiple users with customizable roles and permissions, 2FA, API keys |
| **Live Console** | Real-time logs with filtering, auto-scroll and command history (↑/↓) |
| **Performance Monitor** | CPU, RAM, JVM Heap and player statistics with graphs |
| **Player Management** | Kick, ban, teleport, gamemode, give items, heal and more |
| **Player Statistics** | Top players, playtime tracking, activity trends |
| **Mods & Plugins** | Upload, enable/disable, config editor, Modtale, StackMart & CurseForge |
| **Backups** | Automatic and manual backups with restore |
| **Scheduler** | Scheduled backups, automatic restarts with warnings |
| **Watchdog** | Crash detection with cause, alerts and optional auto-restart |
| **Event Actions** | Run commands, announcements or backups automatically on server events |
| **Webhooks & Notifications** | Discord, Slack or generic HTTP targets; Web Push to your phone |
| **Server Broadcasts** | Messages to all players, scheduled announcements |
| **Quick Commands** | One-click commands for common server actions |
| **Quick Settings** | Fast config for ServerName, MOTD, MaxPlayers |
| **Whitelist & Bans** | Complete access control |
| **Roles & Permissions** | Flexible permission system with custom roles |
| **Activity Log** | All admin actions are logged |
| **Asset Explorer** | Browse and analyze Hytale assets |
| **Multiserver** *(experimental)* | Create and manage more Hytale servers from the same panel |
| **Multilingual** | German, English and Portuguese |

---

### Quick Start (English)

Requirements: a Linux host (or Docker Desktop) with Docker and Docker Compose, an open **UDP port 5520** for players and **TCP port 18080** for the panel. You set the credentials later in the setup wizard; there is no need to generate a password or JWT secret beforehand.

#### 1. Start the stack

**With Docker Compose:**

```bash
git clone https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel.git
cd KyuubiSoft-Hytale-Panel
cp .env.example .env
# adjust .env if needed (HOST_DATA_PATH, JAVA_MAX_RAM, ports) - see below
docker compose up -d --build
```

> **Important:** When you use the wizard, leave `MANAGER_USERNAME`, `MANAGER_PASSWORD`, `JWT_SECRET` and `CORS_ORIGINS` empty in `.env` (or delete the lines). A password that is set would be created as the admin account on first start, and `.env.example` only contains a placeholder for it.

**With Portainer:**

1. Stacks → Add Stack, name `hytale`, build method **Repository**
2. Repository URL: `https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel`
3. Under *Environment variables* set only what you need to change (e.g. `HOST_DATA_PATH`, `JAVA_MAX_RAM`). Do not upload a `.env` file.
4. Deploy

#### 2. Setup wizard

Open `http://SERVER-IP:18080`. Until setup is finished, the panel runs in setup mode and shows the wizard:

1. **System check**: Docker access, ports, disk and RAM, write permissions
2. **Language** and **admin account**
3. **Download method**: official Hytale Downloader (recommended, one-time browser login), custom download URLs, manually copied files or an existing installation
4. **Server download** and **extract assets**
5. **Server login**: Hytale login with a device code in the browser. This replaces `docker attach` and `/auth login device`.
6. **Server configuration**, **security**, **automation** (backups, restarts), **performance**
7. **Plugin** (KyuubiSoft API), **integrations** (Modtale, StackMart, live map) and **network** (local, LAN or your own domain behind a reverse proxy)
8. **Summary** and server start

The wizard detects an existing installation (server files, worlds, users) and adopts it. Afterwards the configuration from the panel applies; `MANAGER_USERNAME` and `MANAGER_PASSWORD` are no longer read.

#### 3. Let players connect

Hytale uses **UDP port 5520** (QUIC), not TCP. Router port forwarding: protocol **UDP**, port **5520** (or your `SERVER_PORT`).

#### Alternative: server files without the downloader

Instead of the official downloader you can enter **custom URLs** in the wizard (`SERVER_JAR_URL`, `ASSETS_URL`) or copy the files yourself:

```bash
docker cp Server/HytaleServer.jar hytale:/opt/hytale/server/
docker cp Assets.zip hytale:/opt/hytale/server/
docker restart hytale
```

The files can be found in `%appdata%\Hytale\install\release\package\game\latest\`.

### KyuubiSoft Panel (English)

The admin panel is available at `http://SERVER-IP:18080`.

**Panel Features:**
- Dashboard with server status and resources
- Live console with log filtering and command history (↑/↓ steps through the commands you sent last, kept per server in the browser)
- Performance monitoring with real-time graphs (CPU, RAM, JVM Heap)
- **Player Statistics** with top players and activity charts
- Player management with extended actions
- Whitelist & ban system
- **Role Management** with customizable permissions
- Mods & plugins with upload, config editor and **Modtale/StackMart/CurseForge integration**
- Backup system with restore function
- **Scheduler** for automatic backups and restarts
- **Event actions** (menu item "Event actions"): rules that run a command, send an announcement or start a backup when a server event happens
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

### Login problems & password reset (CLI)

**Good to know:** The admin account comes from the setup wizard. Only if you start without the wizard does the panel create an account from `MANAGER_USERNAME`/`MANAGER_PASSWORD` on the very first start (file `users.json` in the manager data volume). After that only the password from the panel applies; changing `MANAGER_PASSWORD` in `.env` has **no effect** anymore.

If you are locked out (forgotten password, lost 2FA device), use the built-in recovery CLI inside the manager container:

```bash
# Diagnosis: which credential source is active? Which users exist?
docker exec -it hytale-manager node dist/cli.js auth-status

# Reset a password (generates a secure password and prints it)
docker exec -it hytale-manager node dist/cli.js reset-password admin

# Set a password of your choice
docker exec -it hytale-manager node dist/cli.js reset-password admin 'MyNew-Password123'

# Create a new admin account (if users.json is empty or damaged)
docker exec -it hytale-manager node dist/cli.js create-admin admin

# Remove 2FA (authenticator lost)
docker exec -it hytale-manager node dist/cli.js disable-2fa admin

# List all users
docker exec -it hytale-manager node dist/cli.js list-users
```

> With a custom `STACK_NAME` the container is named accordingly, e.g. `hytale-prod-manager`. With Docker Compose you can also run: `docker compose exec manager node dist/cli.js auth-status`
>
> A password reset invalidates all active sessions of that account immediately. Changes apply without a restart.

### Environment Variables

All variables with comments are in [`.env.example`](.env.example). The most important ones:

#### Access (only without the setup wizard)

Not needed with the wizard. The wizard generates the JWT secret itself and stores the admin account and the allowed origin in the panel configuration.

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret key (min. 32 characters) - `openssl rand -base64 48` |
| `CORS_ORIGINS` | Allowed origins (e.g., `http://localhost:18080`) |
| `MANAGER_USERNAME` | Admin username (only for the **initial** account, then `users.json` applies) |
| `MANAGER_PASSWORD` | Admin password (min. 12 characters; only for the **initial** account, later changes via the panel or the `reset-password` CLI, see above) |

#### General

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST_DATA_PATH` | /opt/hytale | Host folder for all server data (see "Host path and contents") |
| `STACK_NAME` | hytale | Prefix for container and network names (several stacks side by side) |
| `DOCKER_MEMORY_LIMIT` | 8G | RAM limit of the server container; must hold `JAVA_MAX_RAM` plus a quarter (at most 1.5G) |
| `DOCKER_CPU_LIMIT` | 4 | CPU limit of the server container |

#### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `JAVA_MIN_RAM` | 3G | Minimum RAM |
| `JAVA_MAX_RAM` | 4G | Maximum RAM |
| `SERVER_PORT` | 5520 | UDP Port |
| `SERVER_BIND` | 0.0.0.0 | Address the server listens on |
| `SERVER_JAR` | HytaleServer.jar | Server JAR file (e.g., `Hyinit-0.1.0-pre1.jar`) |
| `EXTRA_SERVER_ARGS` | - | Additional server arguments |
| `EXTRA_JAVA_ARGS` | - | Additional JVM arguments |
| `AUTH_MODE` | authenticated | `offline` for LAN-only |
| `TZ` | Europe/Berlin | Timezone |
| `LOG_RETENTION_DAYS` | 14 | Delete server logs older than N days on start (`0` = off) |
| `LOG_MAX_FILES` | 50 | Keep at most N server logs (`0` = unlimited) |
| `FIX_OWNERSHIP` | true | On start, set only deviating file owners to UID 9999 (`false` e.g. for NFS with root_squash) |
| `HYTALE_AUTH_KEY_FILE` | `auth/auth.passphrase` | Key file for the saved server login (`auth.enc`), generated automatically |
| `SERVER_STOP_TIMEOUT_SECONDS` | 120 | How long the server may save after `/stop` before the panel falls back to `docker stop` |

#### Download

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_HYTALE_DOWNLOADER` | false | Use official downloader |
| `HYTALE_PATCHLINE` | release | `release` or `pre-release` |
| `AUTO_UPDATE` | false | Check for updates on restart (the panel switch wins) |
| `DOWNLOADER_TIMEOUT` | 3600 | Downloader calls are aborted after this many seconds |
| `SERVER_JAR_URL` | - | URL to HytaleServer.jar |
| `ASSETS_URL` | - | URL to Assets.zip |

#### Manager Panel

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGER_PORT` | 18080 | Web panel port |
| `SECURITY_MODE` | strict | `strict` or `warn` |
| `TRUST_PROXY` | false | For reverse proxy (nginx, traefik) |
| `WEBMAP_PORT` / `WEBMAP_WS_PORT` | 18081 / 18082 | Live map ports (EasyWebMap) |
| `WEBMAP_BIND` | 0.0.0.0 | Host address of the map ports; `127.0.0.1` = map only through the panel |
| `WATCHDOG_*` | see `.env.example` | Crash detection, alert thresholds and auto-restart |
| `ARCHIVE_EXTRACT_MAX_GB` / `ARCHIVE_MAX_ENTRIES` | 50 / 500000 | Limits for backup restore and world import |

More variables (multiserver, metrics, outbound connections) are covered in [Advanced features](#advanced-features).

#### Backups (Hytale built-in)

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_BACKUP` | false | Additionally run automatic native server backups every `BACKUP_FREQUENCY` minutes |
| `BACKUP_FREQUENCY` | 30 | Backup interval in minutes |

The server always writes native backups to `${HOST_DATA_PATH}/backups/native`, so `/backup` and the backup before an update work. Plan automatic backups with retention in the panel under **Scheduler**.

### Network

Hytale uses **UDP port 5520** (QUIC), not TCP.

Router port forwarding:
- Protocol: **UDP**
- Port: **5520**

### Host path and contents

Data lives in bind mounts under `HOST_DATA_PATH` (default `/opt/hytale`), not in Docker volumes. You can back it up directly or put it on a NAS.

| Host path | Contents |
|-----------|----------|
| `<HOST_DATA_PATH>/server` | Server JAR, `Assets.zip`, server configuration, logs |
| `<HOST_DATA_PATH>/data` | Worlds and other server data |
| `<HOST_DATA_PATH>/backups` | Backups (native server backups under `backups/native`) |
| `<HOST_DATA_PATH>/plugins` | Server plugins |
| `<HOST_DATA_PATH>/mods` | Server mods |
| `<HOST_DATA_PATH>/prefabs` | Prefabs |
| `<HOST_DATA_PATH>/downloader` | Hytale Downloader and its credentials |
| `<HOST_DATA_PATH>/auth` | Saved server login (`auth.enc`) and key file |
| `<HOST_DATA_PATH>/updater` | Update staging and backup of the previous version (Update Center, rollback) |
| `<HOST_DATA_PATH>/assets` | Asset Explorer cache (extracted game assets) |
| `<HOST_DATA_PATH>/instances` | Folders of the additional servers (multiserver), one per server id |

The only named Docker volume is `<STACK_NAME>-manager-data` (default `hytale-manager-data`). It holds the panel data: `users.json`, `roles.json`, `config.json`, `servers.json`, the `panel.sqlite` database with audit log, API keys and webhooks, and the replay segments.

The containers run as UID 9999. If the owners of the host folders do not match, the start corrects them (switch off with `FIX_OWNERSHIP=false`); the panel also checks folder permissions under *Settings*.

### Commands

```bash
# View logs
docker logs -f hytale

# Restart
docker restart hytale

# Rebuild containers after update
docker compose build && docker compose up -d
```

You operate the server console in the panel. Access through `docker attach` is described in the [appendix](#appendix-console-via-docker-attach).

### Updates

The panel handles server updates (page "Updates", automatically on request). To force a fresh server download, stop the container and empty the server folder:

```bash
docker stop hytale
rm -rf "${HOST_DATA_PATH:-/opt/hytale}/server"/*
docker start hytale
```

The next start downloads the server again (downloader login required).

---

## Erweiterte Funktionen

Alles in diesem Kapitel ist optional. Die Variablen setzt du wie die übrigen in der `.env` bzw. in Portainer.

### Multiserver (experimentell)

Mit `MULTISERVER_ENABLED=true` legt das Panel weitere Hytale-Server als eigene Container an (Standard: aus). Ohne den Schalter werden keine Server angelegt und die Server-Auswahl ist ausgeblendet; bestehende Zusatz-Server bleiben sichtbar und löschbar.

- Zusatz-Server nutzen das Image des Haupt-Containers. Mit `HYTALE_IMAGE` wählst du stattdessen ein anderes lokales Image.
- Ihre Dateien liegen in `${HOST_DATA_PATH}/instances/<id>/`. Nach einem Update von einer älteren `docker-compose.yml` den Stack neu erstellen (`docker compose up -d`), damit der Mount `instances` im Manager vorhanden ist; ohne ihn antwortet das Panel mit 409.
- Spiel- und Kartenports werden beim Anlegen automatisch vergeben, sofern du keine angibst. `POST /api/servers` kennt kein Feld `publishWebMap`: Die Live-Karte wird veröffentlicht, wenn Kartenports (`webMapPort`, `webMapWsPort`) angegeben sind, sonst nicht.
- Mit Docker-Socket-Proxy (siehe `docker-compose.yml`) braucht das Panel zusätzlich die Endpunkte für Images und Netzwerke; die Beispielkonfiguration dort enthält sie.

**Server-Zugriffslisten:** Jeder Benutzer (Benutzerverwaltung) und jeder API-Key kann auf bestimmte Server eingeschränkt werden. Ohne Liste gelten alle Server. Eine Liste schränkt nur ein; Rechte vergibt weiterhin die Rolle. Administratoren ignorieren ihre eigene Liste. Konten mit Liste haben die panelweiten Rechte nicht (Benutzer- und Rollenverwaltung, Webhooks, Einstellungen, Audit-Log), weil diese Funktionen alle Server betreffen.

**Bekannte Grenze:** Spät eintreffende Befehlsantworten (etwa Download-Fortschritt oder Ergebnisse aus einem Welt-Thread) sieht nur, wer den Befehl ausgeführt hat; andere Admins finden sie nicht im gemeinsamen Konsolen-Log. Das Server-Log selbst enthält sie weiter.

### Single Sign-On (SSO)

Anmeldung über Discord (OAuth2). Es gibt keine Oberfläche dafür; die Anbieter stehen in `config.json` im Manager-Datenvolume (`/app/data/config.json`):

```json
{
  "sso": {
    "enabled": true,
    "providers": [{
      "id": "discord",
      "type": "discord",
      "clientId": "...",
      "clientSecret": "...",
      "allowedGuildIds": ["..."],
      "defaultRoleId": "viewer",
      "autoCreate": true
    }]
  }
}
```

Als Redirect-URI trägst du im Discord-Developer-Portal `https://DEIN-PANEL/api/auth/sso/discord/callback` ein (hinter einem Reverse Proxy mit `TRUST_PROXY=true`). `autoCreate` legt unbekannte Konten mit der Rolle `defaultRoleId` an; `allowedGuildIds` beschränkt die Anmeldung auf Mitglieder bestimmter Discord-Server. Andere Anbieter (generisches OIDC) sind noch nicht umgesetzt.

### API-Keys mit Scopes

Unter *Sicherheit* erzeugst du API-Keys für Skripte. Jeder Key trägt Scopes (dieselben Namen wie die Berechtigungen der Rollen, z. B. `players.view`, `console.execute`), optional ein Ablaufdatum und optional eine Server-Liste.

```bash
curl -H "Authorization: ApiKey kp_..." http://SERVER-IP:18080/api/players
```

- Der Token (`kp_...`) wird nur **einmal** angezeigt; gespeichert ist nur ein Hash.
- Ein Key darf höchstens, was seine Scopes **und** die aktuellen Rechte seines Besitzers gemeinsam erlauben. Du kannst nur Scopes vergeben, die du selbst hältst.
- Befehle an die Konsole brauchen den Scope `console.execute`, Admin-Befehle zusätzlich `console.execute.admin`.
- Eine Übersicht der Endpunkte steht im [API Cheatsheet](docs/V3_API_CHEATSHEET.md).

### Metriken für Prometheus (`METRICS_TOKEN`)

`GET /api/metrics` liefert Prometheus-Metriken. Zugriff haben Benutzer mit dem Recht `audit.view` (JWT oder API-Key) oder, für Scraper ohne Panel-Konto, ein statischer Token:

```env
METRICS_TOKEN=ein-langer-zufaelliger-wert
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: hytale-panel
    metrics_path: /api/metrics
    authorization:
      credentials: ein-langer-zufaelliger-wert
    static_configs:
      - targets: ['SERVER-IP:18080']
```

Ohne `METRICS_TOKEN` bleibt nur der Zugang per Anmeldung. Der Token ist dann wie ein Passwort zu behandeln.

### Eigenes Image für Zusatz-Server (`HYTALE_IMAGE`)

Standardmäßig starten Zusatz-Server mit dem Image des Haupt-Containers (`${STACK_NAME}`). `HYTALE_IMAGE=meinimage:tag` setzt stattdessen ein anderes, lokal vorhandenes Image. Das Panel lädt keine Images nach.

### Event-Aktionen

Unter **Event-Aktionen** bindest du Regeln an Server-Ereignisse (genauer Name wie `player.joined` oder eine ganze Kategorie wie `player.*`). Aktionstypen:

| Aktion | Wirkung |
|--------|---------|
| **Befehl** | Führt einen Konsolenbefehl aus; Platzhalter wie `{player}` werden eingesetzt |
| **Ankündigung** | Sendet eine Nachricht an alle Spieler |
| **Backup** | Startet ein Backup |

Eine Regel gilt für einen Server oder für alle. Befehlsregeln laufen mit den aktuellen Rechten des Benutzers, der sie gespeichert hat, und brauchen dieselbe Konsolen-Berechtigung wie der Befehl selbst. Regeln, die das Panel deshalb nicht ausführt, zeigen den Grund und lassen sich von einem berechtigten Admin mit **Freigeben** übernehmen. Vorlagen erleichtern den Einstieg.

### Recovery-CLI

Ausgesperrt? `docker exec -it hytale-manager node dist/cli.js auth-status`, `reset-password`, `create-admin`, `disable-2fa`, `list-users`. Die Befehle stehen mit Beispielen unter [Login-Probleme & Passwort-Reset](#login-probleme--passwort-reset-cli).

### Web-Push (`WEB_PUSH_EXTRA_HOSTS`)

Web-Push schickt Warnungen (Abstürze, Alarme) als Browser-Benachrichtigung aufs Handy oder den Desktop. Aktivieren: *Einstellungen* → Push-Benachrichtigungen. Die VAPID-Schlüssel erzeugt das Panel beim ersten Aktivieren selbst. Für das Handy braucht das Panel HTTPS (Reverse Proxy mit `TRUST_PROXY=true`).

Das Panel nimmt Push-Abos nur für die Push-Dienste der Browser an (Google FCM, Mozilla, Microsoft WNS, Apple). Für weitere Dienste, etwa ein selbst betriebenes UnifiedPush, trägst du die Hosts kommagetrennt ein (Subdomains eingeschlossen):

```env
WEB_PUSH_EXTRA_HOSTS=push.example.org
```

### Ausgehende Webhooks an interne Ziele (`ALLOW_INTERNAL_WEBHOOKS`)

Webhooks an private Adressen (`localhost`, `10.x`, `192.168.x`, `fd..::`) sind gesperrt, damit das Panel nicht als Sprungbrett ins interne Netz missbraucht wird. Brauchst du ein internes Ziel (z. B. n8n im eigenen LAN), setze:

```env
ALLOW_INTERNAL_WEBHOOKS=true
```

Cloud-Metadaten-Adressen (`169.254.x.x`) bleiben immer gesperrt. Schalte das nur ein, wenn nur vertrauenswürdige Admins Webhooks anlegen dürfen.

---

## Advanced features

Everything in this chapter is optional. Set the variables like the others, in `.env` or in Portainer.

### Multiserver (experimental)

With `MULTISERVER_ENABLED=true` the panel creates additional Hytale servers as their own containers (default: off). While it is off, no servers can be created and the server picker is hidden; existing extra servers stay visible and can be deleted.

- Extra servers use the image of the primary container. `HYTALE_IMAGE` picks another local image instead.
- Their files live in `${HOST_DATA_PATH}/instances/<id>/`. After updating from an older `docker-compose.yml`, re-create the stack (`docker compose up -d`) so the manager has the `instances` mount; without it the panel answers 409.
- Game and map ports are allocated automatically unless you pass them. `POST /api/servers` has no `publishWebMap` field: the live map is published when map ports (`webMapPort`, `webMapWsPort`) are given, and not otherwise.
- With the Docker socket proxy (see `docker-compose.yml`) the panel also needs the image and network endpoints; the sample configuration there includes them.

**Server access lists:** Every user (user management) and every API key can be limited to specific servers. Without a list, all servers apply. A list only restricts; the role still grants the permissions. Administrators ignore their own list. Accounts with a list do not have the panel-wide permissions (user and role management, webhooks, settings, audit log), because those functions concern all servers.

**Known limit:** Command replies that arrive late (for example download progress or results from a world thread) are only seen by the person who ran the command; other admins do not find them in the shared console log. The server log itself still contains them.

### Single sign-on (SSO)

Sign-in through Discord (OAuth2). There is no UI for it; providers are defined in `config.json` in the manager data volume (`/app/data/config.json`):

```json
{
  "sso": {
    "enabled": true,
    "providers": [{
      "id": "discord",
      "type": "discord",
      "clientId": "...",
      "clientSecret": "...",
      "allowedGuildIds": ["..."],
      "defaultRoleId": "viewer",
      "autoCreate": true
    }]
  }
}
```

In the Discord developer portal, register `https://YOUR-PANEL/api/auth/sso/discord/callback` as the redirect URI (behind a reverse proxy with `TRUST_PROXY=true`). `autoCreate` creates unknown accounts with the role `defaultRoleId`; `allowedGuildIds` limits sign-in to members of specific Discord servers. Other providers (generic OIDC) are not implemented yet.

### API keys with scopes

Under *Security* you create API keys for scripts. Each key carries scopes (the same names as role permissions, e.g. `players.view`, `console.execute`), an optional expiry and an optional server list.

```bash
curl -H "Authorization: ApiKey kp_..." http://SERVER-IP:18080/api/players
```

- The token (`kp_...`) is shown **once**; only a hash is stored.
- A key may do at most what its scopes **and** the current permissions of its owner allow together. You can only grant scopes you hold yourself.
- Console commands need the scope `console.execute`; admin-level commands additionally need `console.execute.admin`.
- An overview of the endpoints is in the [API cheatsheet](docs/V3_API_CHEATSHEET.md).

### Prometheus metrics (`METRICS_TOKEN`)

`GET /api/metrics` serves Prometheus metrics. Users with the `audit.view` permission (JWT or API key) have access, and so does a static token for scrapers without a panel account:

```env
METRICS_TOKEN=a-long-random-value
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: hytale-panel
    metrics_path: /api/metrics
    authorization:
      credentials: a-long-random-value
    static_configs:
      - targets: ['SERVER-IP:18080']
```

Without `METRICS_TOKEN` only signed-in access remains. Treat the token like a password.

### Custom image for extra servers (`HYTALE_IMAGE`)

By default extra servers start from the image of the primary container (`${STACK_NAME}`). `HYTALE_IMAGE=myimage:tag` uses another, locally available image instead. The panel does not pull images.

### Event actions

Under **Event actions** you bind rules to server events (an exact name such as `player.joined`, or a whole category such as `player.*`). Action types:

| Action | Effect |
|--------|--------|
| **Command** | Runs a console command; placeholders such as `{player}` are filled in |
| **Announcement** | Sends a message to all players |
| **Backup** | Starts a backup |

A rule applies to one server or to all. Command rules run with the current permissions of the user who saved them and need the same console permission as the command itself. Rules the panel therefore does not run show the reason and can be taken over by a permitted admin with **Approve**. Templates make getting started easier.

### Recovery CLI

Locked out? `docker exec -it hytale-manager node dist/cli.js auth-status`, `reset-password`, `create-admin`, `disable-2fa`, `list-users`. The commands with examples are under [Login problems & password reset](#login-problems--password-reset-cli).

### Web Push (`WEB_PUSH_EXTRA_HOSTS`)

Web Push sends alerts (crashes, warnings) as a browser notification to your phone or desktop. Enable it under *Settings* → push notifications. The panel generates the VAPID keys itself the first time you enable it. Phones need the panel on HTTPS (reverse proxy with `TRUST_PROXY=true`).

The panel only accepts push subscriptions for the browsers' push services (Google FCM, Mozilla, Microsoft WNS, Apple). For other services, such as a self-hosted UnifiedPush server, list the hosts comma-separated (subdomains included):

```env
WEB_PUSH_EXTRA_HOSTS=push.example.org
```

### Outbound webhooks to internal targets (`ALLOW_INTERNAL_WEBHOOKS`)

Webhooks to private addresses (`localhost`, `10.x`, `192.168.x`, `fd..::`) are blocked so the panel cannot be used as a stepping stone into your internal network. If you need an internal target (e.g. n8n on your LAN), set:

```env
ALLOW_INTERNAL_WEBHOOKS=true
```

Cloud metadata addresses (`169.254.x.x`) always stay blocked. Only enable this if just trusted admins may create webhooks.

---

## Anhang: Upgrade auf v2.0

*Nur relevant, wenn du von einer Version vor 2.0 (1.x) aktualisierst. Neue Installationen überspringen das.*

### Wichtige Änderungen in v2.0

Version 2.0 brachte **erhöhte Sicherheit** und erforderte zusätzliche Konfiguration.

#### Neue Variablen

| Variable | Beschreibung | Beispiel |
|----------|--------------|----------|
| `JWT_SECRET` | Geheimer Schlüssel für Token-Signierung (min. 32 Zeichen) | `openssl rand -base64 48` |
| `CORS_ORIGINS` | Erlaubte Origins für API-Zugriffe | `http://localhost:18080` |
| `MANAGER_USERNAME` | Admin-Benutzername | `admin` |
| `MANAGER_PASSWORD` | Admin-Passwort (min. 12 Zeichen empfohlen) | `MeinSicheresPasswort123` |

Seit 3.0 übernimmt der Setup-Wizard diese Werte; sie sind nur nötig, wenn du ohne Wizard startest.

#### Sicherheitsmodus

```env
# strict (Standard): Server startet nicht ohne sichere Konfiguration
# warn: Server startet mit Warnungen (NUR für geschlossene Netzwerke!)
SECURITY_MODE=strict
```

Im `strict` Modus prüft das Panel vor der Einrichtung:
- JWT_SECRET ist gesetzt und min. 32 Zeichen
- MANAGER_PASSWORD ist nicht "admin" oder zu kurz
- CORS_ORIGINS ist konfiguriert

#### Container läuft als Non-Root User

Der Manager-Container läuft als User `manager` (UID 9999) statt als root. Das kann zu **Berechtigungsproblemen** führen, wenn du von v1.x upgradest.

**Fix für bestehende Installationen:**
```bash
# Auf dem Host ausführen (HOST_DATA_PATH anpassen!)
sudo chown -R 9999:9999 /opt/hytale
sudo chmod -R g+rw /opt/hytale
```

#### Backup-Funktion von Hytale

Die eingebaute Backup-Funktion des Hytale Servers (`ENABLE_BACKUP`) erzeugte in früheren Versionen leere 0KB .zip Dateien und ist daher standardmäßig aus (Ursache war ein Symlink des Panels, der Server bekommt das Welt-Verzeichnis jetzt direkt). Empfehlung: **Scheduler-Backups** im Web Panel (Scheduler → "Auto Backups" aktivieren, Uhrzeit und Aufbewahrung einstellen).

#### Migration Checkliste

- [ ] `.env` Datei mit neuen Variablen aktualisieren (siehe `.env.example`) oder den Setup-Wizard nutzen
- [ ] Sicheres `MANAGER_PASSWORD` setzen (nicht "admin"!)
- [ ] Berechtigungen auf Host-Ordnern korrigieren (siehe oben)
- [ ] Container neu bauen: `docker compose build`
- [ ] Container starten: `docker compose up -d`

## Anhang: Konsole per docker attach

Die Konsole bedienst du im Panel. Wer direkt am Container arbeiten will:

```bash
# Console öffnen (verlassen: Ctrl+P, Ctrl+Q)
docker attach hytale
```

Der Server-Container läuft ohne TTY: Ctrl+C beendet den Server auch in `docker attach` nicht. Die Hytale-Anmeldung musst du nicht mehr hier erledigen, der Setup-Wizard führt sie durch. Wenn nötig, geht sie weiterhin per Konsole mit `/auth login device`.

## Appendix: Upgrade to v2.0

*Only relevant if you are updating from a version before 2.0 (1.x). New installations can skip this.*

### Important changes in v2.0

Version 2.0 brought **enhanced security** and required additional configuration.

#### New variables

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | Secret key for token signing (min. 32 characters) | `openssl rand -base64 48` |
| `CORS_ORIGINS` | Allowed origins for API access | `http://localhost:18080` |
| `MANAGER_USERNAME` | Admin username | `admin` |
| `MANAGER_PASSWORD` | Admin password (min. 12 characters recommended) | `MySecurePassword123` |

Since 3.0 the setup wizard takes over these values; they are only needed if you start without the wizard.

#### Security mode

```env
# strict (default): Server won't start without secure configuration
# warn: Server starts with warnings (ONLY for closed networks!)
SECURITY_MODE=strict
```

In `strict` mode, the panel checks before setup:
- JWT_SECRET is set and at least 32 characters
- MANAGER_PASSWORD is not "admin" or too short
- CORS_ORIGINS is configured

#### Container runs as non-root user

The manager container runs as user `manager` (UID 9999) instead of root. This may cause **permission issues** when upgrading from v1.x.

**Fix for existing installations:**
```bash
# Run on host (adjust HOST_DATA_PATH!)
sudo chown -R 9999:9999 /opt/hytale
sudo chmod -R g+rw /opt/hytale
```

#### Hytale built-in backup

The built-in backup function of the Hytale server (`ENABLE_BACKUP`) created empty 0KB .zip files in earlier versions and is therefore off by default (the cause was a panel symlink; the server now gets the world directory directly). Recommendation: **Scheduler backups** in the web panel (Scheduler → enable "Auto Backups", set time and retention).

#### Migration checklist

- [ ] Update `.env` file with new variables (see `.env.example`) or use the setup wizard
- [ ] Set a secure `MANAGER_PASSWORD` (not "admin"!)
- [ ] Fix permissions on host folders (see above)
- [ ] Rebuild containers: `docker compose build`
- [ ] Start containers: `docker compose up -d`

## Appendix: Console via docker attach

You operate the console in the panel. If you prefer to work directly on the container:

```bash
# Open console (exit: Ctrl+P, Ctrl+Q)
docker attach hytale
```

The server container runs without a TTY: Ctrl+C does not stop the server, not even in `docker attach`. You no longer need to do the Hytale login here, the setup wizard guides you through it. If needed it still works from the console with `/auth login device`.

---

## Documentation

- **[Changelog](CHANGELOG.md)** - Recent changes and updates
- **[API Cheatsheet](docs/V3_API_CHEATSHEET.md)** - Endpoint overview
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
