# Security

Comprehensive documentation of all security features in the KyuubiSoft Hytale Panel.

---

## Security Rating

| Category | Rating |
|----------|--------|
| Authentication & Authorization | 9/10 |
| Input Validation | 9/10 |
| Command Injection Prevention | 10/10 |
| Path Traversal Prevention | 9/10 |
| Docker Security | 9/10 |
| Error Handling | 9/10 |
| Cryptography | 10/10 |
| Configuration Security | 9/10 |
| **OVERALL** | **9/10** |

---

## Authentication

### JWT Token System

The panel uses a dual token system:

| Token Type | Lifetime | Usage |
|------------|----------|-------|
| Access Token | 15 minutes | API authentication |
| Refresh Token | 7 days | Token renewal |

### Token Versioning

When password or role changes, all existing tokens are invalidated:

```typescript
// Each user has a tokenVersion
user.tokenVersion++;
// Old tokens become invalid
```

### WebSocket Tickets

Single-use tickets are used for WebSocket connections:

- **Lifetime:** 30 seconds
- **Single use:** Deleted after use
- **Cryptographically secure:** 32 byte random value

**Benefits:**
- No JWT in URL (prevents log exposure)
- No tokens in browser history
- No tokens in Referer headers

### Password Security

- **Bcrypt hashing** with salt rounds = 12
- **Async implementation** to avoid event loop blocking
- **Minimum 8 characters** (12+ recommended)
- **No weak defaults** allowed

---

## Authorization

### Role-Based Access Control (RBAC)

The system provides 60+ granular permissions in 18 categories:

| Category | Example Permissions |
|----------|---------------------|
| Dashboard | `dashboard.view` |
| Server | `server.start`, `server.stop`, `server.restart` |
| Console | `console.view`, `console.execute` |
| Performance | `performance.view` |
| Players | `players.view`, `players.kick`, `players.ban` |
| Chat | `chat.view`, `chat.delete` |
| Backups | `backups.create`, `backups.restore`, `backups.delete` |
| Scheduler | `scheduler.view`, `scheduler.edit` |
| Worlds | `worlds.view` |
| Mods | `mods.view`, `mods.install`, `mods.delete` |
| Plugins | `plugins.view`, `plugins.install` |
| Configuration | `config.view`, `config.edit` |
| Assets | `assets.view`, `assets.manage` |
| Users | `users.view`, `users.create`, `users.delete` |
| Roles | `roles.view`, `roles.manage` |
| Activity | `activity.view`, `activity.clear` |
| Hytale Auth | `hytale_auth.manage` |
| Settings | `settings.view`, `settings.edit` |

### Default Roles

| Role | Description | Permissions |
|------|-------------|-------------|
| **Administrator** | Full access | `*` (Wildcard) |
| **Moderator** | Player management | Kick, Ban, Chat |
| **Operator** | Server management | Server, Backups, Config |
| **Viewer** | Read only | View permissions |

### Self-Protection

- Users cannot change their own role
- Users cannot delete themselves
- System roles cannot be deleted

---

## Input Validation

### Command Injection Prevention

All server commands are validated against a whitelist:

**Allowed commands (40+):**
```
/kick, /ban, /unban, /whitelist, /tp, /teleport, /give,
/time, /weather, /say, /tell, /msg, /kill, /heal,
/gamemode, /gm, /effect, /clear, /op, /deop, /pardon,
/difficulty, /seed, /list, /stop, /save-all, /save-off,
/save-on, /setblock, /fill, /summon, /spawn, /respawn,
/world, /reload, /broadcast, /bc, /help, /version, /tps
```

**Blocked characters:**
```
; | & $ ` ( ) { } [ ] < > \
```

**Blocked patterns:**
```
$(...) ${...} `...`
```

### Path Traversal Prevention

Multi-layer validation for all file operations:

```typescript
// 1. Sanitize filename
sanitizeFileName(name)  // Removes .., hidden files

// 2. Validate path
isPathSafe(path, baseDir)  // Checks if path within allowed directories

// 3. Resolve symlinks
getRealPathIfSafe(path, baseDir)  // Follows symlinks and validates
```

### ReDoS Prevention

Regular expressions are protected against DoS attacks:

- **Pattern length limit:** 100 characters
- **Nested quantifiers blocked:** `(a+)+`, `(a*)*`
- **Quantifier limit:** 10 per pattern
- **Group limit:** 5 per pattern
- **Backreferences blocked**

### Type-Specific Validation

| Type | Validation |
|------|------------|
| Player name | `[a-zA-Z0-9_-]{1,32}` |
| Item ID | Namespace format |
| Coordinates | Numeric, `~` for relative |
| UUID | `8-4-4-4-12` hex format |
| Gamemode | `creative`, `adventure` |
| Backup name | `[a-zA-Z0-9_-]{1,64}` |

---

## File Security

### Magic Byte Verification

Uploaded files are verified for correct format:

```
ZIP/JAR: PK\x03\x04 (first 4 bytes)
```

### Secure Filenames

- **Random prefix:** 8 character hex via `crypto.randomBytes(4)`
- **Allowed characters:** `[a-zA-Z0-9._-]`
- **Maximum length:** 100 characters

### Blocked File Types

```
.exe, .dll, .so, .sh, .bat, .cmd, .ps1, .vbs
```

### Allowed Config Files

```
.json, .properties, .yml, .yaml, .toml, .cfg, .conf, .ini
```

---

## HTTP Security

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

### CORS Configuration

- **No wildcards:** Origins must be explicitly configured
- **Credentials:** Supported for same-origin
- **Allowed methods:** GET, POST, PUT, DELETE, PATCH, OPTIONS

### CSRF Protection

State-changing requests are validated against configured origins:

```typescript
// Origin/Referer must be in CORS_ORIGINS
// or Same-Origin request
```

### Request Limits

- **JSON Body:** 100KB maximum
- **Rate Limiting:** Configured per endpoint
- **Compression:** Enabled for responses

---

## Docker Security

### Non-Root Execution

Both containers run as unprivileged user:

```dockerfile
# Manager Container
USER manager (UID 9999)

# Hytale Container
USER hytale (UID 9999)
```

### Capability Dropping

All Linux capabilities are removed, only required ones re-added:

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
  - NET_BIND_SERVICE  # Hytale container only
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

`dumb-init` is used for proper signal handling:

```dockerfile
RUN apk add --no-cache dumb-init
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
```

---

## Audit Logging

### Logged Actions

| Category | Actions |
|----------|---------|
| `user` | Login, Logout, Create, Delete |
| `server` | Start, Stop, Restart |
| `player` | Kick, Ban, Teleport, etc. |
| `backup` | Create, Restore, Delete |
| `config` | Changes |
| `mod` | Upload, Enable, Delete |
| `system` | Errors, Warnings |

### Log Structure

```json
{
  "id": "1704110400000_a1b2c3",
  "timestamp": "2024-01-01T12:00:00Z",
  "username": "admin",
  "action": "Player kicked",
  "target": "Player1",
  "details": "Reason: Rule violation",
  "category": "player",
  "success": true
}
```

### Retention

- **In-memory:** 500 most recent entries
- **Persistent:** JSON file
- **Rotation:** Oldest entries removed

---

## Error Handling

### Production Mode

In production, no stack traces are sent to clients:

```typescript
if (process.env.NODE_ENV === 'production') {
  // Generic error message
  res.status(500).json({ error: 'Internal Server Error' });
} else {
  // Detailed error message for development
  res.status(500).json({ error: err.message, stack: err.stack });
}
```

### Global Exception Handlers

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

### Before Deployment

1. **Generate JWT_SECRET:**
   ```bash
   openssl rand -base64 48
   ```

2. **Set secure password:**
   - At least 12 characters
   - No dictionary words
   - Upper/lowercase, numbers, special characters

3. **Configure CORS:**
   - Only required domains
   - Never `*` in production

4. **Enable HTTPS:**
   - Reverse proxy with TLS
   - Set `TRUST_PROXY=true`

### During Operation

1. **Monitor Activity Log**
2. **Watch failed logins**
3. **Check rate limit hits**
4. **Create regular backups**
5. **Keep Docker images updated**

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

## Known Limitations

| Limitation | Reason |
|------------|--------|
| Docker Socket Access | Required for container management |
| Synchronous Backups | Prevents parallel backup corruption |

---

## Security Reports

For security issues please report to:
- **GitHub Issues:** [Repository](https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/issues)
- **Discord:** [KyuubiSoft Server](https://dsc.gg/kyuubisoft)

---

## Next Steps

- [[Configuration]] - Security-related settings
- [[User-Management]] - Set permissions correctly
- [[Troubleshooting]] - For security issues
