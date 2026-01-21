# Sicherheit

Umfassende Dokumentation aller Sicherheitsfeatures des KyuubiSoft Hytale Panels.

---

## Sicherheitsbewertung

| Kategorie | Bewertung |
|-----------|-----------|
| Authentifizierung & Autorisierung | 9/10 |
| Input-Validierung | 9/10 |
| Command Injection Prevention | 10/10 |
| Path Traversal Prevention | 9/10 |
| Docker-Sicherheit | 9/10 |
| Fehlerbehandlung | 9/10 |
| Kryptographie | 10/10 |
| Konfigurationssicherheit | 9/10 |
| **GESAMT** | **9/10** |

---

## Authentifizierung

### JWT Token System

Das Panel verwendet ein duales Token-System:

| Token-Typ | Lebensdauer | Verwendung |
|-----------|-------------|------------|
| Access Token | 15 Minuten | API-Authentifizierung |
| Refresh Token | 7 Tage | Token-Erneuerung |

### Token-Versionierung

Bei Passwort- oder Rollenänderungen werden alle vorhandenen Tokens invalidiert:

```typescript
// Jeder Benutzer hat eine tokenVersion
user.tokenVersion++;
// Alte Tokens werden dadurch ungültig
```

### WebSocket-Tickets

Für WebSocket-Verbindungen werden Einmal-Tickets verwendet:

- **Lebensdauer:** 30 Sekunden
- **Einmalverwendung:** Nach Gebrauch sofort gelöscht
- **Kryptographisch sicher:** 32 Byte Zufallswert

**Vorteile:**
- Kein JWT in URL (verhindert Log-Exposition)
- Keine Tokens im Browser-Verlauf
- Keine Tokens in Referer-Headers

### Passwort-Sicherheit

- **Bcrypt-Hashing** mit Salt Rounds = 12
- **Async-Implementierung** zur Vermeidung von Event-Loop-Blocking
- **Minimum 8 Zeichen** (12+ empfohlen)
- **Keine schwachen Defaults** erlaubt

---

## Autorisierung

### Rollenbasierte Zugriffskontrolle (RBAC)

Das System bietet 60+ granulare Berechtigungen in 18 Kategorien:

| Kategorie | Beispiel-Berechtigungen |
|-----------|------------------------|
| Dashboard | `dashboard.view` |
| Server | `server.start`, `server.stop`, `server.restart` |
| Konsole | `console.view`, `console.execute` |
| Performance | `performance.view` |
| Spieler | `players.view`, `players.kick`, `players.ban` |
| Chat | `chat.view`, `chat.delete` |
| Backups | `backups.create`, `backups.restore`, `backups.delete` |
| Scheduler | `scheduler.view`, `scheduler.edit` |
| Welten | `worlds.view` |
| Mods | `mods.view`, `mods.install`, `mods.delete` |
| Plugins | `plugins.view`, `plugins.install` |
| Konfiguration | `config.view`, `config.edit` |
| Assets | `assets.view`, `assets.manage` |
| Benutzer | `users.view`, `users.create`, `users.delete` |
| Rollen | `roles.view`, `roles.manage` |
| Aktivität | `activity.view`, `activity.clear` |
| Hytale Auth | `hytale_auth.manage` |
| Einstellungen | `settings.view`, `settings.edit` |

### Standard-Rollen

| Rolle | Beschreibung | Berechtigungen |
|-------|--------------|----------------|
| **Administrator** | Vollzugriff | `*` (Wildcard) |
| **Moderator** | Spielerverwaltung | Kick, Ban, Chat |
| **Operator** | Serververwaltung | Server, Backups, Config |
| **Viewer** | Nur Lesen | View-Berechtigungen |

### Selbstschutz

- Benutzer können ihre eigene Rolle nicht ändern
- Benutzer können sich nicht selbst löschen
- System-Rollen können nicht gelöscht werden

---

## Input-Validierung

### Command Injection Prevention

Alle Server-Befehle werden gegen eine Whitelist validiert:

**Erlaubte Befehle (40+):**
```
/kick, /ban, /unban, /whitelist, /tp, /teleport, /give,
/time, /weather, /say, /tell, /msg, /kill, /heal,
/gamemode, /gm, /effect, /clear, /op, /deop, /pardon,
/difficulty, /seed, /list, /stop, /save-all, /save-off,
/save-on, /setblock, /fill, /summon, /spawn, /respawn,
/world, /reload, /broadcast, /bc, /help, /version, /tps
```

**Blockierte Zeichen:**
```
; | & $ ` ( ) { } [ ] < > \
```

**Blockierte Muster:**
```
$(...) ${...} `...`
```

### Path Traversal Prevention

Mehrschichtige Validierung für alle Dateioperation:

```typescript
// 1. Dateiname bereinigen
sanitizeFileName(name)  // Entfernt .., versteckte Dateien

// 2. Pfad validieren
isPathSafe(path, baseDir)  // Prüft ob Pfad innerhalb erlaubter Verzeichnisse

// 3. Symlinks auflösen
getRealPathIfSafe(path, baseDir)  // Folgt Symlinks und validiert
```

### ReDoS Prevention

Reguläre Ausdrücke werden gegen DoS-Angriffe geschützt:

- **Pattern-Längenlimit:** 100 Zeichen
- **Verschachtelte Quantifizierer blockiert:** `(a+)+`, `(a*)*`
- **Quantifizierer-Limit:** 10 pro Pattern
- **Gruppen-Limit:** 5 pro Pattern
- **Backreferences blockiert**

### Typ-spezifische Validierung

| Typ | Validierung |
|-----|-------------|
| Spielername | `[a-zA-Z0-9_-]{1,32}` |
| Item-ID | Namespace-Format |
| Koordinaten | Numerisch, `~` für relativ |
| UUID | `8-4-4-4-12` Hex-Format |
| Gamemode | `creative`, `adventure` |
| Backup-Name | `[a-zA-Z0-9_-]{1,64}` |

---

## Datei-Sicherheit

### Magic Byte Verification

Hochgeladene Dateien werden auf korrektes Format geprüft:

```
ZIP/JAR: PK\x03\x04 (erste 4 Bytes)
```

### Sichere Dateinamen

- **Zufälliges Präfix:** 8 Zeichen Hex via `crypto.randomBytes(4)`
- **Erlaubte Zeichen:** `[a-zA-Z0-9._-]`
- **Maximale Länge:** 100 Zeichen

### Blockierte Dateitypen

```
.exe, .dll, .so, .sh, .bat, .cmd, .ps1, .vbs
```

### Erlaubte Config-Dateien

```
.json, .properties, .yml, .yaml, .toml, .cfg, .conf, .ini
```

---

## HTTP-Sicherheit

### Security Headers (Helmet)

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  frame-ancestors 'none';

X-Frame-Options: DENY
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
```

### CORS-Konfiguration

- **Keine Wildcards:** Origins müssen explizit konfiguriert werden
- **Credentials:** Unterstützt für Same-Origin
- **Erlaubte Methoden:** GET, POST, PUT, DELETE, PATCH, OPTIONS

### CSRF-Schutz

State-ändernde Requests werden gegen konfigurierte Origins validiert:

```typescript
// Origin/Referer muss in CORS_ORIGINS sein
// oder Same-Origin Request
```

### Request Limits

- **JSON Body:** 100KB Maximum
- **Rate Limiting:** Pro Endpunkt konfiguriert
- **Compression:** Aktiviert für Responses

---

## Docker-Sicherheit

### Non-Root Execution

Beide Container laufen als unprivilegierter Benutzer:

```dockerfile
# Manager Container
USER manager (UID 9999)

# Hytale Container
USER hytale (UID 9999)
```

### Capability Dropping

Alle Linux Capabilities werden entfernt, nur benötigte wieder hinzugefügt:

```yaml
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
cap_add:
  - CHOWN
  - SETUID
  - SETGID
  - DAC_OVERRIDE
  - NET_BIND_SERVICE  # Nur Hytale Container
```

### Resource Limits

```yaml
# Hytale Container
deploy:
  resources:
    limits:
      cpus: '4'
      memory: 8G
    reservations:
      cpus: '1'
      memory: 4G

# Manager Container
deploy:
  resources:
    limits:
      cpus: '1'
      memory: 512M
```

### Health Checks

```yaml
# Hytale
healthcheck:
  test: ["CMD", "pgrep", "-f", "java"]
  interval: 60s
  start_period: 180s

# Manager
healthcheck:
  test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/api/health"]
  interval: 30s
```

### Signal Handling

`dumb-init` wird verwendet für korrektes Signal-Handling:

```dockerfile
RUN apk add --no-cache dumb-init
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
```

---

## Audit Logging

### Protokollierte Aktionen

| Kategorie | Aktionen |
|-----------|----------|
| `user` | Login, Logout, Erstellen, Löschen |
| `server` | Start, Stop, Restart |
| `player` | Kick, Ban, Teleport, etc. |
| `backup` | Erstellen, Wiederherstellen, Löschen |
| `config` | Änderungen |
| `mod` | Upload, Aktivieren, Löschen |
| `system` | Fehler, Warnungen |

### Log-Struktur

```json
{
  "id": "1704110400000_a1b2c3",
  "timestamp": "2024-01-01T12:00:00Z",
  "username": "admin",
  "action": "Spieler gekickt",
  "target": "Spieler1",
  "details": "Grund: Regelverstoß",
  "category": "player",
  "success": true
}
```

### Aufbewahrung

- **In-Memory:** 500 neueste Einträge
- **Persistent:** JSON-Datei
- **Rotation:** Älteste Einträge werden entfernt

---

## Fehlerbehandlung

### Production Mode

In Production werden keine Stack-Traces an Clients gesendet:

```typescript
if (process.env.NODE_ENV === 'production') {
  // Generische Fehlermeldung
  res.status(500).json({ error: 'Internal Server Error' });
} else {
  // Detaillierte Fehlermeldung für Entwicklung
  res.status(500).json({ error: err.message, stack: err.stack });
}
```

### Globale Exception Handler

```typescript
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});
```

---

## Best Practices

### Vor dem Deployment

1. **JWT_SECRET generieren:**
   ```bash
   openssl rand -base64 48
   ```

2. **Sicheres Passwort setzen:**
   - Mindestens 12 Zeichen
   - Keine Wörterbuchwörter
   - Groß-/Kleinbuchstaben, Zahlen, Sonderzeichen

3. **CORS konfigurieren:**
   - Nur benötigte Domains
   - Niemals `*` in Production

4. **HTTPS aktivieren:**
   - Reverse Proxy mit TLS
   - `TRUST_PROXY=true` setzen

### Laufender Betrieb

1. **Activity Log überwachen**
2. **Fehlgeschlagene Logins beachten**
3. **Rate Limit Hits prüfen**
4. **Regelmäßige Backups erstellen**
5. **Docker Images aktuell halten**

### Reverse Proxy Setup (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:18080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Bekannte Einschränkungen

| Einschränkung | Grund |
|---------------|-------|
| Docker Socket Zugriff | Erforderlich für Container-Management |
| Synchrone Backups | Verhindert parallele Backup-Korruption |

---

## Sicherheitsmeldungen

Bei Sicherheitsproblemen bitte melden an:
- **GitHub Issues:** [Repository](https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/issues)
- **Discord:** [KyuubiSoft Server](https://dsc.gg/kyuubisoft)

---

## Nächste Schritte

- [[Konfiguration]] - Sicherheitsrelevante Einstellungen
- [[Benutzerverwaltung]] - Berechtigungen richtig setzen
- [[Fehlerbehebung]] - Bei Sicherheitsproblemen
