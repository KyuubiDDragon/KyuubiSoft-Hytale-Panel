# Hytale Panel — V3 Roadmap

> **Status:** Konzept-Dokument, Stand 19.05.2026
> **Bezugsbranch:** `claude/system-review-improvements-XIOIT` (Basis V2.2)
> **Zielgruppe:** Maintainer + Contributor, die wissen wollen, **wohin sich das Panel entwickelt und warum**.

---

## Inhalt

1. [Executive Summary](#1-executive-summary)
2. [Wo stehen wir (V2.2)](#2-wo-stehen-wir-v22)
3. [Vision & Release-Linie](#3-vision--release-linie)
4. [V2.5 — „Fühlt sich wie V2.0 an"](#4-v25--fühlt-sich-wie-v20-an)
5. [V3.0 — „Echtes Major"](#5-v30--echtes-major)
6. [V3.1 — Hytale-USPs](#6-v31--hytale-usps)
7. [V3.x — Multi-Server](#7-v3x--multi-server)
8. [Cross-Cutting Concerns](#8-cross-cutting-concerns)
9. [Aufwand, Reihenfolge & Risiken](#9-aufwand-reihenfolge--risiken)
10. [Open Questions](#10-open-questions)

---

## 1) Executive Summary

KyuubiSoft Panel ist heute (V2.2) ein **inhaltlich überdurchschnittliches Hytale-Spezialwerkzeug**: WebMap, Avatar-Inventory-Viewer, Asset Explorer, dreifache Mod-Quellen-Integration (CurseForge + Modtale + StackMart), Live-Console, sauberes Rollen-/Permissions-System, i18n in DE/EN/PT-BR, Demo-Mode. In **Plattform-Hygiene** (2FA, File-Manager, Webhook-Engine, OIDC, PWA, Multi-Server) hinkt es Pelican/Crafty/AMP hinterher.

Dieses Dokument beschreibt drei aufeinander aufbauende Release-Linien, die das schrittweise schließen — ohne die Hytale-DNA aufzugeben.

| Release | Fokus | Zeitfenster | Architektur-Bruch |
|---|---|---|---|
| **V2.5** | „Fühlt sich nach V2.0 an" | ~4 Wochen | nein |
| **V3.0** | Echtes Major-Release | ~8–12 Wochen | nein, additiv |
| **V3.1** | Hytale-USPs (Live-Player-Map, Replay, Auto-Wiki) | ~4–6 Wochen | nein |
| **V3.x** | Multi-Server (eigener Pfad) | +5–8 Wochen, **nach** V3.0 | ja, **backward-kompatibel** |

---

## 2) Wo stehen wir (V2.2)

V2.2 hat in den letzten Sprints (Branch `claude/system-review-improvements-XIOIT`) folgende Härtungen erhalten:

- **Auth:** Natives `bcrypt`, atomar geprüfte WS-Tickets, `tokenVersion` in Access *und* Refresh-Tokens, HttpOnly-Cookie `kp_refresh` (`SameSite=Strict`, `Secure` bei `TRUST_PROXY=true`), zentrale `validatePasswordPolicy()` für API + Setup
- **CSRF:** Origin/Referer-Pflicht für POST/PUT/DELETE/PATCH, Wildcard-CORS muss explizit per `CORS_ALLOW_WILDCARD=true` freigeschaltet werden
- **Backups:** In-Process-Lock + `flock(1)` in `scripts/backup.sh`, externer `backup-hook.sh`-Integrationspunkt (Stub für restic/rclone/borg/s3), `BACKUP_HOOK_PATH=/app/backup-hook.sh` aus dem Manager-Container
- **Plugin-Events:** Zod-Schema-Validierung (`schemas/pluginEvents.ts`), abgelehnte Payloads werden geloggt statt verschluckt
- **Hytale-Adapter:** `services/hytaleAdapter.ts` mit Capability-Matrix (`supportsNativeUpdates`, `supportsServerBrowser`, `configFormat`, `minJavaVersion`), als Schichtgrenze für künftige Transport-Implementierungen
- **Granular Permissions:** `console.execute.admin` für `/op`, `/ban`, `/stop`, `/give`, …
- **Hytale config.json Editor:** `GET/PUT /api/server/config` mit Zod (`schemas/hytaleConfig.ts`), `.bak`-Snapshot, schreibendes In-Process-Lock
- **Adopt-Existing-Install:** `GET /api/setup/detect-existing`, neue Download-Methode `existing`, **nicht-destruktive** Finalize-Logik
- **Hygiene:** 209 MB Binär-Müll aus `git`, `set -o pipefail` in Shell-Scripts, healthcheck-aware `depends_on`, `CAP_NET_BIND_SERVICE` raus

### Bewusst noch offen (Liste aus den V2.2-Audits)

- **Frontend-Modernität:** keine Skeletons, ConfirmDialog hat hartcodierte Strings (`ConfirmDialog.vue:69-72`), Sidebar `w-64` ohne Mobile-Drawer, nur Dark Mode, nur 5 Dateien mit *einem* `aria-*` Attribut, `Mods.vue` ist 3164 Zeilen, `management.ts` 3604 Zeilen, `server.ts` 2056 Zeilen
- **DX:** keine Tests, keine `.github/workflows/`, keine ESLint/Prettier/Husky, ~513 unstrukturierte `console.log/error`
- **Type-Sharing Backend↔Frontend:** doppelt definiert, kein OpenAPI/tRPC
- **Architektur:** Single-Server hartverdrahtet in 40+ Dateien
- **Sicherheits-/Standard-Features fehlen:** 2FA, REST-API-Keys, Webhook-Engine, OIDC, File-Manager mit Editor, Notifications-Center
- **Hytale-Pflicht:** i18n des Adopt-Existing-Banners (nur Englisch), `config.json.bak` ist Single-Snapshot

---

## 3) Vision & Release-Linie

### Leitsatz
> *Pelican-Plattform-Standards einholen, ohne die Hytale-Tiefe zu opfern — und dann mit Live-Player-Map, Replay und Auto-Wiki einen klaren Lead in Hytale-spezifischen Wow-Features setzen.*

### Release-Grafik

```
V2.2 (heute)
   │
   ├─→ V2.5 (4 W)       Sicherheit + UX-Sprung
   │      • 2FA, API-Keys, Audit-Log V2
   │      • Command-Palette, PWA, Mobile, Light Mode
   │      • CI/Lint/Format, Mega-Files aufgeteilt
   │
   ├─→ V3.0 (8-12 W)    Plattform-Standards
   │      • Webhook-Engine
   │      • File-Manager mit Monaco
   │      • Notifications-Center
   │      • OIDC/SSO (Discord first)
   │      • Bulk-Aktionen, Loading/Empty/Error-Konsistenz
   │
   ├─→ V3.1 (4-6 W)     Hytale-Differenzierung
   │      • Live-Player-Map mit Ping-Heatmap
   │      • Replay-Recorder MVP
   │      • Auto-Wiki (Mod-Scan → Player-Doku)
   │
   └─→ V3.x (5-8 W)     Multi-Server (eigener Pfad, optional parallel zu V3.1)
          • servers.json, Server-Scope, Server-Picker
          • Hybrid-Permissions (global + per-Server)
          • Backward-kompatibler Migrationspfad
```

---

## 4) V2.5 — „Fühlt sich wie V2.0 an"

Ziel: Das Panel **sieht und fühlt sich** wie ein anderes Tool an, **ohne** Architektur-Bruch.

### 4.1 2FA / TOTP

**Warum:** Plattform-Standard 2026. Pelican, Crafty, AMP haben es alle.

**Aufwand:** S (2–3 Tage)

**Umsetzung:**
- `npm i otplib qrcode` im Backend.
- `users.ts`: `User.totpSecret?: string`, `User.totpEnabled: boolean`.
- Neue Endpoints:
  ```
  POST /api/auth/2fa/setup           → liefert { secret, qrDataUrl } (noch nicht aktiv)
  POST /api/auth/2fa/verify-enable   → { code } aktiviert 2FA nach erfolgreichem Probe-Code
  POST /api/auth/2fa/disable         → { password, code } deaktiviert
  POST /api/auth/login               → { username, password, totpCode? } — bei aktiviertem 2FA Pflicht
  ```
- Backup-Codes: 10 single-use Codes bei Aktivierung, gehasht in `users.json` gespeichert.
- Pinia-Store `auth` bekommt `requires2fa: boolean`, Login-View zeigt TOTP-Eingabe nach Passwort-Step.
- Rate-Limit für `/verify-enable`: 5 Versuche/Minute.

**Migration:** `tokenVersion`-Bump optional. Bestehende User behalten Zugang ohne 2FA, können es im Settings-View aktivieren.

### 4.2 REST-API-Keys mit Scopes

**Warum:** Voraussetzung für Webhook-Engine (V3.0), CI-Integrationen, externe Monitoring-Tools. JWT-Cookie-Flow ist für Browser, nicht für Skripte.

**Aufwand:** S (2 Tage)

**Datenmodell** (`data/api-keys.json`):
```ts
interface ApiKey {
  id: string;             // uuid
  ownerUsername: string;
  name: string;           // "Grafana Scraper"
  scopes: string[];       // ["server.view_status", "performance.view"]
  hashedToken: string;    // bcrypt(token)
  prefix: string;         // erste 8 Zeichen des Tokens, anzeigbar im UI
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;     // optional
  revokedAt?: string;
}
```

**Endpoints:**
```
GET    /api/auth/api-keys              (listet eigene Keys ohne Token)
POST   /api/auth/api-keys              (erstellt Key, gibt Token EINMAL zurück)
DELETE /api/auth/api-keys/:id          (revoke)
```

**Middleware:** `authMiddleware` erkennt `Authorization: ApiKey kp_<base32>` zusätzlich zu JWT-Bearer. Bei API-Key wird `req.user` + `req.scopes` gesetzt. `requirePermission()` prüft erst Scope (falls API-Key), sonst Role-Permissions.

### 4.3 Audit-Log V2

**Warum:** Aktueller `services/activityLog.ts` ist in-memory + JSON-Snapshot, nur in 3 Routen referenziert. Für Compliance, Forensik, Multi-User-Trust ungeeignet.

**Aufwand:** M (3–4 Tage)

**Umsetzung:**
- SQLite (`better-sqlite3`) als Persistenz unter `/app/data/audit.sqlite`. Kein Server, keine externen Dependencies, transaktional.
- Schema:
  ```sql
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,              -- ISO timestamp
    actor_username TEXT NOT NULL,
    actor_type TEXT NOT NULL,      -- 'user' | 'api_key' | 'scheduler'
    action TEXT NOT NULL,          -- 'server.start', 'user.created', 'mod.installed'
    target TEXT,                   -- 'user:bob', 'mod:KyuubiAPI', 'backup:hytale_manual_xxx'
    ip TEXT,
    user_agent TEXT,
    metadata TEXT,                 -- JSON
    success INTEGER NOT NULL       -- 0/1
  );
  CREATE INDEX idx_audit_ts ON audit_events(ts DESC);
  CREATE INDEX idx_audit_actor ON audit_events(actor_username);
  CREATE INDEX idx_audit_action ON audit_events(action);
  ```
- `audit(req, action, target?, metadata?)` Helper, ruft `req.user`, `req.ip`, `req.get('user-agent')` ab. **In jeder Route**, die etwas verändert (Auth, Backup, Server-Start/Stop, User-CRUD, Role-CRUD, Mod-Install).
- Endpoints:
  ```
  GET /api/audit-log?actor=&action=&from=&to=&limit=&cursor=    (paginiert)
  GET /api/audit-log/export?format=csv|json&filter=…            (Stream-Download)
  ```
- Retention-Policy: `AUDIT_RETENTION_DAYS=180` (env), nightly cron prunt ältere Einträge.

**Frontend:** Erweitere `views/ActivityLog.vue` — Filter-Bar (Actor, Action-Typ, Datum-Range), Export-Button, sortierbare Tabelle.

### 4.4 Command-Palette (Cmd+K)

**Warum:** Der größte UX-Sprung pro Aufwands-Stunde. Linear, Vercel, Notion — alle haben es. Pelican (noch) nicht.

**Aufwand:** S (1–2 Tage)

**Umsetzung:**
- Neue Komponente `components/ui/CommandPalette.vue` mit Listener für `Cmd+K` / `Ctrl+K` global in `App.vue`.
- Index aus drei Quellen:
  1. **Views** — alle Routen aus `main.ts`, mit i18n-Titel
  2. **Quick-Actions** — Start Server, Stop Server, Create Backup, Open Console, Run Update Check, Toggle Theme
  3. **Live-Daten** — Online-Player (kick/ban), Backups (restore/delete), Mods (toggle), Users (edit)
- Fuzzy-Search: `fuse.js` (lightweight, schon vom React-Ökosystem bekannt).
- Footer zeigt Shortcuts: `↑↓` navigieren, `↵` ausführen, `⌘+Enter` in neuem Tab.

**Visualisierung:**
```
┌─────────────────────────────────────────────────────┐
│ 🔍 Search anything...                          ⌘K  │
├─────────────────────────────────────────────────────┤
│ ▶ Start Server                  Quick Action       │
│   Restart Server                Quick Action       │
│   Create Backup                 Quick Action       │
│ ─────────────────────────────────────────────────── │
│   Dashboard                     View               │
│   Console                       View               │
│   Players → kick "bob"          Player Action      │
│ ─────────────────────────────────────────────────── │
│ ↑↓ navigate  ↵ select  esc close                   │
└─────────────────────────────────────────────────────┘
```

### 4.5 PWA + Mobile-Drawer + Touch-Targets

**Warum:** Heute auf einem iPhone unbenutzbar (`Sidebar.vue:72` ist `w-64` fix).

**Aufwand:** S (2 Tage)

**Umsetzung:**
- **PWA-Manifest** (`public/manifest.webmanifest`): Name, Icons (192/512), `display: standalone`, `theme_color` aus Tailwind-Tokens.
- **Service-Worker** via `vite-plugin-pwa` (Workbox-basiert): Precache statischer Assets, NetworkFirst für `/api/*`, Offline-Fallback-Page „Server unreachable".
- **Mobile-Drawer:** `Sidebar.vue` wird zu Headless-Drawer-Pattern (z.B. via `@vueuse/components/useScrollLock`). Hamburger-Toggle im Header, Backdrop-Click schließt, ESC schließt, Body-Scroll-Lock auf Mobile.
- **Touch-Targets:** Alle Buttons mind. `min-h-11 min-w-11`.

### 4.6 Light Mode + CSS-Custom-Properties

**Warum:** Heute keine Theme-Variable, Tailwind hat `darkMode` nicht gesetzt → Light Mode prinzipiell nicht möglich.

**Aufwand:** S (1–2 Tage)

**Umsetzung:**
- `tailwind.config.js`: `darkMode: 'class'`.
- `App.vue` setzt `<html class="dark">` standardmäßig (Backward-Compat).
- CSS-Custom-Properties in `assets/main.css`:
  ```css
  :root {
    --color-bg: 250 250 250;
    --color-bg-elevated: 255 255 255;
    --color-text: 15 15 15;
    /* ... */
  }
  .dark {
    --color-bg: 26 29 35;
    --color-bg-elevated: 40 45 54;
    --color-text: 245 245 245;
    /* ... */
  }
  ```
- Tailwind-Colors über `rgb(var(--color-bg) / <alpha-value>)` Pattern.
- Theme-Toggle in Header, Speicher in `localStorage.theme` mit `prefers-color-scheme`-Fallback.

### 4.7 CI / Lint / Format / Husky / Docs

**Warum:** Heute sind PRs ohne jede automatische Gatekeeping-Phase, neuer Contributor braucht 1–2 Tage Onboarding.

**Aufwand:** S (1 Tag)

**Liefergegenstände:**
- `.github/workflows/ci.yml`:
  ```yaml
  jobs:
    backend:
      - npm ci (in manager/backend)
      - npx tsc --noEmit
      - npm test (sobald vorhanden)
    frontend:
      - npm ci (in manager/frontend)
      - npx vue-tsc --noEmit   # blocker falls aktuelle TS-Version inkompatibel
      - npx vite build
    docker-build:
      - docker buildx build --platform linux/amd64 .
      - docker buildx build --platform linux/amd64 ./manager
    backup-hook-sync:
      - diff scripts/backup-hook.sh manager/backup-hook.sh
  ```
- ESLint (`@typescript-eslint`, `eslint-plugin-vue`), Prettier, `simple-git-hooks` für `pre-commit` (`tsc --noEmit` + `eslint --fix`).
- `CONTRIBUTING.md`: Setup-Anleitung, Branch-Naming (`feat/`, `fix/`, `chore/`), Commit-Konvention (Conventional Commits), wie PRs entstehen.
- `ARCHITECTURE.md`: Komponenten-Diagramm Manager↔Hytale↔Plugin↔Frontend, Datenflüsse, wichtige Pfade.

### 4.8 Mega-Files aufteilen

**Warum:** `Mods.vue` 3164 Z., `management.ts` 3604 Z., `server.ts` 2056 Z. — niemand wartet das gerne.

**Aufwand:** M (3–5 Tage)

**Ansatz:**
- `Mods.vue` → `views/Mods.vue` (Container, ~300 Z.) + `components/mods/ModsList.vue`, `ModsStore.vue`, `ModsFilter.vue`, `ModUpdateDialog.vue`, `ChangelogModal.vue`.
- `routes/management.ts` → `routes/management/index.ts` + Sub-Files pro Resource (`worlds.ts`, `configs.ts`, `cache.ts`, …).
- `routes/server.ts` → `routes/server/{lifecycle,config,stats,updates}.ts`.
- Pro Sub-Modul ein kleiner Express-Router, gemounted unter der bisherigen URL → keine Frontend-Änderung nötig.

---

## 5) V3.0 — „Echtes Major"

Ziel: Pelican/Crafty/AMP-Standards an Stellen einholen, an denen die fehlen.

### 5.1 Webhook-Engine

**Warum:** Discord-Webhook-URL existiert nur als Setup-Feld (`api/setup.ts:135-136`) ohne Dispatch-Pipeline. Pelican/Crafty haben echte Event-Engines.

**Aufwand:** M (1 Woche)

**Architektur:**

```
┌──────────────────────────────────────────────────────────────┐
│                    Event-Produzenten                          │
│  Docker-Status • Plugin-WS (Chat/Death) • Scheduler • Backup │
└────────────────────────┬─────────────────────────────────────┘
                         │ EventBus.publish(name, payload)
                         ▼
              ┌────────────────────────┐
              │  EventBus (in-process) │  Zod-validated events
              └─────┬──────────┬───────┘
                    │          │
        ┌───────────▼───┐   ┌──▼────────────┐
        │ AuditLog-Sink │   │ Webhook-Sink  │
        └───────────────┘   └──┬────────────┘
                               │ Match Subscriptions
                               ▼
                    ┌──────────────────┐
                    │ Delivery-Queue   │ persistent, retry mit
                    │ (SQLite-backed)  │ exponential backoff
                    └────────┬─────────┘
                             │
                  ┌──────────┼──────────┐
                  ▼          ▼          ▼
              Discord     Slack     Generic-HTTP
```

**Datenmodell** (`audit.sqlite`, zwei zusätzliche Tabellen):
```sql
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'discord' | 'slack' | 'generic'
  events TEXT NOT NULL,         -- JSON array: ['server.started', 'player.joined', ...]
  secret TEXT,                  -- HMAC-SHA256 für 'generic'
  enabled INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  next_retry_at TEXT,
  status TEXT NOT NULL,         -- 'pending' | 'success' | 'failed' | 'gave_up'
  response_code INTEGER,
  response_body_truncated TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

**Event-Katalog** (alle definiert in `schemas/events.ts` mit Zod, exhaustiv):
- `server.starting`, `server.started`, `server.stopping`, `server.stopped`, `server.crashed`
- `player.joined`, `player.left`, `player.banned`, `player.kicked`, `player.death`
- `backup.started`, `backup.completed`, `backup.failed`
- `update.available`, `update.applied`
- `mod.installed`, `mod.uninstalled`, `mod.enabled`, `mod.disabled`
- `auth.login_success`, `auth.login_failed`, `auth.2fa_failed`, `user.created`, `user.deleted`, `role.changed`
- `panel.update_available`

**Dispatch:** `services/webhookDispatcher.ts` — Cron läuft jede Sekunde, holt fällige Deliveries, sendet via `fetch` mit 10s-Timeout, Backoff `30s, 5min, 30min, 6h`, max 5 Versuche, dann `gave_up`. HMAC-Header `X-KyuubiSoft-Signature: sha256=…` für `generic`.

**Discord-/Slack-Formatter:** Vorgefertigte Embed-Templates pro Event-Typ (Farben, Icon, „Server running on host X" Footer).

**Endpoints:**
```
GET    /api/webhooks
POST   /api/webhooks               { name, url, type, events[], secret? }
PUT    /api/webhooks/:id
DELETE /api/webhooks/:id
POST   /api/webhooks/:id/test      → sendet ein synthetisches Event
GET    /api/webhooks/:id/deliveries?status=&limit=&cursor=
```

### 5.2 File-Manager mit Monaco-Editor

**Warum:** Das einzige Feature, das **alle drei** großen Panels haben und KyuubiSoft komplett fehlt. Heute hat das Panel nur `views/Assets.vue` (read-only Asset-Explorer) und `views/Configuration.vue` für Configs.

**Aufwand:** L (1,5–2 Wochen)

**Scope:** Browser-Datei-Manager für `/opt/hytale/server`, `/opt/hytale/plugins`, `/opt/hytale/mods`, `/opt/hytale/data` (Welten read-only, alles andere R/W außer expliziter Deny-List).

**Sicherheits-Boundary:**
- Whitelist erlaubter Root-Pfade in `config.ts`.
- Pro Request: `path.resolve(root, requested)` + `path.relative(root, resolved).startsWith('..')`-Check.
- Deny-Patterns: `.env`, `*.key`, `users.json`, `audit.sqlite`, `config.json` (für Letzteres existiert bereits dedizierter Editor mit Schema-Validation).
- Datei-Größenlimit beim Lesen: 5 MB (UI-side). Größere Files: nur Download/Streaming.
- Schreibrate: `express-rate-limit`, 30 Writes/Minute pro User.

**Endpoints:**
```
GET    /api/files/list?path=…              → { entries: [{name, type, size, mtime, mode}] }
GET    /api/files/read?path=…              → text/plain oder application/octet-stream
PUT    /api/files/write                    body: { path, content, encoding } — Lock pro Path
POST   /api/files/upload  multipart        → Multer + path-traversal-Check
DELETE /api/files                          body: { path } — mit Bestätigungs-Token
POST   /api/files/move                     body: { from, to }
POST   /api/files/chmod                    body: { path, mode }   (optional, später)
GET    /api/files/download?path=…          → Stream
```

**Frontend:**
- Neue View `views/Files.vue` mit zweispaltigem Layout: Tree links, Editor/Preview rechts.
- Monaco via `@monaco-editor/loader` (lazy-import, sonst geht der Bundle hoch). Sprach-Detection per Extension (`.json` → json, `.yml` → yaml, `.lua`/`.js` → javascript, Hytale-Plugin-`manifest.json` mit JSON-Schema).
- Save: Cmd+S, Diff-Indicator vor Save, Konflikt-Erkennung über `ETag` (mtime).
- Upload via Drag&Drop.

### 5.3 Notifications-Center

**Warum:** Heute keine zentrale Stelle, an der ein User „kümmer dich darum"-Items sieht.

**Aufwand:** M (5 Tage)

**Konzept:**
- In-App-Stream (Bell-Icon im Header mit Badge): persistente Items wie „Backup fehlgeschlagen", „Plugin-Update verfügbar", „User X wurde gebannt".
- User-Preferences (`/api/me/notifications/preferences`): pro Event-Typ ankreuzbar, welche Kanäle (in-app, e-mail, webhook).
- Webhook-Engine (5.1) hängt sich automatisch ein, wenn User-Pref `webhook = true`.
- E-Mail-Versand optional via `nodemailer` + SMTP-Config (in `config.json.email`).

**Datenmodell:**
```sql
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_username TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  level TEXT NOT NULL,           -- 'info' | 'warning' | 'error' | 'success'
  link TEXT,                     -- target URL inside the panel
  created_at TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT
);
```

**Endpoints:**
```
GET    /api/me/notifications?unreadOnly=
POST   /api/me/notifications/:id/read
POST   /api/me/notifications/dismiss-all
GET    /api/me/notifications/preferences
PUT    /api/me/notifications/preferences
```

**Frontend:** Bell-Icon mit `ws://`-Push (am bestehenden Console-WS-Channel multiplexen via `{type: 'notification', payload}`).

### 5.4 OIDC/SSO — Discord first

**Warum:** Community-Anker (`dsc.gg/kyuubisoft`) → Discord-Login ist der natürliche erste SSO. Generischer OIDC-Layer ist Pflicht-Standard.

**Aufwand:** M (5–6 Tage)

**Umsetzung:**
- `openid-client` als generischer OIDC-Client.
- Discord ist *technisch* kein OIDC sondern OAuth2 mit `/users/@me` als Identity-Endpoint — separater Discord-Adapter mit gleichem Interface wie der OIDC-Adapter.
- Konfig in `config.json`:
  ```jsonc
  {
    "sso": {
      "enabled": true,
      "providers": [
        {
          "id": "discord",
          "type": "discord",
          "clientId": "…",
          "clientSecret": "…",
          "allowedGuildIds": ["…"],       // optional gating
          "defaultRoleId": "viewer",
          "autoCreate": true
        }
      ]
    }
  }
  ```
- Flow: `/api/auth/sso/discord/start` → 302 zu Discord-OAuth → callback `/api/auth/sso/discord/callback` → User-Lookup oder Auto-Create → JWT-Issue + Refresh-Cookie wie bei Passwort-Login.
- Account-Linking: bestehender User kann via Settings „Mit Discord verbinden" eine `User.linkedAccounts` Liste pflegen.

### 5.5 Bulk-Aktionen + State-Konsistenz

**Warum:** Players, Backups, Mods, Users werden heute einzeln verwaltet. Standard 2026 ist Multi-Select.

**Aufwand:** S–M (3 Tage)

**Pattern:**
- Tabellen bekommen Checkbox-Spalte (über alle Items + Header-Select-All).
- Sticky Bottom-Bar erscheint bei `selectedItems.size > 0`: „N selected — Kick all / Ban all / Cancel".
- Backend: Endpoints `POST /api/players/bulk` `{ ids, action, params }` etc., mit Transaktion + Audit-Log pro Sub-Item.
- Optimistic Updates via Pinia-Mutation + Rollback bei Fehler.

**Parallel:** Audit aller Views auf konsistente Loading/Empty/Error-States — `components/ui/Skeleton.vue`, `components/ui/EmptyState.vue` mit Icon + CTA, `components/ui/ErrorState.vue` mit Retry-Button als Standard-Slot in `Card.vue`.

---

## 6) V3.1 — Hytale-USPs

Ziel: Hier zieht das Panel davon. Keiner der Konkurrenten ist Hytale-nativ.

### 6.1 Live-Player-Map mit Ping-Heatmap

**Aufwand:** M (1 Woche)

- Aufsetzend auf bestehender `WebMap.vue` (EasyWebMap-Integration).
- KyuubiSoft-Plugin liefert pro Tick `{playerName, x, y, z, world, latencyMs}` über bestehenden Plugin-WS.
- Frontend rendert Overlay-Pins mit Farbcode (grün <50ms, gelb <120ms, rot ≥120ms), Heatmap-Layer (Leaflet `heatmap.js` Plugin) optional.
- Replay-Buffer 10 Minuten — Time-Slider zum „spulen".

### 6.2 Replay-Recorder MVP

**Aufwand:** L (1,5 Wochen)

- Plugin-Erweiterung speichert pro 5s einen Snapshot (`worldName, players[], chat[], events[]`) als Newline-delimited-JSON.
- Manager rotiert Files alle 24h, max. 7 Tage Retention default.
- Replay-View: Time-Slider, Play/Pause, 2×/5×-Speed. Kein 3D-Render — nur Map-Overlay + Chat-Replay + Event-Liste.
- Export: einzelnes Replay als `.zip` herunterladbar.

### 6.3 Auto-Wiki

**Aufwand:** M (1 Woche)

- Scan `mods/`-Verzeichnis, lese `manifest.json` jedes Mods, gruppiere nach Kategorie.
- Generiere statische Markdown-Seite mit Beschreibung, Befehlsliste (falls Mod sie deklariert), Konfig-Optionen, Screenshots-Slot.
- Publishe optional unter `https://<panel>/wiki/` ohne Auth (read-only) — Server-Owner kann via Settings-Toggle aktivieren.

---

## 7) V3.x — Multi-Server

> **Pfad-Entscheidung:** dieser Schritt kommt **nach** V3.0, weil V3.0 die Plattform-Hygiene-Lücken schließt, die für Multi-Server ohnehin Voraussetzung sind (API-Keys, Webhooks, Audit-Log, Notifications). Multi-Server ist additiv und backward-kompatibel.

### 7.1 Architektur-Entscheidung

Vier Optionen wurden geprüft:

| Option | Modell | Eignung | Aufwand |
|---|---|---|---|
| A | **Single-Manager + mehrere lokale Container** mit `servers.json` | ✅ passt, lokal, schnell | M–L |
| B | Pelican-Style Wings-Daemon pro Node | overkill für Hytale-Docker-Welt | XL |
| C | Hybrid lokal + Remote-Daemon | später möglich | XL |
| D | **Multi-Instance-on-one-Host** als Lite (nur Container, kein Daten-Refactor) | zu eingeschränkt | S |

**Empfehlung:** Option A — Crafty-4-Pattern. Lokal bleiben, datengesteuertes Routing, später optional zu C ausbauen.

### 7.2 Datenmodell

`/app/data/servers.json` (manager-data-Volume):

```ts
interface ServerInstance {
  id: string;                  // uuid
  name: string;                // "Survival #1"
  containerName: string;       // "hytale-srv-aaa1" (created via dockerode)
  status: 'ready' | 'creating' | 'broken';
  network: {
    serverPort: number;        // 5520, 5521, ...
    webMapPort: number;
    webMapWsPort: number;
    pluginPort: number;        // KyuubiSoftAPI: 18085 + offset
  };
  paths: {
    server: string;            // /opt/hytale-instances/<id>/server
    data: string;
    backups: string;
    mods: string;
    plugins: string;
    assets: string;
    auth: string;
  };
  capabilities?: HytaleCapabilities;  // gefüllt durch hytaleAdapter
  createdAt: string;
  createdBy: string;
}

interface ServersFile {
  schemaVersion: 1;
  servers: ServerInstance[];
}
```

### 7.3 Backend-Routing-Refactor

**Heute:** `/api/server/status`, `/api/console/...`, `/api/backups`, `/api/players/...`

**Nachher:** `/api/servers/:id/status`, `/api/servers/:id/console/ws`, `/api/servers/:id/backups`, …

**Backward-Compat (kritisch):** Alle alten `/api/server/...`-Routen bleiben als **Proxy** auf `/api/servers/:defaultId/...`, wobei `defaultId` der erste Server in `servers.json` ist. Aliasing über `app.use('/api/server', proxyToDefaultServer)`.

**Service-Layer:**
- Alle Services bekommen `serverId` als ersten Parameter.
- `services/docker.ts`: `getContainer(serverId)`, `getStats(serverId)`, …
- `services/scheduler.ts`: Tasks haben `serverId`-Feld, Cron-Engine läuft weiter zentral, dispatcht pro Server.
- `services/backup.ts`: Path-Resolution geht über `serversService.get(serverId).paths.backups`.
- `services/kyuubiApi.ts`: `getPluginHost(serverId)`, `PLUGIN_PORT` aus `instance.network.pluginPort`.
- `services/hytaleAdapter.ts`: `HytaleAPIFactory.get(serverId)` cached pro Server.

### 7.4 Permissions: hybrid

```ts
interface User {
  username: string;
  passwordHash: string;
  roleId: string;            // **globale Rolle** (z.B. 'admin', 'support')
  serverScopes: {
    [serverId: string]: {
      roleId: string;        // **per-server Rolle** (z.B. 'operator' nur auf Server X)
    };
  };
  // ... bestehende Felder (tokenVersion, 2FA, ...)
}
```

`hasPermission(user, permission, serverId?)`:
- Wenn `serverId` gesetzt:
  - Erst `user.serverScopes[serverId].roleId` → Permission-Check
  - Sonst Fallback auf `user.roleId`
- Wenn `serverId === undefined`: nur globale Rolle.
- `*`-Wildcard auf globaler Rolle umgeht den Scope-Check (Super-Admin).

### 7.5 Frontend-Server-Context

**Pinia-Store `useServerStore`:**
```ts
export const useServerStore = defineStore('servers', () => {
  const servers = ref<ServerInstance[]>([])
  const activeServerId = ref<string | null>(localStorage.getItem('activeServer'))
  const activeServer = computed(() => servers.value.find(s => s.id === activeServerId.value))

  function setActive(id: string) { … }
  async function refresh() { … }
  async function create(spec: CreateServerSpec) { … }
  async function remove(id: string) { … }
})
```

**Router:** Top-Level-Param `:serverId`:
```
/servers/:serverId/dashboard
/servers/:serverId/console
/servers/:serverId/players
…
```

Mit Router-Guard, der `activeServerId` synchron zur URL hält.

**Header:** Server-Picker links neben Logo (Dropdown). Im Picker: aktive Status-Indikatoren („● online", „○ stopped"), „+ Add Server" am Bodenrand.

**Sidebar:** Bestehende Items bleiben, aber URL-Prefix wird dynamisch.

### 7.6 Migrations-Strategie (Backward-Compat)

**Erster Start nach V3.x-Upgrade:**

1. `migrations/v3-multiserver.ts` läuft beim Boot, prüft, ob `servers.json` existiert.
2. Falls **nicht**: Lese alte Env-Variablen (`GAME_CONTAINER_NAME`, `SERVER_PATH`, etc.) und erstelle einen Server-Eintrag mit `id: "default"`:
   ```json
   {
     "schemaVersion": 1,
     "servers": [{
       "id": "default",
       "name": "Primary Server",
       "containerName": "${GAME_CONTAINER_NAME}",
       "network": { "serverPort": 5520, ... },
       "paths": { "server": "/opt/hytale/server", ... },
       ...
     }]
   }
   ```
3. User merkt nichts. UI zeigt einen Server, alle alten URLs leiten weiter.
4. Wenn User „+ Server hinzufügen" klickt: Setup-Wizard-Light, dockerode erstellt neuen Container mit eindeutigem Namen und Port-Range (`5520 + index`).

**Docker-Compose-Implikation:** Compose verliert die Hytale-Service-Definition; statt dessen wird die Hytale-Container-Erstellung **vom Manager-Backend** übernommen via dockerode. Bestehende Bind-Mounts → `/opt/hytale-instances/<id>/`. Compose definiert nur noch Manager + Volumes.

> **Mini-Risiko:** User, die ihren Compose-Stack stark angepasst haben, müssen migrieren. Migration-Guide in `docs/MIGRATION_V3.md` zusammen mit dem Release.

### 7.7 Port-Management

- Range `5520–5549` für Hytale-Server (default).
- Range `18081–18120` für WebMap (`+ index*2`), WebMap-WS dahinter.
- Range `18085–18114` für Plugin-API-Port (`18085 + index`).
- Beim `Add Server`: Backend probt freien Port, schreibt ihn in `servers.json`. Frontend warnt, wenn der Port vom Host belegt ist.

### 7.8 Asset-Cache & Mods

- **Asset-Cache:** Pro Server (`paths.assets`). Cache-Größe potenziell verdoppelt — Doku-Hinweis im Setup.
- **Mods:** Mod-Store global (CurseForge/Modtale/StackMart Liste), Install-Modal hat **Server-Picker**: „Install on…" + Checkbox „all servers". Backend kopiert Mod-JAR in jeden Ziel-Server-Mods-Pfad.

### 7.9 Aufwand

| Block | Aufwand |
|---|---|
| Datenmodell + ServersService | 3d |
| Docker-Service Multi-Aware (inkl. Container-Create via dockerode) | 5d |
| Scheduler/Backup/Players/KyuubiAPI/HytaleAdapter refactor | 5d |
| Permissions-Hybrid | 3d |
| WebSocket Multi-Subscribe | 3d |
| Frontend ServerStore + Router + Picker | 5d |
| Setup-Wizard „Add Server" Flow | 3d |
| Migration + Backward-Compat-Proxy | 2d |
| QA + Docs + Migration-Guide | 5d |
| **Summe** | **34 d ≈ 6–7 Wochen** |

---

## 8) Cross-Cutting Concerns

Diese laufen parallel über alle Releases.

### 8.1 Tests

**Minimum:**
- **Backend:** Vitest-Setup, mindestens Unit-Tests für `utils/sanitize.ts`, `services/auth.ts`, `services/backup.ts`, alle Zod-Schemas. Integration-Tests für `/api/auth/*` mit Supertest gegen einen In-Memory-Express.
- **Frontend:** Vitest + `@testing-library/vue` für Logik-lastige Composables (`useWebSocket`, `useToast`), keine Pflicht für jede View.
- **E2E:** Playwright, **eine** Smoke-Suite (Login → Console → Start Server (Mock) → Logout). Läuft im CI.

Aufwand initiale Bootstrap: 3 Tage; danach ständig.

### 8.2 Observability

- **Strukturierte Logs:** `pino` statt `console.*`. Korrelations-ID pro Request via Middleware (`req.id = randomUUID()`), Logger als `req.log` weitergegeben.
- **Metrics:** `prom-client`-Export auf `/api/metrics` (geschützt mit `metrics.view`-Permission oder API-Key). Counter pro Endpoint, Histogram für Latenzen, Gauges für `online_players`, `container_running`.
- **Health-Endpoints:** `/api/health` existiert; ergänzen um `/api/health/ready` (kann Setup, hat DB, hat Container?).

### 8.3 Type-Sharing Backend↔Frontend

**Option A** — Zod-Single-Source:
- Backend exportiert Zod-Schemas aus `backend/src/schemas/*`.
- Build-Step generiert TypeScript-Types daraus und legt sie in `frontend/src/api/generated/` ab.
- Frontend importiert Typen, nutzt sie für Axios-Wrapper.
- Aufwand: 2 Tage, danach 0 Drift.

**Option B** — OpenAPI:
- `zod-to-openapi` Plugin generiert OpenAPI-Spec aus den Schemas.
- Frontend nutzt `openapi-typescript` für Type-Generierung.
- Bonus: Externe API-Doku unter `/api/docs` mit Swagger-UI.
- Aufwand: 3 Tage.

**Empfehlung:** Option B — Spec ist Bonus-Wert für API-Konsumenten (Webhooks, externe Tools).

### 8.4 Module-Boundaries-Refactor

Vorgeschlagene Backend-Struktur nach V3.0:

```
manager/backend/src/
├── core/                  # Domain-unabhängige Utilities
│   ├── audit/
│   ├── cookies/
│   ├── http/
│   ├── locks/
│   └── observability/
├── domain/                # Domain-Logik
│   ├── auth/              # 2FA, Sessions, API-Keys
│   ├── servers/           # ServerInstance, Routing-Layer
│   ├── docker/            # Container-Lifecycle
│   ├── plugin/            # KyuubiSoft API + Adapter
│   ├── backups/
│   ├── scheduler/
│   ├── webhooks/
│   └── notifications/
├── api/                   # Express-Router
└── index.ts
```

Frontend analog: `domains/` (auth, servers, players, …) statt der heutigen `views/` + `components/` als reine Atom-Schicht.

---

## 9) Aufwand, Reihenfolge & Risiken

### Gesamtaufwand
| Release | Untere Schätzung | Obere Schätzung |
|---|---|---|
| V2.5 | 4 Wochen | 6 Wochen |
| V3.0 | 8 Wochen | 12 Wochen |
| V3.1 | 4 Wochen | 6 Wochen |
| V3.x (Multi-Server) | 6 Wochen | 8 Wochen |
| **Total V2.2 → V3.x** | **22 Wochen** | **32 Wochen** |

Bei einem Vollzeit-Entwickler: ~6 Monate für die ganze Reise.

### Empfohlene Reihenfolge

```
V2.5 (komplett, eine Linie)
   │
   ├──→ V3.0 5.1 Webhook-Engine
   │       └─→ V3.0 5.3 Notifications-Center (baut auf 5.1)
   │
   ├──→ V3.0 5.2 File-Manager (parallel möglich)
   │
   ├──→ V3.0 5.4 OIDC/SSO (parallel möglich)
   │
   └──→ V3.0 5.5 Bulk-Aktionen (parallel)
        │
        ├─→ V3.1 Hytale-USPs (Live-Map, Replay, Auto-Wiki — parallel)
        │
        └─→ V3.x Multi-Server (nach V3.0, hoher Aufwand)
```

### Risiken & Mitigations

| Risiko | Wahrscheinlichkeit | Auswirkung | Mitigation |
|---|---|---|---|
| Hytale-Plugin-API ändert sich mit nächstem Update | hoch | mittel | `HytaleAPIFactory` und Adapter-Schicht reduzieren Blast-Radius; Zod-Schemas detektieren Drift früh |
| Monaco-Editor bläst Bundle | mittel | gering | Lazy-Loader, separater Chunk |
| Multi-Server-Migration bricht existierende Compose-Stacks | mittel | hoch | Backward-Compat-Proxy + `docs/MIGRATION_V3.md` + Migration-Helper-Endpoint |
| 2FA-Backup-Codes gehen verloren → User locked out | mittel | hoch | Recovery-Endpoint per direktem File-Edit `users.json` dokumentieren; CLI-Tool `kp-recover` |
| Performance bei Multi-Server (z.B. 10 Container × Stats jede Sekunde) | mittel | mittel | Stats nur on-demand (View aktiv) + 5s-Cache |
| Webhook-Storm spammt externe Dienste | mittel | mittel | Rate-Limit pro Webhook (5/s), Discord/Slack 429-Handling |
| SQLite-Datei-Locking unter Last | gering | mittel | `better-sqlite3` ist synchron, single-process — passt, solange wir nicht parallel forken |
| TS-Inkompatibilität `vue-tsc 1.x` blockiert CI | hoch | gering | Upgrade auf vue-tsc 2.x mit Sprint V2.5.7 |

---

## 10) Open Questions

Punkte, die vor Implementierung mit dem Maintainer abgestimmt werden müssen:

1. **2FA-Recovery-Flow:** Reicht das Verlassen auf Backup-Codes, oder soll es einen administrativen „Reset 2FA"-Knopf für andere Admin-User geben?
2. **SSO-Account-Linking:** Soll ein bestehender Passwort-User sich nachträglich mit Discord verbinden, oder ist SSO-only ab dem Moment exklusiv?
3. **File-Manager-Whitelist:** Welche Pfade sind editierbar (`mods/`, `plugins/` sicher)? Welche sind tabu (`auth/` definitiv, `data/universe/` vermutlich read-only)?
4. **Multi-Server: ein oder mehrere Hytale-Accounts?** Hat jeder Server-Container eine eigene `auth/`-Quelle (eigenes Hytale-Konto) oder teilen sich alle einen?
5. **PWA-Offline-Strategie:** Soll die UI offline „letzte-bekannte-Daten" zeigen, oder Sperrbildschirm „Reconnect"?
6. **Light-Mode-Default:** Auto-Detect via `prefers-color-scheme`, oder weiterhin Dark als Default?
7. **Replay-Recorder & Datenschutz:** Werden Chat-Snippets aufgenommen — DSGVO-Hinweis im Setup?
8. **Audit-Log-Retention:** Default 180 Tage OK, oder kürzer (90)?
9. **Webhook-Secret-Storage:** Im Klartext in SQLite oder doppelt verschlüsselt mit panel-spezifischem Master-Key?
10. **Plugin-Version-Pinning:** Soll der KyuubiSoft-Plugin-Loader mehrere Versionen parallel laden können (für Server mit unterschiedlichen Hytale-Versionen)?

---

## Anhang A — Mapping: heutige Pfade → V3.x-Pfade

| heute | V3.x |
|---|---|
| `config.gameContainerName` | `serversService.get(id).containerName` |
| `config.serverPath` | `serversService.get(id).paths.server` |
| `getContainer()` | `getContainer(serverId)` |
| `GET /api/server/status` | `GET /api/servers/:id/status` (alt bleibt als Proxy auf Default) |
| `POST /api/console/exec` | `POST /api/servers/:id/console/exec` |
| `GET /api/backups` | `GET /api/servers/:id/backups` |
| `services/scheduler.ts` Tasks | Tasks mit `serverId`-Feld, Engine bleibt zentral |
| Webhook-Stub in Setup | `services/webhookDispatcher.ts` (V3.0) |
| `services/activityLog.ts` (JSON) | SQLite + Filter-API (V2.5) |

## Anhang B — Glossar

- **Capability-Matrix:** der vom `HytaleAPIFactory` ermittelte Feature-Satz (Native-Updates, Server-Browser, JSON-Config) — pro Server, abhängig von der `.hytale-version`.
- **WS-Ticket:** kurzlebiger, einmalig nutzbarer Token (verifiziert atomar in `services/auth.ts`) zur Authentifizierung des WebSocket-Upgrades, ersetzt JWT-in-Query-String.
- **Server-Scope:** Permission, die nur für eine bestimmte `ServerInstance.id` gilt (V3.x).
- **Egg / Template / Module:** Pelican/AMP-Konzept für „Server-Vorlage pro Spiel". Für KyuubiSoft nicht relevant (Single-Game).
