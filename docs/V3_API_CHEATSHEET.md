# V3 API Cheatsheet

> Alle in [V3_ROADMAP.md](./V3_ROADMAP.md) genannten neuen Endpoints + Datenmodelle in einer Übersicht. Für Entwickler, die schnell wissen wollen: *„Welche Routen muss ich anlegen?"*

---

## Bestand heute (V2.2)

Kurzliste der existierenden Top-Level-Routen — alles unter `/api/`:

```
/api/auth/*           login, refresh, logout, me, ws-ticket, users, hytale/*, sso/* (kommt)
/api/server/*         status, stats, start, stop, restart, quick-settings, config, ...
/api/console/*        legacy console exec
/api/backups/*        CRUD + restore
/api/players/*        list, kick, ban, ...
/api/management/*     worlds, configs, cache
/api/scheduler/*      tasks, backup, restart
/api/assets/*         asset explorer, item icons, player avatars
/api/roles/*          CRUD + permission list
/api/setup/*          status, save step, detect-existing, ...
/api/webmap/*         proxy zu EasyWebMap (intransparent)
/api/health, /api/health/permissions
```

---

## V2.5

### 2FA / TOTP

```
POST /api/auth/2fa/setup                   → { secret, qrDataUrl }            (auth required)
POST /api/auth/2fa/verify-enable           ← { code }                          → activates, returns { backupCodes[] }
POST /api/auth/2fa/disable                 ← { password, code }
POST /api/auth/2fa/regenerate-backup-codes ← { password }                      → { backupCodes[] }

POST /api/auth/login                       ← { username, password, totpCode? }
                                              if 2FA active and totpCode missing → 401 { code: '2FA_REQUIRED' }
```

**`User`-Erweiterung** (`services/users.ts`):
```ts
interface User {
  // ...existing fields
  totpSecret?: string;          // encrypted
  totpEnabled: boolean;
  backupCodeHashes?: string[];  // bcrypt'd, single-use
}
```

### REST-API-Keys

```
GET    /api/auth/api-keys
POST   /api/auth/api-keys             ← { name, scopes[], expiresAt? }   → { id, token: 'kp_<base32>', ... }
                                         token is shown ONCE, never persisted plaintext
DELETE /api/auth/api-keys/:id         → revokes
GET    /api/auth/api-keys/:id/usage   → last 100 audit events for this key
```

**Header:** `Authorization: ApiKey kp_<base32>` (alternative zu Bearer-JWT)

### Audit-Log V2

```
GET /api/audit-log                    ?actor=&action=&from=&to=&limit=50&cursor=
                                       → { events[], nextCursor, total }
GET /api/audit-log/export             ?format=csv|json&filter=… → stream
GET /api/audit-log/actions            → distinct action names (für Filter-UI)
```

**Permission:** `audit.view` (admin-default).

### Command-Palette

Kein dedizierter Endpoint nötig — die Palette indexiert client-seitig. Falls dynamische Daten (Player-Liste, Backups) gesucht werden, nutzt sie die existierenden Listen-Endpoints.

---

## V3.0

### Webhook-Engine

```
GET    /api/webhooks
POST   /api/webhooks                  ← { name, url, type: 'discord'|'slack'|'generic',
                                          events: ['server.started', ...], secret?, enabled: true }
PUT    /api/webhooks/:id              ← partial update
DELETE /api/webhooks/:id
POST   /api/webhooks/:id/test         → posts a synthetic event, returns delivery status
GET    /api/webhooks/:id/deliveries   ?status=&limit=&cursor= → paginated delivery log
POST   /api/webhooks/deliveries/:deliveryId/retry → force-retry a failed delivery
```

**Event-Katalog** (Single Source: `schemas/events.ts`):
```
server.starting | server.started | server.stopping | server.stopped | server.crashed
player.joined  | player.left    | player.banned    | player.kicked  | player.death
backup.started | backup.completed | backup.failed
update.available | update.applied
mod.installed | mod.uninstalled | mod.enabled | mod.disabled
auth.login_success | auth.login_failed | auth.2fa_failed
user.created | user.deleted | role.changed
panel.update_available
```

**Generic-HTTP-Header:**
```
POST <user-supplied URL>
Content-Type: application/json
X-KyuubiSoft-Event: server.started
X-KyuubiSoft-Delivery: <delivery-uuid>
X-KyuubiSoft-Signature: sha256=<hmac of body using webhook.secret>
User-Agent: KyuubiSoft-Panel/2.5.x
```

### File-Manager

```
GET    /api/files/list                ?path=/mods       → { entries: [{name, type, size, mtime, mode}] }
GET    /api/files/read                ?path=/mods/x.json
                                       text/plain bis 5 MB, sonst 413
PUT    /api/files/write               ← { path, content, encoding: 'utf-8'|'base64',
                                          etag?: <mtime from last read> }
POST   /api/files/upload              multipart, query: ?path=…  → { path, size }
DELETE /api/files                     ← { path, confirmToken } (Token aus separatem /confirm)
POST   /api/files/move                ← { from, to }
GET    /api/files/download            ?path=… → stream
```

**Whitelist-Roots** (in `config.ts`):
```ts
fileManagerRoots: [
  { id: 'mods',    path: '/opt/hytale/mods',    rw: true,  permission: 'mods.config' },
  { id: 'plugins', path: '/opt/hytale/plugins', rw: true,  permission: 'plugins.config' },
  { id: 'configs', path: '/opt/hytale/server',  rw: true,  permission: 'config.edit',
    deny: ['config.json'] /* hat eigenen Editor */ },
  { id: 'worlds',  path: '/opt/hytale/data',    rw: false, permission: 'worlds.view' },
]
```

### Notifications-Center

```
GET    /api/me/notifications          ?unreadOnly=&limit=50
POST   /api/me/notifications/:id/read
POST   /api/me/notifications/dismiss-all
GET    /api/me/notifications/preferences
PUT    /api/me/notifications/preferences  ← { [eventName]: { inApp: bool, email: bool, webhook: bool } }
```

**Push-Channel:** über bestehenden Console-WS-Endpoint multiplexen:
```js
ws.send({ type: 'subscribe', channels: ['console.logs', 'notifications'] })
// Server pushes:
{ type: 'notification', payload: { id, title, body, level, link } }
```

### OIDC / SSO

```
GET  /api/auth/sso/providers          → public list of enabled providers (for login page buttons)
GET  /api/auth/sso/:providerId/start  → 302 to OIDC authorization endpoint, sets state cookie
GET  /api/auth/sso/:providerId/callback  ← code + state → JWT issue + refresh cookie like password login
POST /api/me/sso/link                 ← { providerId } (authenticated, initiates link flow)
DELETE /api/me/sso/link/:providerId   → unlinks
```

**`User`-Erweiterung:**
```ts
interface User {
  // ...
  linkedAccounts?: Array<{
    providerId: string;       // 'discord', 'google', ...
    subject: string;          // OIDC `sub` claim
    linkedAt: string;
  }>;
}
```

### Bulk-Aktionen

```
POST /api/players/bulk          ← { ids: ['player-uuid-1', ...], action: 'kick'|'ban'|'unban', params? }
POST /api/backups/bulk          ← { ids: [...], action: 'delete'|'export' }
POST /api/mods/bulk             ← { ids: [...], action: 'enable'|'disable'|'uninstall' }
POST /api/auth/users/bulk       ← { usernames: [...], action: 'delete'|'reset-2fa'|'change-role', params? }
```

Antwort einheitlich:
```ts
{
  results: Array<{ id: string; success: boolean; error?: string }>,
  summary: { total: number; success: number; failed: number }
}
```

---

## V3.1 (Hytale-USPs)

### Live-Player-Map

```
WS    /api/servers/:id/playerlocations/ws    → stream of { timestamp, players: [{name, uuid, x, y, z, world, ping}] }
GET   /api/servers/:id/playerlocations/history  ?from=&to=&playerUuid=
                                              → JSON-Lines stream (für Heatmap-Replay)
```

### Replay-Recorder

```
GET    /api/replay                    ?from=&to=  → list of available replay segments
GET    /api/replay/:segmentId/manifest         → metadata: duration, players, world, file-size
GET    /api/replay/:segmentId/stream          → server-sent events stream of recorded ticks
POST   /api/replay/:segmentId/export          → returns a zip download
DELETE /api/replay/:segmentId
GET    /api/replay/config             → current retention + recording-active flag
PUT    /api/replay/config             ← { recordingEnabled, retentionDays, intervalSeconds }
```

### Auto-Wiki

```
POST /api/wiki/regenerate              → scans mods/, rebuilds /api/wiki output  (permission: 'wiki.manage')
GET  /api/wiki                         → public read-only (configurable: requires-auth toggle)
GET  /api/wiki/:slug                   → single mod page
GET  /api/wiki/config
PUT  /api/wiki/config                  ← { publicAccess: bool, includeOptionalMods: bool }
```

---

## V3.x — Multi-Server

### Server-Management

```
GET    /api/servers                                → list of all ServerInstance
GET    /api/servers/:id
POST   /api/servers                                ← { name, version?, ports?, autoCreatePaths: true }
                                                    → creates Docker container, registers in servers.json
PUT    /api/servers/:id                            ← { name, network?, capabilities? }
DELETE /api/servers/:id                            ← { confirmToken, keepData: bool }
POST   /api/servers/:id/clone                      ← { newName }  → deep-copy data + new container
GET    /api/servers/default                        → returns the ID treated as default (for backward-compat proxy)
PUT    /api/servers/default                        ← { id }
```

### Verlegung aller Server-Routes

| Heute | Nachher | Backward-Compat |
|---|---|---|
| `GET /api/server/status` | `GET /api/servers/:id/status` | `/api/server/*` → 307 redirect zu `/api/servers/<default>/*` |
| `POST /api/server/start` | `POST /api/servers/:id/start` | dito |
| `GET /api/backups` | `GET /api/servers/:id/backups` | dito |
| `GET /api/players` | `GET /api/servers/:id/players` | dito |
| `/api/console/ws?ticket=…` | `/api/servers/:id/console/ws?ticket=…` | alt bleibt, mappt auf default |
| `GET /api/server/config` | `GET /api/servers/:id/config` | dito |

**Implementierung Backward-Compat-Proxy** (in `index.ts`):
```ts
app.use('/api/server', (req, res) => {
  const defaultId = serversService.getDefaultId()
  req.url = `/api/servers/${defaultId}${req.url}`
  app.handle(req, res)
})
```

### Permissions-API

```
GET  /api/auth/users/:username/permissions?serverId=… → effective permission set
PUT  /api/auth/users/:username/server-roles            ← { [serverId]: roleId }
```

---

## Konventionen

- **Auth:** `Authorization: Bearer <jwt>` für Browser, `Authorization: ApiKey kp_<base32>` für Skripte.
- **Cookies:** `kp_refresh` (HttpOnly, SameSite=Strict, Path=/api/auth) — wird von cookie-parser automatisch ausgewertet.
- **Errors:** einheitlich
  ```jsonc
  {
    "error": "Short machine-readable name",
    "detail": "Human-readable explanation",
    "code": "OPTIONAL_ENUM_CODE",      // z.B. 'TOKEN_INVALIDATED', 'USER_DELETED', '2FA_REQUIRED'
    "issues": ["zod issue strings"]    // bei Validation-Errors
  }
  ```
- **Pagination:** cursor-basiert, niemals offset.
  ```
  GET /api/...?limit=50&cursor=<opaque>
  → { items[], nextCursor: string | null }
  ```
- **Rate-Limits:** dokumentiert via `RateLimit-*` Header (`express-rate-limit` macht das schon).
- **Audit-Log:** **jeder** mutierende Endpoint MUSS `audit(req, action, target?, metadata?)` aufrufen.

---

## Datenmodell-Schnellübersicht (neue Stores)

```
/app/data/
├── users.json                # bestehend
├── roles.json                # bestehend
├── api-keys.json             # V2.5
├── audit.sqlite              # V2.5 — auch home für webhooks, deliveries, notifications
│   ├── audit_events
│   ├── webhooks              # V3.0
│   ├── webhook_deliveries    # V3.0
│   ├── notifications         # V3.0
│   └── notification_prefs    # V3.0
├── servers.json              # V3.x
└── replay/                   # V3.1
    └── <uuid>/
        ├── manifest.json
        └── ticks.ndjson.gz
```
