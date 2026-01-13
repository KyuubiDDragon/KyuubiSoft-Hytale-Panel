# 🎮 Hytale Dedicated Server - Docker

Docker-Setup für einen Hytale Dedicated Server mit automatischen Backups, einfacher Konfiguration und Update-Unterstützung.

## 📋 Voraussetzungen

- Docker & Docker Compose
- Hytale-Account mit gekauftem Spiel
- Server-Dateien aus deiner Hytale-Installation

## 🚀 Quick Start

### 1. Server-Dateien besorgen

Du brauchst zwei Dateien aus deiner Hytale-Installation:

```
C:\Users\<USER>\Hytale\install\release\package\game\latest\
├── Server/
│   └── HytaleServer.jar
└── Assets.zip
```

**Oder** nutze den offiziellen Hytale Downloader:
1. Lade `hytale-downloader.zip` von der Hytale Support-Seite
2. Führe `hytale-downloader` aus (OAuth2-Login erforderlich)

### 2. Dateien kopieren

```bash
# Verzeichnisstruktur erstellen
mkdir -p server data backups plugins mods logs

# Server-Dateien kopieren
cp /pfad/zu/Server/HytaleServer.jar ./server/
cp /pfad/zu/Assets.zip ./server/

# Optional: AOT Cache für schnelleren Start
cp /pfad/zu/Server/HytaleServer.aot ./server/
```

### 3. Server starten

```bash
# Image bauen und starten
docker-compose up -d

# Logs anschauen
docker-compose logs -f
```

### 4. Server authentifizieren (WICHTIG!)

Beim ersten Start muss der Server authentifiziert werden:

```bash
# Mit Server-Console verbinden
docker attach hytale-server

# In der Console:
/auth login device
```

Es erscheint ein Link und Code:
```
=================================================================
DEVICE AUTHORIZATION
=================================================================
Visit: https://accounts.hytale.com/device
Enter code: ABCD-1234
=================================================================
```

Öffne den Link im Browser, gib den Code ein und melde dich an.

**Console verlassen:** `Ctrl+P` dann `Ctrl+Q`

## ⚙️ Konfiguration

### Umgebungsvariablen (.env oder docker-compose.yml)

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `JAVA_MIN_RAM` | 3G | Minimaler RAM |
| `JAVA_MAX_RAM` | 4G | Maximaler RAM |
| `SERVER_PORT` | 5520 | Server-Port (UDP!) |
| `ENABLE_BACKUP` | true | Automatische Backups |
| `BACKUP_FREQUENCY` | 30 | Backup-Intervall (Minuten) |
| `AUTH_MODE` | authenticated | `offline` für LAN-only |
| `TZ` | Europe/Berlin | Zeitzone |

### RAM-Empfehlungen

| Spieler | View Distance | Empfohlener RAM |
|---------|---------------|-----------------|
| 1-5 | 12 | 4G |
| 5-10 | 12 | 6G |
| 10-20 | 10 | 8G |
| 20+ | 8 | 12G+ |

## 📁 Verzeichnisstruktur

```
hytale-docker/
├── docker-compose.yml
├── Dockerfile
├── .env
├── server/               # Server-Dateien (read-only)
│   ├── HytaleServer.jar
│   ├── Assets.zip
│   └── HytaleServer.aot  # Optional
├── data/                 # Welten & Konfiguration
│   └── worlds/
├── backups/              # Automatische Backups
├── plugins/              # Server-Plugins (.jar)
├── mods/                 # Server-Mods
├── logs/                 # Server-Logs
└── scripts/
    ├── entrypoint.sh
    ├── start-server.sh
    ├── backup.sh
    └── healthcheck.sh
```

## 🔧 Server-Befehle

```bash
# Server starten
docker-compose up -d

# Server stoppen
docker-compose down

# Server neustarten
docker-compose restart

# Logs anschauen
docker-compose logs -f

# Mit Console verbinden
docker attach hytale-server
# Verlassen: Ctrl+P, Ctrl+Q

# Manuelles Backup
docker exec hytale-server /opt/hytale/backup.sh

# Server-Status
docker-compose ps
```

## 🌐 Netzwerk / Port-Forwarding

**WICHTIG:** Hytale nutzt **UDP** Port 5520 (QUIC-Protokoll), **nicht TCP!**

### Router Port-Forwarding
- Protokoll: **UDP**
- Externer Port: 5520
- Interner Port: 5520
- Ziel-IP: IP deines Docker-Hosts

### Firewall (Linux)
```bash
sudo ufw allow 5520/udp
```

### Firewall (Windows)
```powershell
New-NetFirewallRule -DisplayName "Hytale Server" -Direction Inbound -Protocol UDP -LocalPort 5520 -Action Allow
```

## 🔄 Updates

### Server-Dateien aktualisieren

```bash
# Server stoppen
docker-compose down

# Neue Dateien kopieren
cp /pfad/zu/neuen/HytaleServer.jar ./server/
cp /pfad/zu/neuen/Assets.zip ./server/

# Image neu bauen und starten
docker-compose up -d --build
```

### Mit Hytale Downloader

```bash
# Downloader ausführen (prüft auf Updates)
./hytale-downloader -check-update

# Updates herunterladen
./hytale-downloader
```

## 🔐 Offline-Modus (LAN-only)

Für reine LAN-Server ohne Internet-Authentifizierung:

```yaml
# In docker-compose.yml oder .env
AUTH_MODE=offline
```

**Hinweis:** Im Offline-Modus können nur lokale Spieler joinen.

## 🛠️ Troubleshooting

### Server startet nicht
- Prüfe ob `HytaleServer.jar` und `Assets.zip` in `./server/` liegen
- Prüfe Logs: `docker-compose logs`

### "Authentication failed"
- Führe `/auth login device` aus
- Stelle sicher, dass dein Hytale-Account das Spiel besitzt

### Spieler können nicht verbinden
- Prüfe Port-Forwarding (UDP 5520!)
- Prüfe Firewall
- Stelle sicher, dass der Server authentifiziert ist

### Hohe RAM-Nutzung
- Reduziere View Distance
- Erhöhe `JAVA_MAX_RAM`

### Backup-Fehler
- Prüfe Schreibrechte für `./backups/`
- Prüfe freien Speicherplatz

## 📊 Monitoring (optional)

Falls du PRTG oder andere Monitoring-Tools nutzt:

- **Process Monitor:** `HytaleServer.jar`
- **Port Check:** UDP 5520
- **Memory:** Java-Heap-Usage

## 📝 Nützliche Links

- [Hytale Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)
- [Server Provider Auth Guide](https://support.hytale.com/hc/en-us/articles/45328341414043-Server-Provider-Authentication-Guide)
- [Hytale Modding Docs](https://hytale.com/news/2025/11/hytale-modding-strategy-and-status)

---

**Viel Spaß mit Hytale! 🎮**
