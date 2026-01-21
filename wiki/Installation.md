# Installation

This guide walks you through the installation of the KyuubiSoft Hytale Panel.

---

## Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **RAM** | 4GB | 8GB+ |
| **CPU** | 2 Cores | 4+ Cores |
| **Storage** | 10GB | 50GB+ |
| **Docker** | v20.10+ | Latest version |
| **Docker Compose** | v2.0+ | Latest version |

### Ports

| Port | Protocol | Service |
|------|----------|---------|
| 5520 | **UDP** | Hytale Server (QUIC) |
| 18080 | TCP | Web Admin Panel |
| 18081 | TCP | WebMap (optional) |
| 18082 | TCP | WebMap WebSocket (optional) |
| 18085 | TCP | KyuubiSoft API Plugin (internal) |

> **Important:** The Hytale server uses UDP, not TCP!

---

## Installation with Portainer (Recommended)

### Step 1: Add Stack

1. Open Portainer → **Stacks** → **Add Stack**
2. Name: `hytale`
3. Build Method: **Repository**
4. Repository URL: `https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel`

### Step 2: Configure Environment Variables

Set the following **required variables**:

```env
# Security Configuration (REQUIRED)
JWT_SECRET=<your-secret-key>
CORS_ORIGINS=http://YOUR-SERVER-IP:18080
MANAGER_USERNAME=admin
MANAGER_PASSWORD=YourSecurePassword123

# Server Configuration
JAVA_MIN_RAM=3G
JAVA_MAX_RAM=4G
TZ=Europe/Berlin
```

**Generate JWT_SECRET:**
```bash
openssl rand -base64 48
```

### Step 3: Set Up Server Files

Choose one of the following options:

#### Option A: Official Hytale Downloader (Recommended)

```env
USE_HYTALE_DOWNLOADER=true
HYTALE_PATCHLINE=release
```

After first start:
```bash
docker attach hytale
/auth login device
# Follow the browser link and enter the code
```

#### Option B: Custom Download URLs

```env
SERVER_JAR_URL=https://your-server/HytaleServer.jar
ASSETS_URL=https://your-server/Assets.zip
```

#### Option C: Manual Copy

```bash
docker cp Server/HytaleServer.jar hytale:/opt/hytale/server/
docker cp Assets.zip hytale:/opt/hytale/server/
docker restart hytale
```

---

## Manual Installation

### Step 1: Clone Repository

```bash
git clone https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel
cd KyuubiSoft-Hytale-Panel
```

### Step 2: Configure Environment Variables

```bash
cp .env.example .env
nano .env
```

Set at least these variables:

```env
# REQUIRED - Security
JWT_SECRET=$(openssl rand -base64 48)
CORS_ORIGINS=http://localhost:18080
MANAGER_USERNAME=admin
MANAGER_PASSWORD=YourSecurePassword123

# Server Settings
HOST_DATA_PATH=/opt/hytale
JAVA_MIN_RAM=3G
JAVA_MAX_RAM=4G
SERVER_PORT=5520
MANAGER_PORT=18080
TZ=Europe/Berlin
```

### Step 3: Start Containers

```bash
docker-compose up -d
```

### Step 4: Check Logs

```bash
docker logs -f hytale
docker logs -f hytale-manager
```

### Step 5: Open Panel

Open in browser: `http://YOUR-IP:18080`

---

## Server Authentication

### Device Login

```bash
docker attach hytale
/auth login device
```

1. Follow the displayed browser link
2. Enter the displayed code
3. Confirm the authentication

### Change Authentication Mode

```env
# For online server (default)
AUTH_MODE=authenticated

# For LAN-only / Offline
AUTH_MODE=offline
```

---

## Upgrade to Version 2.0

### Step 1: Fix Permissions

```bash
sudo chown -R 9999:9999 /opt/hytale
sudo chmod -R g+rw /opt/hytale
```

### Step 2: Update .env

Add new required variables:

```env
JWT_SECRET=<generated via openssl rand -base64 48>
CORS_ORIGINS=http://your-domain.com
MANAGER_PASSWORD=<at least 12 characters>
SECURITY_MODE=strict
```

### Step 3: Rebuild Containers

```bash
docker-compose build
docker-compose up -d
```

### Migration Checklist

- [ ] Updated `.env` with new variables
- [ ] Generated JWT_SECRET (min 32 characters)
- [ ] Set CORS_ORIGINS (not `*`)
- [ ] Set secure MANAGER_PASSWORD (min 12 characters)
- [ ] Fixed permissions (UID 9999)
- [ ] Rebuilt containers
- [ ] Panel accessible and functional

---

## Docker Volumes

| Volume | Container Path | Contents |
|--------|----------------|----------|
| `hytale-server` | `/opt/hytale/server` | Server JAR + Assets |
| `hytale-data` | `/opt/hytale/data` | Worlds, Configs |
| `hytale-backups` | `/opt/hytale/backups` | Backup Archives |
| `hytale-plugins` | `/opt/hytale/plugins` | Server Plugins |
| `hytale-mods` | `/opt/hytale/mods` | Server Mods |
| `hytale-downloader` | `/opt/hytale/downloader` | Downloader + Credentials |
| `hytale-auth` | `/opt/hytale/auth` | Server Auth Credentials |
| `manager-data` | `/app/data` | Panel Data |

---

## Next Steps

- [[Configuration]] - All configuration options
- [[Features]] - Explore panel features
- [[User-Management]] - Set up users and roles
- [[Troubleshooting]] - If you encounter issues
