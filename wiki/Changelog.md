# Changelog

Version history of the KyuubiSoft Hytale Panel.

---

## Version 2.0.0 - Production Ready Security Release
**Released:** 2026-01-19

### Security Rating: 9/10

This version marks the transition to a production-ready, security-hardened system following comprehensive external security review.

---

### Critical Security Fixes

#### Command Injection Prevention
- Whitelist of 35 allowed game commands implemented
- Commands must start with `/`
- Blocks shell metacharacters: `;`, `|`, `&`, `$`, `` ` ``
- Blocks command substitution: `$(...)`, `${...}`
- Blocks redirections: `>`, `<`
- **File:** `manager/backend/src/utils/sanitize.ts`

#### Path Traversal Protection
- Multi-layer validation for all file operations
- `sanitizeFileName()`: Extracts basename, blocks `..` and hidden files
- `isPathSafe()`: Validates paths within allowed directories
- Applied to: Mod/Plugin operations, config files
- **File:** `manager/backend/src/utils/pathSecurity.ts`

#### ReDoS Prevention (Regular Expression Denial of Service)
- Pattern length limit: 100 characters
- Blocks nested quantifiers: `(a+)+`, `(a*)*`
- Quantifier limit: 10
- Group limit: 5
- Backreferences rejected
- **File:** `manager/backend/src/services/assets.ts`

---

### High Priority Fixes

#### Magic Byte File Verification
- Validates uploaded files against expected format
- ZIP/JAR signature check: `PK\x03\x04`
- Binary content detection for text files
- Dangerous extensions blocked: `.dll`, `.so`

#### Safe Filename Generation
- Prevents filename collision attacks
- Random 8-character hex prefix via `crypto.randomBytes(4)`
- Character whitelist: `[a-zA-Z0-9._-]`
- Maximum length: 100 characters

#### Non-root Docker Container
- Manager runs as unprivileged user `manager` (UID/GID 9999)
- `dumb-init` for proper signal handling
- **File:** `manager/Dockerfile`

#### Required Environment Variables
- No insecure defaults anymore
- `MANAGER_USERNAME`, `MANAGER_PASSWORD`, `JWT_SECRET` required
- Docker Compose enforces via validation
- Strict Security Mode blocks startup with weak credentials

#### Async bcrypt Operations
- All `bcrypt.hash()` and `bcrypt.compare()` now async
- Prevents event loop blocking

---

### Medium Priority Fixes

- **Global Exception Handler** - Express error middleware, production stack traces hidden
- **Content-Security-Policy Header** - Strict CSP via Helmet
- **CSRF Protection** - Origin/Referer validation
- **Race Condition Fix** - Debounced player data saves
- **Infrastructure Hardening** - JSON body limit 100kb, Docker no-new-privileges

---

### New Features

#### Permission Health Check
- Automatic detection of file permission issues
- New `/api/health/permissions` endpoint
- Warns users when upgrading from v1.x
- Shows affected directories and fix command
- Full localization (EN, DE, PT-BR)

---

### Breaking Changes

#### Environment Variables - NOW REQUIRED
```env
MANAGER_USERNAME=<unique-admin-username>
MANAGER_PASSWORD=<strong-password-12+-characters>
JWT_SECRET=<strong-secret-32+-characters>
CORS_ORIGINS=<specific-origins-not-wildcard>
```

#### Non-Root Container
- Manager container now runs as unprivileged user (UID 9999)
- Existing deployments need permission fix:
  ```bash
  sudo chown -R 9999:9999 /opt/hytale
  ```

#### WebSocket Authentication
- JWT tokens no longer in URL
- Single-use tickets (30 second expiry)

---

## Version 1.7.1
**Released:** 2026-01-19

### New Features

#### Command Help Page
- Complete in-game `/help` GUI rebuilt
- 70+ commands organized in 8 categories
- Live search functionality
- Copy-to-clipboard for command usage
- Permission display for each command

#### Accept Early Plugins Option
- New toggle in Settings
- Enables/Disables `--accept-early-plugins` server flag
- Warning about potential instability

---

## Version 1.7.0
**Released:** 2026-01-18

### New Features

#### Granular Permission System
- Role-based access control
- 53 individual permissions in 18 categories
- Custom role creation with color badges
- System roles: Administrator, Moderator, Operator, Viewer
- Wildcard `*` permission for full admin access

#### Enhanced Player Management
- Click on player (online/offline) for detail modal
- Tabbed interface: Overview, Inventory, Appearance, Chat, Deaths
- Player inventory display with item icons
- Death position tracking with teleport options
- Player actions: heal, clear inventory, give items, teleport

#### Chat Log System
- Daily file rotation: `data/chat/global/YYYY-MM-DD.json`
- Per-player chat logs: `data/chat/players/{name}/YYYY-MM-DD.json`
- Unlimited message history (1000 message limit removed)
- UUID tracking for players across name changes
- Time range filters (7/14/30 days, all)

#### i18n for Permission Descriptions
- Translated to DE, EN, PT-BR

---

## Version 1.5.0
**Released:** 2025-01-17

### New Features

#### Asset Explorer
- Browse and analyze Hytale assets
- Extract and browse Assets.zip contents
- File viewer: JSON, images, text, hex
- Advanced search: Plaintext, Glob, Regex
- Async extraction for large archives (3GB+)
- Persistent cache via Docker volume

#### Reverse Proxy Support
- `TRUST_PROXY` environment variable
- Correct processing of `X-Forwarded-*` headers
- Support for nginx, traefik, caddy, etc.

#### Patchline Toggle
- UI switch between Release/Pre-Release
- Saved in `data/panel-config.json`
- Auto-delete of server files on patchline change

#### Console Improvements
- Reconnect button on WebSocket disconnect
- Load all logs (increased to 10,000)

---

## Migration from v1.x to v2.0

### Step 1: Set Environment Variables
```bash
# In .env file:
MANAGER_USERNAME=your-admin-username
MANAGER_PASSWORD=your-strong-password        # min 8 chars, 12+ recommended
JWT_SECRET=$(openssl rand -base64 48)
CORS_ORIGINS=https://your-domain.com         # specific domain, not *
```

### Step 2: Fix File Permissions
```bash
sudo chown -R 9999:9999 /opt/hytale
```

### Step 3: Update Deployment Configuration
```yaml
# In docker-compose.yml:
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

### Step 4: Configure Security Mode
```bash
# For production: SECURITY_MODE=strict (default)
# For closed networks: SECURITY_MODE=warn
```

---

## Pre-Deployment Checklist

- [ ] `MANAGER_USERNAME` set to unique admin username
- [ ] `MANAGER_PASSWORD` set to strong password (12+ chars recommended)
- [ ] `JWT_SECRET` generated: `openssl rand -base64 48`
- [ ] `CORS_ORIGINS` set to specific domain(s) - NOT `*`
- [ ] Reverse proxy with TLS (HTTPS) configured
- [ ] `SECURITY_MODE=strict` ensured (default)
- [ ] Permission health check at `/api/health/permissions` run
- [ ] All features tested before production deployment

---

## Next Steps

- [[Installation]] - New installation
- [[Configuration]] - All settings
- [[Security]] - Security details
