# API Dokumentation

Vollständige REST API Referenz des KyuubiSoft Hytale Panels.

---

## Authentifizierung

Alle API-Endpunkte (außer Login) erfordern einen JWT Bearer Token:

```http
Authorization: Bearer <access_token>
```

### Token erhalten

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "dein-passwort"
}
```

**Antwort:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "abc123...",
  "token_type": "bearer",
  "role": "administrator",
  "permissions": ["*"]
}
```

### Token erneuern

```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refresh_token": "abc123..."
}
```

### Token-Lebensdauer
- **Access Token:** 15 Minuten
- **Refresh Token:** 7 Tage

---

## Rate Limiting

| Endpunkt | Limit |
|----------|-------|
| `/api/auth/login` | 5 Versuche / 15 Min (nur fehlgeschlagene) |
| `/api/auth/refresh` | 10 Anfragen / Minute |
| `/api/auth/ws-ticket` | 30 Anfragen / Minute |
| `/api/assets/item-icon/*` | 100 Anfragen / Minute / IP |

---

## Authentifizierung (`/api/auth`)

### POST /api/auth/login
Login und Token erhalten.

**Request:**
```json
{
  "username": "string",
  "password": "string"
}
```

**Response:** Token-Objekt

---

### POST /api/auth/logout
Token invalidieren (erfordert Auth).

**Response:**
```json
{
  "message": "Logged out successfully"
}
```

---

### POST /api/auth/ws-ticket
WebSocket-Ticket für sichere Verbindung erhalten.

**Berechtigung:** `console.view`

**Response:**
```json
{
  "ticket": "abc123...",
  "expiresIn": 30
}
```

---

### GET /api/auth/me
Aktuellen Benutzer abrufen.

**Response:**
```json
{
  "username": "admin",
  "role": "administrator",
  "permissions": ["*"]
}
```

---

### GET /api/auth/users
Alle Benutzer auflisten.

**Berechtigung:** `users.view`

**Response:**
```json
{
  "users": [
    {
      "username": "admin",
      "roleId": "administrator",
      "created": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

### POST /api/auth/users
Neuen Benutzer erstellen.

**Berechtigung:** `users.create`

**Request:**
```json
{
  "username": "neuerbenutzer",
  "password": "sicherespasswort",
  "roleId": "moderator"
}
```

---

### PUT /api/auth/users/:username
Benutzer aktualisieren.

**Berechtigung:** `users.edit`

**Request:**
```json
{
  "password": "neuespasswort",
  "roleId": "operator"
}
```

---

### DELETE /api/auth/users/:username
Benutzer löschen.

**Berechtigung:** `users.delete`

---

## Server (`/api/server`)

### GET /api/server/status
Serverstatus abrufen.

**Berechtigung:** `server.view_status`

**Response:**
```json
{
  "running": true,
  "status": "online",
  "uptime": 3600
}
```

---

### GET /api/server/stats
Server-Statistiken abrufen.

**Berechtigung:** `server.view_status`

**Response:**
```json
{
  "cpu": 25.5,
  "memory": 2048,
  "players": 5
}
```

---

### GET /api/server/memory
Detaillierte Speicherinformationen.

**Berechtigung:** `performance.view`

**Response:**
```json
{
  "available": true,
  "physical": {
    "total": 16.0,
    "free": 8.5
  },
  "heap": {
    "init": 3.0,
    "used": 2.1,
    "committed": 3.5,
    "max": 4.0
  }
}
```

---

### GET /api/server/quick-settings
Quick Settings abrufen.

**Berechtigung:** `config.view`

**Response:**
```json
{
  "serverName": "Mein Server",
  "motd": "Willkommen!",
  "password": "",
  "maxPlayers": 20,
  "maxViewRadius": 32,
  "defaultGameMode": "adventure"
}
```

---

### PUT /api/server/quick-settings
Quick Settings aktualisieren.

**Berechtigung:** `config.edit`

**Request:**
```json
{
  "serverName": "Neuer Name",
  "maxPlayers": 50
}
```

---

### POST /api/server/start
Server starten.

**Berechtigung:** `server.start`

---

### POST /api/server/stop
Server stoppen.

**Berechtigung:** `server.stop`

---

### POST /api/server/restart
Server neustarten.

**Berechtigung:** `server.restart`

---

## Konsole (`/api/console`)

### GET /api/console/logs
Server-Logs abrufen.

**Berechtigung:** `console.view`

**Query Parameter:**
- `tail` (optional): Anzahl Zeilen (0-10000, Standard: 100)

**Response:**
```json
{
  "logs": [
    {
      "timestamp": "2024-01-01T12:00:00Z",
      "level": "INFO",
      "message": "Server started"
    }
  ],
  "count": 100
}
```

---

### POST /api/console/command
Befehl ausführen.

**Berechtigung:** `console.execute`

**Request:**
```json
{
  "command": "/say Hallo Welt!"
}
```

**Response:**
```json
{
  "success": true,
  "command": "/say Hallo Welt!",
  "output": "Message sent"
}
```

---

## Spieler (`/api/players`)

### GET /api/players
Online-Spieler auflisten.

**Berechtigung:** `players.view`

**Response:**
```json
{
  "players": [
    {
      "name": "Spieler1",
      "uuid": "abc123...",
      "online": true,
      "joinedAt": "2024-01-01T10:00:00Z"
    }
  ],
  "count": 1
}
```

---

### GET /api/players/all
Alle Spieler (online + offline).

**Berechtigung:** `players.view`

---

### GET /api/players/count
Spieleranzahl.

**Berechtigung:** `players.view`

**Response:**
```json
{
  "count": 5
}
```

---

### POST /api/players/:name/kick
Spieler kicken.

**Berechtigung:** `players.kick`

**Request:**
```json
{
  "reason": "Regelverstoß"
}
```

---

### POST /api/players/:name/ban
Spieler bannen.

**Berechtigung:** `players.ban`

**Request:**
```json
{
  "reason": "Cheating"
}
```

---

### DELETE /api/players/:name/ban
Ban aufheben.

**Berechtigung:** `players.unban`

---

### POST /api/players/:name/teleport
Spieler teleportieren.

**Berechtigung:** `players.teleport`

**Zu Koordinaten:**
```json
{
  "x": 100,
  "y": 64,
  "z": -200
}
```

**Zu Spieler:**
```json
{
  "target": "AnderSpieler"
}
```

---

### POST /api/players/:name/gamemode
Spielmodus ändern.

**Berechtigung:** `players.gamemode`

**Request:**
```json
{
  "gamemode": "creative"
}
```

Erlaubte Werte: `creative`, `adventure`, `c`, `a`

---

### POST /api/players/:name/give
Item geben.

**Berechtigung:** `players.give`

**Request:**
```json
{
  "item": "Cobalt_Sword",
  "amount": 1
}
```

---

### POST /api/players/:name/heal
Spieler heilen.

**Berechtigung:** `players.heal`

---

### POST /api/players/:name/effect
Effekt anwenden/entfernen.

**Berechtigung:** `players.effects`

**Request:**
```json
{
  "effect": "speed",
  "action": "apply"
}
```

---

### GET /api/players/:name/deaths
Todespositionen abrufen.

**Berechtigung:** `players.view`

**Response:**
```json
{
  "player": "Spieler1",
  "positions": [
    {
      "world": "world",
      "day": 15,
      "position": {"x": 100, "y": 50, "z": -200}
    }
  ],
  "count": 1
}
```

---

### GET /api/players/chat
Globalen Chat abrufen.

**Berechtigung:** `chat.view`

**Query Parameter:**
- `limit` (optional): Max. Ergebnisse (Standard: 100)
- `offset` (optional): Pagination
- `days` (optional): Tage zurück (Standard: 7, 0 = alle)

---

## Backups (`/api/backups`)

### GET /api/backups
Alle Backups auflisten.

**Berechtigung:** `backups.view`

**Response:**
```json
{
  "backups": [
    {
      "id": "backup_20240101_120000",
      "name": "Manuelles Backup",
      "timestamp": "2024-01-01T12:00:00Z",
      "size": 1048576
    }
  ],
  "storage": {
    "used": 5242880,
    "total": 10737418240,
    "percentage": 0.05
  }
}
```

---

### POST /api/backups
Neues Backup erstellen.

**Berechtigung:** `backups.create`

**Request:**
```json
{
  "name": "Vor dem Update"
}
```

---

### POST /api/backups/:id/restore
Backup wiederherstellen.

**Berechtigung:** `backups.restore`

---

### GET /api/backups/:id/download
Backup herunterladen.

**Berechtigung:** `backups.download`

**Response:** `.tar.gz` Datei

---

### DELETE /api/backups/:id
Backup löschen.

**Berechtigung:** `backups.delete`

---

## Rollen (`/api/roles`)

### GET /api/roles
Alle Rollen auflisten.

**Berechtigung:** `roles.view`

**Response:**
```json
{
  "roles": [
    {
      "id": "administrator",
      "name": "Administrator",
      "description": "Vollzugriff",
      "permissions": ["*"],
      "color": "#FF0000",
      "isSystem": true
    }
  ]
}
```

---

### GET /api/roles/permissions
Verfügbare Berechtigungen auflisten.

**Berechtigung:** `roles.view`

---

### POST /api/roles
Neue Rolle erstellen.

**Berechtigung:** `roles.manage`

**Request:**
```json
{
  "name": "Helper",
  "description": "Hilft Spielern",
  "permissions": ["players.view", "chat.view"],
  "color": "#00FF00"
}
```

---

### PUT /api/roles/:id
Rolle aktualisieren.

**Berechtigung:** `roles.manage`

---

### DELETE /api/roles/:id
Rolle löschen.

**Berechtigung:** `roles.manage`

> **Hinweis:** System-Rollen können nicht gelöscht werden.

---

## Scheduler (`/api/scheduler`)

### GET /api/scheduler/config
Scheduler-Konfiguration abrufen.

**Berechtigung:** `scheduler.view`

---

### PUT /api/scheduler/config
Scheduler-Konfiguration aktualisieren.

**Berechtigung:** `scheduler.edit`

---

### POST /api/scheduler/backup/run
Backup sofort ausführen.

**Berechtigung:** `scheduler.edit`

---

### GET /api/scheduler/quick-commands
Quick Commands auflisten.

**Berechtigung:** `scheduler.view`

---

### POST /api/scheduler/quick-commands
Quick Command erstellen.

**Berechtigung:** `scheduler.edit`

**Request:**
```json
{
  "name": "Tag setzen",
  "command": "/time set day",
  "icon": "sun",
  "category": "Zeit"
}
```

---

### POST /api/scheduler/broadcast
Broadcast an alle Spieler.

**Berechtigung:** `scheduler.edit`

**Request:**
```json
{
  "message": "Server startet in 5 Minuten neu!"
}
```

---

## Assets (`/api/assets`)

### GET /api/assets/status
Asset-Extraktionsstatus.

**Berechtigung:** `assets.view`

---

### POST /api/assets/extract
Assets extrahieren.

**Berechtigung:** `assets.manage`

---

### GET /api/assets/browse
Asset-Verzeichnis durchsuchen.

**Berechtigung:** `assets.view`

**Query Parameter:**
- `path` (optional): Pfad zum Durchsuchen

---

### GET /api/assets/search
Assets durchsuchen.

**Berechtigung:** `assets.view`

**Query Parameter:**
- `q` (erforderlich): Suchbegriff (min. 2 Zeichen)
- `content` (optional): Dateiinhalt durchsuchen
- `ext` (optional): Dateiendungen (`.json,.lua`)
- `limit` (optional): Max. Ergebnisse (Standard: 100)
- `regex` (optional): Regex-Suche
- `glob` (optional): Glob-Pattern

---

### GET /api/assets/item-icon/:itemId
Item-Icon abrufen (öffentlich, rate-limited).

**Response:** PNG-Bild

---

## Health Check

### GET /api/health
Service-Status prüfen.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

---

### GET /api/health/permissions
Verzeichnis-Berechtigungen prüfen.

**Response:**
```json
{
  "status": "ok",
  "directories": {
    "/opt/hytale/data": {"readable": true, "writable": true},
    "/opt/hytale/backups": {"readable": true, "writable": true}
  }
}
```

---

## WebSocket API

### Verbindung herstellen

1. WebSocket-Ticket abrufen:
```http
POST /api/auth/ws-ticket
Authorization: Bearer <token>
```

2. WebSocket verbinden:
```javascript
const ws = new WebSocket('ws://server:3000/ws?ticket=<ticket>');
```

### Nachrichten empfangen

```javascript
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data.type: 'log' | 'status' | 'player_join' | 'player_leave' | etc.
  console.log(data);
};
```

### Befehle senden

```javascript
ws.send(JSON.stringify({
  type: 'command',
  command: '/say Hallo!'
}));
```

---

## Fehlerbehandlung

### HTTP Status Codes

| Code | Bedeutung |
|------|-----------|
| 200 | Erfolg |
| 201 | Erstellt |
| 400 | Ungültige Anfrage |
| 401 | Nicht authentifiziert |
| 403 | Keine Berechtigung |
| 404 | Nicht gefunden |
| 429 | Rate Limit erreicht |
| 500 | Server-Fehler |

### Fehler-Response

```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired token",
  "statusCode": 401
}
```

---

## Nächste Schritte

- [[Sicherheit]] - API-Sicherheit verstehen
- [[Benutzerverwaltung]] - Berechtigungen konfigurieren
