# Changelog

Versionshistorie des KyuubiSoft Hytale Panels.

---

## Version 2.0.0 - Production Ready Security Release
**Veröffentlicht:** 2026-01-19

### Sicherheitsbewertung: 9/10

Diese Version markiert den Übergang zu einem produktionsreifen, sicherheitsgehärteten System nach umfassender externer Sicherheitsprüfung.

---

### Kritische Sicherheitsfixes

#### Command Injection Prevention
- Whitelist von 35 erlaubten Spielbefehlen implementiert
- Befehle müssen mit `/` beginnen
- Blockiert Shell-Metazeichen: `;`, `|`, `&`, `$`, `` ` ``
- Blockiert Command Substitution: `$(...)`, `${...}`
- Blockiert Umleitungen: `>`, `<`
- **Datei:** `manager/backend/src/utils/sanitize.ts`

#### Path Traversal Protection
- Mehrschichtige Validierung für alle Dateioperationen
- `sanitizeFileName()`: Extrahiert Basename, blockiert `..` und versteckte Dateien
- `isPathSafe()`: Validiert Pfade innerhalb erlaubter Verzeichnisse
- Angewendet auf: Mod/Plugin-Operationen, Config-Dateien
- **Datei:** `manager/backend/src/utils/pathSecurity.ts`

#### ReDoS Prevention (Regular Expression Denial of Service)
- Pattern-Längenlimit: 100 Zeichen
- Blockiert verschachtelte Quantifizierer: `(a+)+`, `(a*)*`
- Quantifizierer-Limit: 10
- Gruppen-Limit: 5
- Backreferences abgelehnt
- **Datei:** `manager/backend/src/services/assets.ts`

---

### Hohe Priorität Fixes

#### Magic Byte File Verification
- Validiert hochgeladene Dateien gegen erwartetes Format
- ZIP/JAR Signatur-Prüfung: `PK\x03\x04`
- Binary-Content-Erkennung für Textdateien
- Gefährliche Erweiterungen blockiert: `.dll`, `.so`

#### Safe Filename Generation
- Verhindert Filename-Collision-Angriffe
- Zufälliges 8-Zeichen Hex-Präfix via `crypto.randomBytes(4)`
- Zeichen-Whitelist: `[a-zA-Z0-9._-]`
- Maximale Länge: 100 Zeichen

#### Non-root Docker Container
- Manager läuft als unprivilegierter User `manager` (UID/GID 9999)
- `dumb-init` für korrektes Signal-Handling
- **Datei:** `manager/Dockerfile`

#### Required Environment Variables
- Keine unsicheren Defaults mehr
- `MANAGER_USERNAME`, `MANAGER_PASSWORD`, `JWT_SECRET` erforderlich
- Docker Compose erzwingt via Validierung
- Strict Security Mode blockiert Startup mit schwachen Credentials

#### Async bcrypt Operations
- Alle `bcrypt.hash()` und `bcrypt.compare()` jetzt async
- Verhindert Event-Loop-Blocking

---

### Mittlere Priorität Fixes

- **Global Exception Handler** - Express Error Middleware, Production Stack Traces versteckt
- **Content-Security-Policy Header** - Strikte CSP via Helmet
- **CSRF Protection** - Origin/Referer Validierung
- **Race Condition Fix** - Debounced Player Data Saves
- **Infrastructure Hardening** - JSON Body Limit 100kb, Docker no-new-privileges

---

### Neue Features

#### Permission Health Check
- Automatische Erkennung von Dateiberechtigungsproblemen
- Neuer `/api/health/permissions` Endpoint
- Warnt Benutzer beim Upgrade von v1.x
- Zeigt betroffene Verzeichnisse und Fix-Befehl
- Vollständige Lokalisierung (EN, DE, PT-BR)

---

### Breaking Changes

#### Umgebungsvariablen - JETZT ERFORDERLICH
```env
MANAGER_USERNAME=<eindeutiger-admin-username>
MANAGER_PASSWORD=<starkes-passwort-12+-zeichen>
JWT_SECRET=<starkes-secret-32+-zeichen>
CORS_ORIGINS=<spezifische-origins-nicht-wildcard>
```

#### Non-Root Container
- Manager Container läuft jetzt als unprivilegierter User (UID 9999)
- Bestehende Deployments brauchen Permission-Fix:
  ```bash
  sudo chown -R 9999:9999 /opt/hytale
  ```

#### WebSocket Authentication
- JWT Tokens nicht mehr in URL
- Single-Use Tickets (30 Sekunden Ablauf)

---

## Version 1.7.1
**Veröffentlicht:** 2026-01-19

### Neue Features

#### Command Help Page
- Komplette In-Game `/help` GUI nachgebaut
- 70+ Befehle in 8 Kategorien organisiert
- Live-Suchfunktion
- Copy-to-Clipboard für Befehlsverwendung
- Berechtigungsanzeige für jeden Befehl

#### Accept Early Plugins Option
- Neuer Toggle in Settings
- Aktiviert/Deaktiviert `--accept-early-plugins` Server-Flag
- Warnung über potenzielle Instabilität

---

## Version 1.7.0
**Veröffentlicht:** 2026-01-18

### Neue Features

#### Granulares Permission System
- Rollenbasierte Zugriffskontrolle
- 53 individuelle Berechtigungen in 18 Kategorien
- Benutzerdefinierte Rollenerstellung mit Farb-Badges
- System-Rollen: Administrator, Moderator, Operator, Viewer
- Wildcard `*` Berechtigung für vollen Admin-Zugriff

#### Enhanced Player Management
- Klick auf Spieler (online/offline) für Detail-Modal
- Tabbed Interface: Übersicht, Inventar, Aussehen, Chat, Tode
- Spieler-Inventar-Anzeige mit Item-Icons
- Todespositions-Tracking mit Teleport-Optionen
- Spieleraktionen: heilen, Inventar leeren, Items geben, teleportieren

#### Chat Log System
- Tägliche Datei-Rotation: `data/chat/global/YYYY-MM-DD.json`
- Per-Player Chat Logs: `data/chat/players/{name}/YYYY-MM-DD.json`
- Unbegrenzte Nachrichtenhistorie (1000 Nachrichten Limit entfernt)
- UUID-Tracking für Spieler über Namensänderungen
- Zeitbereich-Filter (7/14/30 Tage, alle)

#### i18n für Permission-Beschreibungen
- Übersetzt in DE, EN, PT-BR

---

## Version 1.5.0
**Veröffentlicht:** 2025-01-17

### Neue Features

#### Asset Explorer
- Durchsuchen und Analysieren von Hytale-Assets
- Extrahieren und Browsen von Assets.zip Inhalten
- Datei-Viewer: JSON, Bilder, Text, Hex
- Erweiterte Suche: Plaintext, Glob, Regex
- Async Extraktion für große Archive (3GB+)
- Persistenter Cache via Docker Volume

#### Reverse Proxy Support
- `TRUST_PROXY` Umgebungsvariable
- Korrekte Verarbeitung von `X-Forwarded-*` Headers
- Support für nginx, traefik, caddy, etc.

#### Patchline Toggle
- UI-Switch zwischen Release/Pre-Release
- Gespeichert in `data/panel-config.json`
- Auto-Delete von Server-Dateien bei Patchline-Wechsel

#### Console Improvements
- Reconnect-Button bei WebSocket-Disconnect
- Alle Logs laden (erhöht auf 10.000)

---

## Migration von v1.x auf v2.0

### Schritt 1: Umgebungsvariablen setzen
```bash
# In .env Datei:
MANAGER_USERNAME=your-admin-username
MANAGER_PASSWORD=your-strong-password        # min 8 Zeichen, 12+ empfohlen
JWT_SECRET=$(openssl rand -base64 48)
CORS_ORIGINS=https://your-domain.com         # spezifische Domain, nicht *
```

### Schritt 2: Dateiberechtigungen korrigieren
```bash
sudo chown -R 9999:9999 /opt/hytale
```

### Schritt 3: Deployment-Konfiguration aktualisieren
```yaml
# In docker-compose.yml:
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

### Schritt 4: Security Mode konfigurieren
```bash
# Für Produktion: SECURITY_MODE=strict (Standard)
# Für geschlossene Netzwerke: SECURITY_MODE=warn
```

---

## Pre-Deployment Checklist

- [ ] `MANAGER_USERNAME` auf eindeutigen Admin-Username gesetzt
- [ ] `MANAGER_PASSWORD` auf starkes Passwort gesetzt (12+ Zeichen empfohlen)
- [ ] `JWT_SECRET` generiert: `openssl rand -base64 48`
- [ ] `CORS_ORIGINS` auf spezifische Domain(s) gesetzt - NICHT `*`
- [ ] Reverse Proxy mit TLS (HTTPS) konfiguriert
- [ ] `SECURITY_MODE=strict` sichergestellt (Standard)
- [ ] Permission Health Check unter `/api/health/permissions` ausgeführt
- [ ] Alle Funktionen vor Produktions-Deployment getestet

---

## Nächste Schritte

- [[Installation]] - Neuinstallation
- [[Konfiguration]] - Alle Einstellungen
- [[Sicherheit]] - Sicherheitsdetails
