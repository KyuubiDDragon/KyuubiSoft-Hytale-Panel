# V3 API Cheatsheet

> **Stand: Ist-Zustand des Codes** (`manager/backend/src/routes/`, gemountet in `manager/backend/src/index.ts`).
> Was es nicht gibt, steht am Ende unter [Nicht vorhanden](#nicht-vorhanden). Die ursprüngliche Planung steht in [V3_ROADMAP.md](./V3_ROADMAP.md).
> Im Zweifel gilt der Code: Diese Datei ist eine Übersicht, keine Spezifikation.

---

## Top-Level-Routen

Alles unter `/api/`:

```
/api/auth/*           login, refresh, logout, me, ws-ticket, 2fa/*, api-keys, users, hytale/* (Server-Anmeldung), Server-Zugriff (s. u.)
/api/auth/sso/*       providers, :providerId/start, :providerId/callback
/api/server/*         status, stats, start, stop, restart, quick-settings, config, ...   (serverbezogen)
/api/console/*        Konsole, Logs                                                       (serverbezogen)
/api/backups/*        CRUD, Restore, Jobs, native Backups                                 (serverbezogen)
/api/players/*        Liste, Aktionen, Statistik, Strafen, Notizen, bulk                   (serverbezogen)
/api/players/locations   Live-Positionen (REST + WS)                                    (serverbezogen)
/api/management/*     Welten, Mods/Plugins, Configs, Mod-Stores                          (serverbezogen)
/api/scheduler/*      Aufgaben, Backups, Neustarts                                       (serverbezogen)
/api/assets/*         Asset-Explorer, Item-Icons, Spieler-Avatare                          (serverbezogen)
/api/files/*          Datei-Manager                                                      (serverbezogen)
/api/mod-panel/*      Mod-Panels des KyuubiSoft-API-Plugins                               (serverbezogen)
/api/servers/*        Server-Registry (Multi-Server)
/api/roles/*          CRUD + Permission-Liste
/api/webhooks/*       Webhook-Engine
/api/event-actions/*  Event-Aktionen
/api/audit-log/*      Audit-Log
/api/me/notifications/*  Benachrichtigungen
/api/push/*           Web-Push
/api/replay/*         Replay-Recorder                                                    (serverbezogen)
/api/wiki/*           Auto-Wiki                                                          (serverbezogen)
/api/webmap/*         Sitzungen für die eingebettete Karte                               (serverbezogen)
/api/settings/*       Panel-Einstellungen
/api/metrics          Prometheus-Metriken (Recht audit.view oder METRICS_TOKEN)
/api/setup/*          Einrichtungsassistent
/api/public/status    öffentliche Statusseite (abschaltbar)
/api/health           öffentlich
/api/health/permissions  Ordnerrechte (Login, settings.view, Zugriff auf alle Server)
```

**Serverbezogen** heißt: Die Route gibt es zweimal, siehe [Multi-Server](#multi-server).

---

## Auth

### Anmeldung und Sitzung

```
POST /api/auth/login                   ← { username, password, totpCode? }   → Access-Token (JWT) + Refresh-Cookie
POST /api/auth/refresh                 → neues Access-Token (Cookie `kp_refresh`)
POST /api/auth/logout
GET  /api/auth/me                      → eigenes Konto, Rolle, Rechte
```

### 2FA / TOTP

```
POST /api/auth/2fa/setup                   → { secret, otpauthUrl, qrDataUrl }        (eingeloggt)
POST /api/auth/2fa/verify-enable           ← { code }                                  → aktiviert, { backupCodes[] }
POST /api/auth/2fa/disable                 ← { password, code }
POST /api/auth/2fa/regenerate-backup-codes ← { password }                              → { backupCodes[] }
GET  /api/auth/2fa/status                  → { enabled }

POST /api/auth/login                       ← { username, password, totpCode? }
                                              2FA aktiv und totpCode fehlt → 401 { code: '2FA_REQUIRED' }
```

TOTP-Geheimnis und Backup-Code-Hashes liegen in `users.json`. Sie werden über keine API ausgeliefert.

### REST-API-Keys

```
GET    /api/auth/api-keys             → { keys[] }   (eigene Keys; jedes Objekt mit scopes[] und serverIds)
POST   /api/auth/api-keys             ← { name, scopes[], expiresAt? }   → { key, token: 'kp_…' }
                                         token wird EINMAL gezeigt, gespeichert ist nur der bcrypt-Hash
DELETE /api/auth/api-keys/:id         → widerruft
```

Die Scopes sind dieselben Namen wie die Berechtigungen der Rollen (`players.view`, `console.execute`, `console.execute.admin`, …). Verwalten darf Keys, wer `apikeys.manage` hat.

**Header:** `Authorization: ApiKey kp_…` (Alternative zum Bearer-JWT).
Ein Key darf höchstens, was **seine Scopes und die aktuellen Rechte des Owners** gemeinsam erlauben, auf höchstens den Servern, die **Owner und Key** gemeinsam haben (siehe [Server-Zugriff](#server-zugriff-pro-nutzer-und-api-key)).

### WebSocket-Tickets

```
POST /api/auth/ws-ticket              ← { serverId? }   → { ticket, expiresIn: 30, serverId }
```

Einmal-Ticket, 30 s gültig. Bindung:
- Ticket **mit** `serverId` öffnet nur den Socket genau dieses Servers: `/api/servers/:serverId/console/ws`.
- Ticket **ohne** `serverId` öffnet nur die Legacy-Sockets `/api/console/ws` und `/api/players/locations/ws`. Sie gehören zum Default-Server.

Ausgestellt wird nur, wer auf dem Ziel-Server (ohne `serverId`: dem Default-Server) `console.view` oder `players.view` hat; sonst 403 (außerhalb der Server-Liste `SERVER_NOT_ALLOWED`). Ein Ticket, das per API-Key angefordert wurde, trägt dessen Scopes, Server-Liste und ID. Der Socket prüft beim Verbindungsaufbau und bei jedem Heartbeat die Rechte auf dem Server, den er streamt, bei einem Key mit dessen aktuellem Stand. Ein widerrufener Key schließt den Socket. Bei abgeschaltetem Multi-Server öffnet der gescopte Socket nur den Compose-Server (sonst 4004).

### Nutzerverwaltung

```
GET    /api/auth/users                → { users[] }   (users.view; nur öffentliche Felder, inkl. allowedServers)
POST   /api/auth/users                ← { username, password, roleId?, allowedServers? }        (users.create)
PUT    /api/auth/users/:username      ← { password?, roleId? }                                  (users.edit)
DELETE /api/auth/users/:username                                                                (users.delete)
```

Regeln (gegen Rechteausweitung):
- Ein Konto anlegen, sein Passwort oder seine Rolle ändern oder es löschen darf nur, wer **alle Rechte dieses Kontos** selbst hat. Ein Admin-Konto nur ein Admin. Sonst 403 `TARGET_OUTRANKS_YOU`.
- Eine Rolle vergibt nur, wer alle ihre Rechte hat (403 `ROLE_EXCEEDS_YOURS`). Nur bestehende Rollen und nur als ID-String (400 `UNKNOWN_ROLE`).
- Ein neues Konto bekommt höchstens die Server seines Erstellers: dessen Liste oder eine darin enthaltene aus `allowedServers`.
- Maßgeblich sind die Rechte der Anfrage. Bei einem API-Key sind das die Key-Scopes, auch wenn der Owner Admin ist.
- Die eigene Rolle lässt sich nicht ändern, das eigene Konto nicht löschen.

### Rollen

```
GET    /api/roles | /api/roles/:id | /api/roles/permissions                                    (roles.view)
POST   /api/roles                     ← { name, description, permissions[], color? }            (roles.manage)
PUT    /api/roles/:id                 ← { name?, description?, permissions?, color? }           (roles.manage)
DELETE /api/roles/:id                                                                           (roles.manage)
```

Regeln:
- Nur Rechte aus dem Katalog (`/api/roles/permissions`) oder `*`. Sonst 400 `UNKNOWN_PERMISSION` bzw. `INVALID_PERMISSIONS`.
- Niemand vergibt Rechte, die er selbst nicht hat. `*` nur ein Admin. Damit ist auch die eigene Rolle nicht erweiterbar (403 `PERMISSIONS_EXCEED_YOURS`).
- Eine Rolle ändern oder löschen darf nur, wer alle ihre aktuellen Rechte hat (403 `ROLE_EXCEEDS_YOURS`).
- System-Rollen ändert nur ein Admin (403 `SYSTEM_ROLE_PROTECTED`), löschen lassen sie sich nicht. Die Administrator-Rolle behält immer `*`.
- Rollennamen sind ohne Rücksicht auf Groß- und Kleinschreibung eindeutig. Reserviert sind die Legacy-Namen (`Administrator`, `admin`, `Moderator`, `Operator`, `Viewer`; nur die jeweilige System-Rolle darf ihn tragen) und jede Rollen-ID, die eine Rolle oder ein Konto trägt (400).
- Gespeicherte Rollen werden nicht umgeschrieben. Geprüft wird nur, was eine Änderung neu setzt.

---

## Server-Zugriff pro Nutzer und API-Key

Jeder Nutzer kann eine Liste erlaubter Server haben (`allowedServers`), jeder API-Key ebenso (`serverIds`).
- **Fehlt die Liste** (`null`), gelten alle Server.
- Eine Liste **schränkt nur ein**. Rechte vergibt weiterhin die Rolle.
- Admins (`*`) ignorieren ihre eigene Liste. Ein Key mit Liste bleibt auch bei einem Admin-Owner auf seine Liste beschränkt.
- Ein Key ohne Liste folgt seinem Owner.

```
GET /api/auth/me/servers               → { allowedServers: string[] | null, unrestricted }
                                         Server des Aufrufers (Liste des Nutzers, eingeschränkt durch die des Keys)
GET /api/auth/users/:username/servers  → { username, allowedServers: string[] | null, unrestricted }      (users.view)
PUT /api/auth/users/:username/servers  ← { allowedServers: string[] | null }                            (users.edit)
GET /api/auth/api-keys/:id/servers     → { id, serverIds: string[] | null }               (apikeys.manage, eigene Keys)
PUT /api/auth/api-keys/:id/servers     ← { serverIds: string[] | null }                   (apikeys.manage, eigene Keys)
```

**Durchsetzung:**
- Auf jeder serverbezogenen Route, gescopt und Legacy (dort gilt der Default-Server). Außerdem in der Server-Registry, bei WS-Tickets, auf den Konsolen-Sockets und bei Konsolenbefehlen, auch gespeicherten.
- Außerhalb der Liste hat der Aufrufer auf diesem Server **keine** Rechte. Per-Server-Rollen wirken nur innerhalb der Liste.

**Grenzen:**
- Niemand vergibt Server, die er selbst nicht hat.
- Ein Nutzer mit Liste hat die panelweiten Rechte nicht, egal was seine Rolle sagt: `users.view`, `users.create`, `users.edit`, `users.delete`, `roles.manage`, `apikeys.manage.all`, `webhooks.manage`, `settings.edit`, `audit.view`, `audit.export`. Diese Funktionen zeigen oder betreffen alle Server; das ist bewusst grob, bis sie Server kennen. `roles.view`, `webhooks.view`, `settings.view` (Geheimnisse dort maskiert) und eigene Keys bleiben.
- Ein Key mit Liste hat diese Rechte ebenfalls nicht und verwaltet zusätzlich keine Keys.
- Die Server eines Kontos ändert nur, wer alle Rechte dieses Kontos selbst hat.

**Fehlercodes:**

| Status | `code` | Bedeutung |
|---|---|---|
| 403 | `SERVER_NOT_ALLOWED` | Server liegt außerhalb der Liste (Feld `serverId`) |
| 403 | `ALL_SERVERS_REQUIRED` | Aktion verlangt Zugriff auf alle Server |
| 403 | `SERVERS_NOT_HELD` | Es sollen Server vergeben werden, die der Aufrufer nicht hat (Feld `serverIds`, `null` = „alle“) |
| 403 | `TARGET_OUTRANKS_YOU` | Das Zielkonto hat Rechte, die der Aufrufer nicht hat |
| 403 | `TARGET_OUTSIDE_YOUR_SERVERS` | Das Zielkonto reicht über die Server des Aufrufers hinaus |
| 400 | `INVALID_SERVER_LIST` | Feld fehlt oder ist keine Liste von IDs bzw. `null` |
| 400 | `UNKNOWN_SERVER` | ID nicht in der Registry (Feld `serverIds`) |

Weitere Codes der Konten- und Rollenverwaltung: `ROLE_EXCEEDS_YOURS`, `UNKNOWN_ROLE`, `PERMISSIONS_EXCEED_YOURS` (Feld `permissions`), `SYSTEM_ROLE_PROTECTED`, `UNKNOWN_PERMISSION`, `INVALID_PERMISSIONS`; siehe oben.

---

## Audit-Log

```
GET /api/audit-log                    ?actor=&action=&from=&to=&limit=&cursor=  → { events[], nextCursor, … }
GET /api/audit-log/export             ?format=csv|json&actor=&action=&from=&to= → Download
GET /api/audit-log/actions            → verschiedene Aktionsnamen (für Filter)
```

**Permission:** `audit.view` bzw. `audit.export`.

---

## Webhooks und Event-Aktionen

```
GET    /api/webhooks
POST   /api/webhooks                  ← { name, url, type: 'discord'|'slack'|'generic', events[], secret?, enabled?, serverIds? }
                                         serverIds leer/fehlt = Ereignisse aller Server
PUT    /api/webhooks/:id              ← Teilupdate
DELETE /api/webhooks/:id
POST   /api/webhooks/:id/test         → synthetisches Ereignis, liefert den Zustellstatus
GET    /api/webhooks/:id/deliveries   → Zustellprotokoll

GET    /api/event-actions             → { rules[], events[], actionTypes[] }
POST   /api/event-actions             ← { name, serverId|null, eventPattern, actionType, actionPayload, enabled }
PUT    /api/event-actions/:id
DELETE /api/event-actions/:id
POST   /api/event-actions/:id/approve → Befehlsregel als eigene übernehmen
```

`actionType` ist `command`, `announce` oder `backup`. `eventPattern` ist `*`, ein Ereignisname (z. B. `player.joined`) oder `<kategorie>.*`. Befehlsregeln brauchen dieselbe Konsolen-Berechtigung wie der Befehl und laufen später mit den Rechten ihres Erstellers; Regeln, die das Panel deshalb nicht ausführt, haben `blockedReason`.

Webhook-Ziele in privaten Netzen sind gesperrt, solange `ALLOW_INTERNAL_WEBHOOKS` nicht `true` ist.

**Event-Katalog:** `manager/backend/src/schemas/events.ts` (einzige Quelle).

**Generic-HTTP-Header:**
```
X-KyuubiSoft-Event: <event>
X-KyuubiSoft-Delivery: <delivery-id>
X-KyuubiSoft-Signature: sha256=<HMAC des Bodys mit webhook.secret>
```

---

## Datei-Manager

```
GET    /api/files/roots               → freigegebene Wurzeln
GET    /api/files/list                ?rootId=&path=
GET    /api/files/read                ?rootId=&path=
PUT    /api/files/write               ← { rootId, path, content, … }
POST   /api/files/upload              multipart
DELETE /api/files                     ← { rootId, path, confirmToken }
POST   /api/files/move                ← { rootId, from, to }
GET    /api/files/download            ?rootId=&path=
```

Die Wurzeln und ihre Permissions stehen in `manager/backend/src/services/fileManager.ts`.

---

## Benachrichtigungen und Push

```
GET  /api/me/notifications            ?unreadOnly=&limit=
POST /api/me/notifications/:id/read
POST /api/me/notifications/dismiss-all
GET  /api/me/notifications/preferences
PUT  /api/me/notifications/preferences

GET  /api/push/vapid-public-key       → { enabled, key, devices }   (enabled: false, solange Web-Push aus ist)
POST /api/push/subscribe | /unsubscribe | /test
```

Push-Endpunkte werden nur für die Push-Dienste der Browser angenommen; weitere Hosts über `WEB_PUSH_EXTRA_HOSTS`.

---

## OIDC / SSO

```
GET /api/auth/sso/providers               → aktivierte Anbieter (für die Login-Seite)
GET /api/auth/sso/:providerId/start       → 302 zum Anbieter, setzt State-Cookie
GET /api/auth/sso/:providerId/callback    → JWT + Refresh-Cookie wie beim Passwort-Login
```

Umgesetzt ist nur der Typ `discord` (OAuth2). Ein anderer Typ antwortet auf `/start` mit 501. Die Anbieter stehen in `config.json` unter `sso.providers[]` (README, „Erweiterte Funktionen“).

---

## Bulk-Aktionen

```
POST /api/players/bulk          ← { names[], action: 'kick'|'ban'|'unban', reason? }
```

Die Permission wird pro Aktion geprüft (`players.kick` / `players.ban` / `players.unban`), gescopt auch für den jeweiligen Server.

---

## Live-Karte, Replay, Wiki

```
GET /api/players/locations              → letzte Positionen
GET /api/players/locations/history      ?from=&to=&playerUuid=
WS  /api/players/locations/ws?ticket=…  → snapshot + sample-Stream (Default-Server)

POST /api/webmap/session                → { ticket, path, idleTimeoutSeconds, expiresInSeconds }   (players.view)
POST /api/webmap/session/status         ← { ticket }   → { valid, expiresAt } | { valid: false, reason }
POST /api/webmap/session/revoke         ← { ticket }

GET    /api/replay                      → Segmente
GET    /api/replay/config | PUT /api/replay/config
GET    /api/replay/:id/manifest
GET    /api/replay/:id/stream           → Server-Sent Events
POST   /api/replay/:id/export           → { downloadUrl, expiresAt }
GET    /api/replay/download/:token
DELETE /api/replay/:id

GET  /api/wiki | /api/wiki/:slug
GET  /api/wiki/config | PUT /api/wiki/config
POST /api/wiki/regenerate               (wiki.manage)
```

Alle diese Routen gibt es auch unter `/api/servers/:serverId/…` (`players/locations`, `replay`, `wiki`, `webmap`); die Pfade ohne Server-ID arbeiten mit dem Default-Server.

Die Karte selbst wird nicht über die REST-API geladen: `POST /api/webmap/session` liefert einen kurzlebigen, widerrufbaren Ticket-Pfad (`/api/webmap/t/<ticket>/`), unter dem das Panel die Karte des Servers ausliefert. Die Sitzung endet bei Panel-Neustart, nach 12 Stunden oder wenn das Recht `players.view` entfällt.

---

## Multi-Server

Experimentell, hinter `MULTISERVER_ENABLED` (Default aus). Ohne Flag ist über die gescopten Routen nur der Compose-Server erreichbar.

### Server-Registry

```
GET    /api/servers                     → { servers[], defaultId, multiserverEnabled }   (servers.list; nur erlaubte Server)
GET    /api/servers/:id                                                                  (servers.list; nur erlaubte Server)
POST   /api/servers                     ← { name, serverPort?, webMapPort?, webMapWsPort?, autoStart?, limits? }
                                          legt Registry-Eintrag und Container an                (servers.create)
                                          nur mit MULTISERVER_ENABLED (sonst 403 MULTISERVER_DISABLED); fehlende Ports vergibt das Panel.
                                          Kein Feld publishWebMap: die Karte wird veröffentlicht, wenn webMapPort oder
                                          webMapWsPort angegeben ist (die beiden Ports müssen verschieden sein).
                                          image wird nur gelesen, um ein abweichendes Image abzulehnen; das Image bestimmt
                                          das Panel (Primär-Container oder HYTALE_IMAGE).
PUT    /api/servers/:id                 ← { name?, limits? }                                     (servers.manage)
DELETE /api/servers/:id                 ?removeData=true | ?keepContainer=true                     (servers.delete)
                                          removeData verschiebt den Ordner in den Papierkorb
GET    /api/servers/_default            → { defaultId }   (servers.list; Alias: GET /api/servers/default)
PUT    /api/servers/_default            ← { id }          (servers.manage; Alias: PUT /api/servers/default)
POST   /api/servers/_reconcile          → Abgleich Registry ↔ Container                          (servers.manage)
GET    /api/servers/_trash | DELETE /api/servers/_trash/:entry                                    (servers.delete)
```

Die genauen Felder und Fehlercodes stehen in `manager/backend/src/routes/servers.ts`. Mit Server-Liste gilt: `/:id` nur für erlaubte Server (403 `SERVER_NOT_ALLOWED`); Anlegen, Default setzen, Reconcile und Papierkorb nur mit Zugriff auf alle Server (403 `ALL_SERVERS_REQUIRED`).

### Serverbezogene Routen

Jede serverbezogene Ressource ist **zweimal gemountet**:

| Legacy (Default-Server) | Gescopt |
|---|---|
| `/api/server/*` | `/api/servers/:serverId/server/*` |
| `/api/console/*` | `/api/servers/:serverId/console/*` |
| `/api/backups/*` | `/api/servers/:serverId/backups/*` |
| `/api/players/*` | `/api/servers/:serverId/players/*` |
| `/api/management/*` | `/api/servers/:serverId/management/*` |
| `/api/scheduler/*` | `/api/servers/:serverId/scheduler/*` |
| `/api/assets/*` | `/api/servers/:serverId/assets/*` |
| `/api/files/*` | `/api/servers/:serverId/files/*` |
| `/api/mod-panel/*` | `/api/servers/:serverId/mod-panel/*` |
| `/api/replay/*` | `/api/servers/:serverId/replay/*` |
| `/api/wiki/*` | `/api/servers/:serverId/wiki/*` |
| `/api/webmap/*` | `/api/servers/:serverId/webmap/*` |
| `/api/auth/hytale/*` | `/api/servers/:serverId/server/hytale-auth/*` |
| WS `/api/console/ws?ticket=…` | WS `/api/servers/:serverId/console/ws?ticket=…` |

Es gibt **keine** Redirects. Die Legacy-Routen setzen den Default-Server als Ziel. Rechte, Server-Listen und Per-Server-Rollen gelten auf beiden Wegen gleich. Unbekannte Server-ID → 404, Server ohne sichtbare Dateien → 409 `server_files_unavailable`.

### Per-Server-Rollen

Intern kann ein Nutzer pro Server eine zusätzliche Rolle haben (`serverScopes`). Sie **ergänzt** die globale Rolle auf diesem Server, und zwar nur innerhalb von `allowedServers`. Dafür gibt es keine eigenen Endpunkte.

---

## Prometheus-Metriken

```
GET /api/metrics                      → Text im Prometheus-Format
```

Zugriff mit `Authorization: Bearer <JWT>` oder `ApiKey kp_…` bei Recht bzw. Scope `audit.view`, oder mit dem statischen Token aus der Umgebungsvariable `METRICS_TOKEN` (`Authorization: Bearer <METRICS_TOKEN>`, Vergleich in konstanter Zeit). Ohne gesetzten Token bleibt nur der Zugang per Anmeldung.

---

## Nicht vorhanden

Diese Funktionen sind weder umgesetzt noch Teil der Routen und stehen höchstens in [V3_ROADMAP.md](./V3_ROADMAP.md): Klonen eines Servers, eigene Endpunkte für Per-Server-Rollen, Nutzungsstatistik pro API-Key, Sammelaktionen für Backups, Mods und Benutzer, erneutes Senden einer Webhook-Zustellung, Konten-Verknüpfung mit SSO-Anbietern, generisches OIDC (nur Discord) sowie Benachrichtigungskanäle über den Konsolen-WebSocket.

---

## Konventionen

- **Auth:** `Authorization: Bearer <jwt>` für den Browser, `Authorization: ApiKey kp_…` für Skripte.
- **Cookies:** `kp_refresh` (HttpOnly, SameSite=Strict); wird von cookie-parser ausgewertet.
- **Fehler:** JSON mit `error` und/oder `detail`, bei maschinenlesbaren Fällen zusätzlich `code` (z. B. `TOKEN_INVALIDATED`, `USER_DELETED`, `2FA_REQUIRED`, `SERVER_NOT_ALLOWED`, `MULTISERVER_DISABLED`). Fehlende Rechte: 403 `{ error: 'Insufficient permissions', required[] }`.
- **Rate-Limits:** über `RateLimit-*`-Header (`express-rate-limit`).
- **Audit-Log:** mutierende Endpoints rufen `audit(req, action, { target?, metadata? })` auf.

---

## Datenablage (Manager-Volume `/app/data/`)

```
/app/data/
├── users.json          # Konten, Rollen-Zuordnung, 2FA, allowedServers
├── roles.json          # Rollen und Permissions
├── servers.json        # Server-Registry
├── config.json         # Panel-Konfiguration (Setup-Ergebnis, SSO, Web-Push, Discord, …)
├── plugin-tokens.json  # Token je Server für das KyuubiSoft-API-Plugin (Modus 0600, nie über die API)
├── panel.sqlite        # audit_events, api_keys (inkl. server_ids), webhooks, webhook_deliveries,
│                       # notifications, notification_prefs, punishments, event_actions, play_sessions,
│                       # crash_reports, player_notes, push_subscriptions, schema_migrations
└── replay/             # Replay-Segmente
```
