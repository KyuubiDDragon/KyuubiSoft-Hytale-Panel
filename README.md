# 🎮 Hytale Dedicated Server - Docker

Vollautomatisches Docker-Setup für Hytale Server. Einfach als Stack in Portainer deployen!

## 🚀 Quick Start mit Portainer

### 1. Stack hinzufügen
- Portainer → Stacks → **Add Stack**
- Name: `hytale`
- Build method: **Repository**
- Repository URL: `https://github.com/DEIN-USER/hytale-docker`

### 2. Server-Dateien - Wähle eine Option:

#### Option A: Offizieller Hytale Downloader (empfohlen)
Lädt automatisch vom offiziellen Server. Erfordert einmaligen OAuth-Login.

| Variable | Wert |
|----------|------|
| `USE_HYTALE_DOWNLOADER` | `true` |

Beim ersten Start erscheint ein Link + Code → Im Browser öffnen und einloggen.

#### Option B: Eigene Download-URLs
Lade die Dateien auf deinen NAS und gib die URLs an.

| Variable | Wert |
|----------|------|
| `SERVER_JAR_URL` | `https://dein-nas/HytaleServer.jar` |
| `ASSETS_URL` | `https://dein-nas/Assets.zip` |

Dateien findest du in: `%appdata%\Hytale\install\release\package\game\latest\`

#### Option C: Manuell kopieren
Nach dem Deploy:
```bash
docker cp Server/HytaleServer.jar hytale:/opt/hytale/server/
docker cp Assets.zip hytale:/opt/hytale/server/
docker restart hytale
```

### 3. Server authentifizieren

Nach dem ersten Start muss der Hytale-Server selbst auch authentifiziert werden:

```bash
# Console öffnen (Portainer oder Terminal)
docker attach hytale

# Im Server eingeben:
/auth login device
```

Link im Browser öffnen, Code eingeben, fertig!

---

## ⚙️ Alle Umgebungsvariablen

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `JAVA_MIN_RAM` | 3G | Minimaler RAM |
| `JAVA_MAX_RAM` | 4G | Maximaler RAM |
| `SERVER_PORT` | 5520 | UDP Port |
| `ENABLE_BACKUP` | true | Auto-Backups |
| `BACKUP_FREQUENCY` | 30 | Backup-Intervall (min) |
| `AUTH_MODE` | - | `offline` für LAN-only |
| `USE_HYTALE_DOWNLOADER` | false | Offiziellen Downloader nutzen |
| `HYTALE_PATCHLINE` | release | `release` oder `pre-release` |
| `SERVER_JAR_URL` | - | URL zu HytaleServer.jar |
| `ASSETS_URL` | - | URL zu Assets.zip |

---

## 🌐 Netzwerk

**WICHTIG:** Hytale nutzt **UDP** Port 5520 (QUIC), nicht TCP!

Router Port-Forwarding:
- Protokoll: **UDP**
- Port: 5520

---

## 📦 Volumes

| Volume | Inhalt |
|--------|--------|
| `hytale-server` | Server JAR + Assets |
| `hytale-data` | Welten, Configs |
| `hytale-backups` | Automatische Backups |
| `hytale-plugins` | Server Plugins |
| `hytale-mods` | Server Mods |
| `hytale-downloader` | Downloader + Credentials |

---

## 🔄 Updates

Mit Hytale Downloader:
```bash
# Container stoppen
docker stop hytale

# Server-Volume leeren (oder nur alte JAR löschen)
docker volume rm hytale-server

# Neu starten - lädt automatisch neue Version
docker start hytale
```

---

## 🛠️ Befehle

```bash
# Logs
docker logs -f hytale

# Console (verlassen: Ctrl+P, Ctrl+Q)
docker attach hytale

# Manuelles Backup
docker exec hytale /opt/hytale/backup.sh

# Neustart
docker restart hytale
```

---

## 📝 Links

- [Hytale Server Manual](https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual)
- [Hytale Downloader](https://downloader.hytale.com/hytale-downloader.zip)
