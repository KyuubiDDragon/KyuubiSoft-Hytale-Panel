# Installation

Diese Anleitung führt dich durch die Installation des KyuubiSoft Hytale Panels.

---

## Voraussetzungen

| Anforderung | Minimum | Empfohlen |
|-------------|---------|-----------|
| **RAM** | 4GB | 8GB+ |
| **CPU** | 2 Kerne | 4+ Kerne |
| **Speicher** | 10GB | 50GB+ |
| **Docker** | v20.10+ | Aktuellste Version |
| **Docker Compose** | v2.0+ | Aktuellste Version |

### Ports

| Port | Protokoll | Dienst |
|------|-----------|--------|
| 5520 | **UDP** | Hytale Server (QUIC) |
| 18080 | TCP | Web Admin Panel |
| 18081 | TCP | WebMap (optional) |
| 18082 | TCP | WebMap WebSocket (optional) |
| 18085 | TCP | KyuubiSoft API Plugin (intern) |

> **Wichtig:** Der Hytale Server verwendet UDP, nicht TCP!

---

## Installation mit Portainer (Empfohlen)

### Schritt 1: Stack hinzufügen

1. Öffne Portainer → **Stacks** → **Add Stack**
2. Name: `hytale`
3. Build Method: **Repository**
4. Repository URL: `https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel`

### Schritt 2: Umgebungsvariablen konfigurieren

Setze folgende **Pflicht-Variablen**:

```env
# Sicherheitskonfiguration (PFLICHT)
JWT_SECRET=<dein-geheimer-schlüssel>
CORS_ORIGINS=http://DEINE-SERVER-IP:18080
MANAGER_USERNAME=admin
MANAGER_PASSWORD=DeinSicheresPasswort123

# Server-Konfiguration
JAVA_MIN_RAM=3G
JAVA_MAX_RAM=4G
TZ=Europe/Berlin
```

**JWT_SECRET generieren:**
```bash
openssl rand -base64 48
```

### Schritt 3: Server-Dateien einrichten

Wähle eine der folgenden Optionen:

#### Option A: Offizieller Hytale Downloader (Empfohlen)

```env
USE_HYTALE_DOWNLOADER=true
HYTALE_PATCHLINE=release
```

Nach dem ersten Start:
```bash
docker attach hytale
/auth login device
# Browser-Link folgen und Code eingeben
```

#### Option B: Eigene Download-URLs

```env
SERVER_JAR_URL=https://dein-server/HytaleServer.jar
ASSETS_URL=https://dein-server/Assets.zip
```

#### Option C: Manuelle Kopie

```bash
docker cp Server/HytaleServer.jar hytale:/opt/hytale/server/
docker cp Assets.zip hytale:/opt/hytale/server/
docker restart hytale
```

---

## Manuelle Installation

### Schritt 1: Repository klonen

```bash
git clone https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel
cd KyuubiSoft-Hytale-Panel
```

### Schritt 2: Umgebungsvariablen konfigurieren

```bash
cp .env.example .env
nano .env
```

Mindestens diese Variablen setzen:

```env
# PFLICHT - Sicherheit
JWT_SECRET=$(openssl rand -base64 48)
CORS_ORIGINS=http://localhost:18080
MANAGER_USERNAME=admin
MANAGER_PASSWORD=DeinSicheresPasswort123

# Server-Einstellungen
HOST_DATA_PATH=/opt/hytale
JAVA_MIN_RAM=3G
JAVA_MAX_RAM=4G
SERVER_PORT=5520
MANAGER_PORT=18080
TZ=Europe/Berlin
```

### Schritt 3: Container starten

```bash
docker-compose up -d
```

### Schritt 4: Logs prüfen

```bash
docker logs -f hytale
docker logs -f hytale-manager
```

### Schritt 5: Panel öffnen

Öffne im Browser: `http://DEINE-IP:18080`

---

## Server-Authentifizierung

### Device Login

```bash
docker attach hytale
/auth login device
```

1. Folge dem angezeigten Browser-Link
2. Gib den angezeigten Code ein
3. Bestätige die Authentifizierung

### Authentifizierungsmodus ändern

```env
# Für Online-Server (Standard)
AUTH_MODE=authenticated

# Für LAN-only / Offline
AUTH_MODE=offline
```

---

## Update auf Version 2.0

### Schritt 1: Berechtigungen korrigieren

```bash
sudo chown -R 9999:9999 /opt/hytale
sudo chmod -R g+rw /opt/hytale
```

### Schritt 2: .env aktualisieren

Neue Pflicht-Variablen hinzufügen:

```env
JWT_SECRET=<generiert via openssl rand -base64 48>
CORS_ORIGINS=http://deine-domain.com
MANAGER_PASSWORD=<mindestens 12 Zeichen>
SECURITY_MODE=strict
```

### Schritt 3: Container neu bauen

```bash
docker-compose build
docker-compose up -d
```

### Migrations-Checkliste

- [ ] `.env` mit neuen Variablen aktualisiert
- [ ] JWT_SECRET generiert (mind. 32 Zeichen)
- [ ] CORS_ORIGINS gesetzt (nicht `*`)
- [ ] MANAGER_PASSWORD sicher (mind. 12 Zeichen)
- [ ] Berechtigungen korrigiert (UID 9999)
- [ ] Container neu gebaut
- [ ] Panel erreichbar und funktionsfähig

---

## Docker Volumes

| Volume | Pfad im Container | Inhalt |
|--------|-------------------|--------|
| `hytale-server` | `/opt/hytale/server` | Server JAR + Assets |
| `hytale-data` | `/opt/hytale/data` | Welten, Configs |
| `hytale-backups` | `/opt/hytale/backups` | Backup-Archive |
| `hytale-plugins` | `/opt/hytale/plugins` | Server Plugins |
| `hytale-mods` | `/opt/hytale/mods` | Server Mods |
| `hytale-downloader` | `/opt/hytale/downloader` | Downloader + Credentials |
| `hytale-auth` | `/opt/hytale/auth` | Server Auth Credentials |
| `manager-data` | `/app/data` | Panel-Daten |

---

## Nächste Schritte

- [[Konfiguration]] - Alle Einstellungsmöglichkeiten
- [[Features]] - Panel-Funktionen erkunden
- [[Benutzerverwaltung]] - Benutzer und Rollen einrichten
- [[Fehlerbehebung]] - Bei Problemen
