# Konfiguration

Vollständige Übersicht aller Konfigurationsoptionen des KyuubiSoft Hytale Panels.

---

## Pflicht-Variablen (v2.0)

Diese Variablen **müssen** gesetzt werden:

| Variable | Beschreibung | Beispiel |
|----------|--------------|----------|
| `JWT_SECRET` | Geheimer Schlüssel für Token-Signierung (min. 32 Zeichen) | `openssl rand -base64 48` |
| `CORS_ORIGINS` | Erlaubte Origins für API-Zugriff | `http://localhost:18080` |
| `MANAGER_USERNAME` | Admin-Benutzername | `admin` |
| `MANAGER_PASSWORD` | Admin-Passwort (min. 12 Zeichen empfohlen) | `MeinSicheresPasswort123!` |

### JWT_SECRET generieren

```bash
# Linux/macOS
openssl rand -base64 48

# Oder mit Node.js
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

### CORS_ORIGINS Beispiele

```env
# Einzelne Domain
CORS_ORIGINS=http://localhost:18080

# Mehrere Domains
CORS_ORIGINS=http://localhost:18080,https://panel.meinserver.de

# Mit HTTPS
CORS_ORIGINS=https://panel.meinserver.de
```

> **Warnung:** Verwende niemals `CORS_ORIGINS=*` in Produktion!

---

## Sicherheitskonfiguration

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `SECURITY_MODE` | `strict` | Sicherheitsmodus: `strict` oder `warn` |
| `TRUST_PROXY` | `false` | Auf `true` setzen hinter Reverse Proxy |

### Sicherheitsmodi

**`strict` (Standard)**
- Server startet nicht ohne korrekte Konfiguration
- JWT_SECRET muss mind. 32 Zeichen haben
- MANAGER_PASSWORD darf nicht "admin" sein
- CORS_ORIGINS muss konfiguriert sein

**`warn`**
- Server startet mit Warnungen
- Nur für geschlossene Netzwerke/Entwicklung

---

## Server-Konfiguration

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `HOST_DATA_PATH` | `/opt/hytale` | Host-Pfad für persistente Daten |
| `STACK_NAME` | `hytale` | Container-Namenspräfix |
| `JAVA_MIN_RAM` | `3G` | Minimum Java Heap |
| `JAVA_MAX_RAM` | `4G` | Maximum Java Heap |
| `SERVER_PORT` | `5520` | UDP Port (QUIC Protokoll) |
| `AUTH_MODE` | `authenticated` | `authenticated` oder `offline` |
| `TZ` | `Europe/Berlin` | Zeitzone |

### RAM-Einstellungen

```env
# Empfohlene Einstellungen nach Spieleranzahl
# 1-10 Spieler
JAVA_MIN_RAM=3G
JAVA_MAX_RAM=4G

# 10-50 Spieler
JAVA_MIN_RAM=4G
JAVA_MAX_RAM=6G

# 50+ Spieler
JAVA_MIN_RAM=6G
JAVA_MAX_RAM=8G
```

---

## Download-Konfiguration

### Option 1: Offizieller Hytale Downloader (Empfohlen)

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `USE_HYTALE_DOWNLOADER` | `false` | Offiziellen Downloader verwenden |
| `HYTALE_PATCHLINE` | `release` | `release` oder `pre-release` |
| `AUTO_UPDATE` | `false` | Automatische Update-Prüfung |

```env
USE_HYTALE_DOWNLOADER=true
HYTALE_PATCHLINE=release
AUTO_UPDATE=false
```

### Option 2: Eigene URLs

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `SERVER_JAR_URL` | - | URL zu HytaleServer.jar |
| `ASSETS_URL` | - | URL zu Assets.zip |

```env
SERVER_JAR_URL=https://mein-nas.local/hytale/HytaleServer.jar
ASSETS_URL=https://mein-nas.local/hytale/Assets.zip
```

---

## Manager Panel

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `MANAGER_PORT` | `18080` | Web Admin Panel Port |
| `WEBMAP_PORT` | `18081` | EasyWebMap Port |
| `WEBMAP_WS_PORT` | `18082` | WebMap WebSocket Port |

---

## Integrationen

### Modtale Integration

| Variable | Beschreibung |
|----------|--------------|
| `MODTALE_API_KEY` | API-Key für Modtale Mod-Store |

### StackMart Integration

| Variable | Beschreibung |
|----------|--------------|
| `STACKMART_API_KEY` | API-Key für StackMart |

---

## Docker Resource Limits

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `DOCKER_MEMORY_LIMIT` | `8G` | Container Memory Limit |
| `DOCKER_CPU_LIMIT` | `4` | Container CPU Limit |

```env
# Für größere Server
DOCKER_MEMORY_LIMIT=16G
DOCKER_CPU_LIMIT=8
```

> **Hinweis:** Memory Limit sollte mindestens `JAVA_MAX_RAM + 1GB` sein.

---

## Backup-Konfiguration

| Variable | Standard | Beschreibung |
|----------|----------|--------------|
| `ENABLE_BACKUP` | `false` | Hytale Built-in Backup (nicht empfohlen) |
| `BACKUP_FREQUENCY` | `30` | Backup-Intervall in Minuten |

> **Empfehlung:** Nutze stattdessen die Scheduler-Backups im Panel, da diese funktionierende `.tar.gz` Archive erstellen.

---

## Vollständige .env Beispieldatei

```env
# ==========================================
# KyuubiSoft Hytale Panel - Konfiguration
# ==========================================

# SICHERHEIT (PFLICHT)
# --------------------
JWT_SECRET=HIER_GENERIERTEN_SECRET_EINFUEGEN
CORS_ORIGINS=http://localhost:18080
MANAGER_USERNAME=admin
MANAGER_PASSWORD=MeinSuperSicheresPasswort123!
SECURITY_MODE=strict

# SERVER-KONFIGURATION
# --------------------
HOST_DATA_PATH=/opt/hytale
STACK_NAME=hytale
JAVA_MIN_RAM=3G
JAVA_MAX_RAM=4G
SERVER_PORT=5520
AUTH_MODE=authenticated
TZ=Europe/Berlin

# HYTALE DOWNLOADER
# -----------------
USE_HYTALE_DOWNLOADER=true
HYTALE_PATCHLINE=release
AUTO_UPDATE=false

# ALTERNATIV: EIGENE URLS
# SERVER_JAR_URL=https://example.com/HytaleServer.jar
# ASSETS_URL=https://example.com/Assets.zip

# MANAGER PANEL
# -------------
MANAGER_PORT=18080
TRUST_PROXY=false

# WEBMAP (OPTIONAL)
# -----------------
WEBMAP_PORT=18081
WEBMAP_WS_PORT=18082

# RESOURCE LIMITS
# ---------------
DOCKER_MEMORY_LIMIT=8G
DOCKER_CPU_LIMIT=4

# INTEGRATIONEN (OPTIONAL)
# ------------------------
# MODTALE_API_KEY=dein-api-key
# STACKMART_API_KEY=dein-api-key
```

---

## Quick Settings im Panel

Diese Einstellungen können direkt im Web Panel unter **Settings** → **Quick Settings** geändert werden:

| Einstellung | Beschreibung |
|-------------|--------------|
| Server Name | Name des Servers |
| MOTD | Message of the Day |
| Password | Server-Passwort (leer = kein Passwort) |
| Max Players | Maximale Spieleranzahl |
| Max View Radius | Maximale Sichtweite |
| Default Game Mode | Standard-Spielmodus |

---

## Server-Flags

Im Panel unter **Settings** verfügbare Optionen:

| Flag | Beschreibung |
|------|--------------|
| Accept Early Plugins | Aktiviert experimentelle Plugin-API |
| Disable Sentry | Deaktiviert Fehlerberichterstattung |
| Allow OP | Erlaubt Operator-Befehle |

---

## Nächste Schritte

- [[Sicherheit]] - Sicherheitsfeatures im Detail
- [[Features]] - Alle Panel-Funktionen
- [[Fehlerbehebung]] - Bei Konfigurationsproblemen
