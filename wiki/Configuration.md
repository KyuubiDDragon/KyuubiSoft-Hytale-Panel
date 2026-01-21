# Configuration

Complete reference for all environment variables and settings.

---

## Environment Variables

All configuration is done through the `.env` file. Copy `.env.example` to `.env` and customize.

---

## Security Settings (Required)

These settings are **mandatory** in production mode.

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | Secret for JWT signing. **Min 32 chars.** Generate with `openssl rand -base64 48` | `abc123...` |
| `MANAGER_USERNAME` | Admin username | `admin` |
| `MANAGER_PASSWORD` | Admin password. **Min 12 chars**, cannot be weak default | `MySecurePass123!` |
| `CORS_ORIGINS` | Allowed origins for CORS. Comma-separated | `http://localhost:18080` |
| `SECURITY_MODE` | `strict` (blocks startup) or `warn` (logs only) | `strict` |

### Generate Secure Secrets

```bash
# Generate JWT secret (recommended: 48+ bytes)
openssl rand -base64 48

# Generate secure password
openssl rand -base64 24
```

### CORS Configuration

```env
# Single origin
CORS_ORIGINS=http://192.168.1.100:18080

# Multiple origins
CORS_ORIGINS=http://localhost:18080,http://192.168.1.100:18080,https://panel.example.com

# WARNING: Never use * in production!
```

---

## Server Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `HOST_DATA_PATH` | Host path for persistent data | `/opt/hytale` |
| `STACK_NAME` | Docker container name prefix | `hytale` |
| `SERVER_PORT` | Hytale server port (UDP) | `5520` |
| `MANAGER_PORT` | Panel web interface port | `18080` |
| `TZ` | Timezone | `Europe/Berlin` |

---

## Java Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `JAVA_MIN_RAM` | Minimum heap size | `3G` |
| `JAVA_MAX_RAM` | Maximum heap size | `4G` |
| `JAVA_ARGS` | Additional JVM arguments | (empty) |

### Memory Recommendations

| Players | Min RAM | Max RAM |
|---------|---------|---------|
| 1-10 | 2G | 4G |
| 10-30 | 4G | 6G |
| 30-50 | 6G | 8G |
| 50+ | 8G | 12G+ |

---

## Hytale Server Files

### Option 1: Official Downloader

```env
USE_HYTALE_DOWNLOADER=true
HYTALE_PATCHLINE=release    # or 'pre-release'
```

### Option 2: Custom URLs

```env
USE_HYTALE_DOWNLOADER=false
SERVER_JAR_URL=https://your-server/HytaleServer.jar
ASSETS_URL=https://your-server/Assets.zip
```

---

## Authentication Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTH_MODE` | `authenticated` or `offline` | `authenticated` |
| `AUTH_PERSISTENCE_MODE` | `memory` or `encrypted` | `memory` |

---

## Docker Resource Limits

| Variable | Description | Default |
|----------|-------------|---------|
| `DOCKER_MEMORY_LIMIT` | Container memory limit | `8G` |
| `DOCKER_CPU_LIMIT` | Container CPU limit | `4` |

**Important:** `DOCKER_MEMORY_LIMIT` must be at least `JAVA_MAX_RAM + 1G`

---

## Network Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `TRUST_PROXY` | Enable if behind reverse proxy | `false` |
| `RATE_LIMIT_WINDOW` | Rate limit window in ms | `900000` |
| `RATE_LIMIT_MAX` | Max requests per window | `100` |

---

## WebMap Settings (EasyWebMap Mod)

| Variable | Description | Default |
|----------|-------------|---------|
| `WEBMAP_PORT` | WebMap HTTP port | `18081` |
| `WEBMAP_WS_PORT` | WebMap WebSocket port | `18082` |
| `WEBMAP_ENABLED` | Enable WebMap proxy | `true` |

---

## Mod Store Integration

| Variable | Description | Default |
|----------|-------------|---------|
| `MODTALE_API_KEY` | API key for Modtale | (empty) |
| `STACKMART_API_KEY` | API key for StackMart | (empty) |

---

## Backup Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `BACKUP_RETENTION` | Number of backups to keep | `10` |
| `BACKUP_PATH` | Backup storage path | `/opt/hytale/backups` |

---

## Logging Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |
| `NODE_ENV` | Environment (production, development) | `production` |

---

## Complete Example

```env
# ============================================
# SECURITY (REQUIRED)
# ============================================
JWT_SECRET=your-very-long-secure-secret-at-least-32-characters
MANAGER_USERNAME=admin
MANAGER_PASSWORD=MySecurePassword123!
CORS_ORIGINS=http://192.168.1.100:18080
SECURITY_MODE=strict

# ============================================
# SERVER SETTINGS
# ============================================
HOST_DATA_PATH=/opt/hytale
STACK_NAME=hytale
SERVER_PORT=5520
MANAGER_PORT=18080
TZ=Europe/Berlin

# ============================================
# JAVA SETTINGS
# ============================================
JAVA_MIN_RAM=4G
JAVA_MAX_RAM=6G

# ============================================
# HYTALE SERVER FILES
# ============================================
USE_HYTALE_DOWNLOADER=true
HYTALE_PATCHLINE=release

# ============================================
# AUTHENTICATION
# ============================================
AUTH_MODE=authenticated

# ============================================
# DOCKER RESOURCES
# ============================================
DOCKER_MEMORY_LIMIT=8G
DOCKER_CPU_LIMIT=4

# ============================================
# NETWORK
# ============================================
TRUST_PROXY=false

# ============================================
# OPTIONAL INTEGRATIONS
# ============================================
# MODTALE_API_KEY=
# STACKMART_API_KEY=
```

---

## Configuration Validation

The panel validates configuration on startup:

### Strict Mode (Default)

- Server **will not start** if security issues are found
- All required variables must be set
- Weak passwords are rejected

### Warn Mode

- Server **will start** with warnings
- Use only for development/closed networks

```env
SECURITY_MODE=warn
```

---

## Changing Configuration

After changing `.env`:

```bash
# Restart containers to apply changes
docker compose down
docker compose up -d

# Or restart specific service
docker compose restart hytale-manager
```

---

## Next Steps

- [[Installation]] - Installation guide
- [[Security]] - Security best practices
- [[Features]] - Feature documentation
