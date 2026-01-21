# Troubleshooting

Solutions for common issues with the KyuubiSoft Hytale Panel.

---

## Installation & Setup

### Container Won't Start

**Problem:** Docker container stays in "starting" or "restarting" state.

**Solution:**
```bash
# Check logs
docker logs hytale
docker logs hytale-manager

# Common causes:
# 1. Missing environment variables
# 2. Port already in use
# 3. Not enough RAM
```

---

### "Insecure Configuration" Error

**Problem:** Server won't start with error about insecure configuration.

**Solution:**
```env
# Set all required variables:
JWT_SECRET=<at least 32 characters>
CORS_ORIGINS=http://your-server:18080
MANAGER_USERNAME=admin
MANAGER_PASSWORD=<at least 12 characters, not "admin">
```

Generate JWT_SECRET:
```bash
openssl rand -base64 48
```

For development/testing:
```env
SECURITY_MODE=warn
```

---

### Port Already in Use

**Problem:** `Error: port is already in use`

**Solution:**
```bash
# Check which process is using the port
sudo lsof -i :18080
sudo lsof -i :5520

# Or set different port in .env
MANAGER_PORT=18081
SERVER_PORT=5521
```

---

## Permission Issues

### "Permission Denied" After Update to v2.0

**Problem:** File access errors after updating from v1.x to v2.0.

**Cause:** Container now runs as UID 9999 instead of root.

**Solution:**
```bash
sudo chown -R 9999:9999 /opt/hytale
sudo chmod -R g+rw /opt/hytale
```

---

### Panel Shows Permission Warning

**Problem:** Banner in panel shows "Permission Issues".

**Solution:**
1. Run the displayed command
2. Or manually:
```bash
sudo chown -R 9999:9999 /opt/hytale
```

---

### Backups Cannot Be Created

**Problem:** Backup creation fails with permission error.

**Solution:**
```bash
# Check backup directory
ls -la /opt/hytale/backups

# Fix permissions
sudo chown -R 9999:9999 /opt/hytale/backups
sudo chmod 775 /opt/hytale/backups
```

---

## Connection Issues

### Panel Not Reachable

**Problem:** Browser shows "Connection refused".

**Checklist:**
1. Container running?
   ```bash
   docker ps | grep hytale-manager
   ```

2. Port open?
   ```bash
   sudo ufw allow 18080/tcp
   ```

3. Check firewall?
   ```bash
   sudo iptables -L -n | grep 18080
   ```

4. Correct IP?
   - Not `localhost` from external
   - Use server IP

---

### CORS Error

**Problem:** Browser console shows CORS error.

**Solution:**
```env
# CORS_ORIGINS must contain the URL you're accessing from
CORS_ORIGINS=http://192.168.1.100:18080

# For multiple domains:
CORS_ORIGINS=http://localhost:18080,http://192.168.1.100:18080,https://panel.example.com
```

After change:
```bash
docker-compose restart hytale-manager
```

---

### WebSocket Won't Connect

**Problem:** Console shows no live logs, "Connecting..." message.

**Solutions:**

1. **Configure reverse proxy:**
   ```nginx
   location / {
       proxy_pass http://localhost:18080;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
   }
   ```

2. **Enable TRUST_PROXY:**
   ```env
   TRUST_PROXY=true
   ```

3. **Check CORS:**
   ```env
   CORS_ORIGINS=https://your-domain.com
   ```

---

### Server Not Reachable via Internet

**Problem:** Players cannot join.

**Checklist:**

1. **Port forwarding in router:**
   - Port: 5520
   - **Protocol: UDP** (not TCP!)
   - Target: Server LAN IP

2. **Firewall on server:**
   ```bash
   sudo ufw allow 5520/udp
   ```

3. **Check:**
   ```bash
   # From external (e.g., https://www.yougetsignal.com/tools/open-ports/)
   # Check port 5520 UDP
   ```

---

## Login Issues

### Wrong Password

**Problem:** Login fails even though password is correct.

**Solutions:**

1. **Check case sensitivity**

2. **Rate limiting:**
   - After 5 failed attempts: wait 15 minutes
   - Or restart container

3. **Reset password:**
   ```bash
   # Stop container
   docker stop hytale-manager

   # Edit users.json
   docker run --rm -v manager-data:/data alpine cat /data/users.json
   # Or mount volume and delete file for reset

   # Start container (creates new admin from .env)
   docker start hytale-manager
   ```

---

### Token Expired

**Problem:** "Token expired" error after some time.

**Solution:**
- Normal - Access token expires after 15 minutes
- Panel renews automatically
- If problems: Log out and log in again

---

## Server Issues

### Server Won't Start

**Problem:** Hytale server stays offline.

**Checklist:**

1. **Server files present?**
   ```bash
   docker exec hytale ls -la /opt/hytale/server/
   # HytaleServer.jar and Assets.zip must exist
   ```

2. **Enough RAM?**
   ```env
   JAVA_MIN_RAM=3G
   JAVA_MAX_RAM=4G
   # Host must have more RAM!
   ```

3. **Check logs:**
   ```bash
   docker logs hytale
   ```

4. **Authentication:**
   ```bash
   docker attach hytale
   /auth login device
   # Enter code
   ```

---

### Server Crashes (Out of Memory)

**Problem:** Server stops with "OutOfMemoryError".

**Solution:**
```env
# Increase RAM
JAVA_MIN_RAM=4G
JAVA_MAX_RAM=6G

# Adjust Docker limit (must be > JAVA_MAX_RAM)
DOCKER_MEMORY_LIMIT=8G
```

---

### Hytale Auth Failed

**Problem:** Server cannot be authenticated.

**Solution:**
```bash
# Attach to container
docker attach hytale

# Re-authenticate
/auth login device

# Open browser link
# Enter code
# Wait for confirmation

# Detach: Ctrl+P, Ctrl+Q
```

---

## Backup Issues

### Backup Creates 0 KB Files

**Problem:** Native Hytale backups are empty.

**Cause:** Hytale's built-in backup is currently broken.

**Solution:**
- Use **Scheduler backups** in panel
- These create working `.tar.gz` archives

```env
# Disable native backup (default in v2.0)
ENABLE_BACKUP=false
```

---

### Backup Restore Fails

**Problem:** Restore doesn't work.

**Solutions:**

1. **Stop server before restore**

2. **Check permissions:**
   ```bash
   sudo chown -R 9999:9999 /opt/hytale
   ```

3. **Manual restore:**
   ```bash
   # Extract backup
   tar -xzf backup_20240101.tar.gz -C /tmp/restore

   # Copy files
   docker cp /tmp/restore/. hytale:/opt/hytale/

   # Fix permissions
   docker exec hytale chown -R hytale:hytale /opt/hytale
   ```

---

## Performance Issues

### Panel Responds Slowly

**Problem:** Web interface is sluggish.

**Solutions:**

1. **Clear browser cache**

2. **Increase manager resources:**
   ```yaml
   # docker-compose.yml
   manager:
     deploy:
       resources:
         limits:
           memory: 1G
   ```

3. **Check logs:**
   ```bash
   docker logs hytale-manager
   ```

---

### High CPU Usage

**Problem:** Server uses too much CPU.

**Solutions:**

1. **Reduce player count**

2. **Check mods** - some are resource intensive

3. **Reduce View Distance:**
   - Quick Settings → Max View Radius

4. **Increase CPU limit:**
   ```env
   DOCKER_CPU_LIMIT=6
   ```

---

## Mod/Plugin Issues

### Mod Not Loading

**Problem:** Uploaded mod doesn't appear in game.

**Checklist:**

1. **File format:** Must be `.jar`
2. **Correct folder:** `/opt/hytale/mods/`
3. **Server restarted?**
4. **Mod enabled?** (Toggle in panel)
5. **Compatibility:** Mod version matches server version?

---

### Plugin API Error

**Problem:** "Accept Early Plugins" warning.

**Solution:**
- Settings → Enable Accept Early Plugins
- **Warning:** Experimental feature, may be unstable

---

## Docker Issues

### Volume Data Lost

**Problem:** Data gone after container restart.

**Cause:** Volumes not correctly mounted.

**Check:**
```bash
docker volume ls | grep hytale
docker volume inspect hytale-data
```

**Solution:**
- Use named volumes in docker-compose.yml
- Don't use `docker rm -v`

---

### Container Restart Loop

**Problem:** Container keeps restarting.

**Diagnose:**
```bash
docker logs --tail 100 hytale
docker logs --tail 100 hytale-manager
```

**Common causes:**
- Missing environment variables
- Configuration errors
- Port conflicts

---

## Collect Logs

For support requests:

```bash
# Server logs
docker logs hytale > hytale.log 2>&1

# Manager logs
docker logs hytale-manager > manager.log 2>&1

# Container status
docker ps -a > containers.log

# System info
docker info > docker-info.log
```

---

## Get Support

1. **Collect logs** (see above)
2. **Create GitHub Issue:** [Repository](https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/issues)
3. **Discord:** [KyuubiSoft Server](https://dsc.gg/kyuubisoft)

**Helpful information:**
- Panel version
- Docker version
- Operating system
- Error messages
- Steps to reproduce

---

## Next Steps

- [[Installation]] - Correct installation
- [[Configuration]] - All settings
- [[Security]] - Security issues
