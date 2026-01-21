# Fehlerbehebung

Lösungen für häufige Probleme mit dem KyuubiSoft Hytale Panel.

---

## Installation & Setup

### Container startet nicht

**Problem:** Docker Container bleibt in "starting" oder "restarting" Zustand.

**Lösung:**
```bash
# Logs prüfen
docker logs hytale
docker logs hytale-manager

# Häufige Ursachen:
# 1. Fehlende Umgebungsvariablen
# 2. Port bereits belegt
# 3. Nicht genug RAM
```

---

### "Insecure Configuration" Fehler

**Problem:** Server startet nicht mit Fehlermeldung über unsichere Konfiguration.

**Lösung:**
```env
# Alle Pflicht-Variablen setzen:
JWT_SECRET=<mind. 32 Zeichen>
CORS_ORIGINS=http://dein-server:18080
MANAGER_USERNAME=admin
MANAGER_PASSWORD=<mind. 12 Zeichen, nicht "admin">
```

Generiere JWT_SECRET:
```bash
openssl rand -base64 48
```

Für Entwicklung/Test:
```env
SECURITY_MODE=warn
```

---

### Port bereits belegt

**Problem:** `Error: port is already in use`

**Lösung:**
```bash
# Prüfen welcher Prozess den Port nutzt
sudo lsof -i :18080
sudo lsof -i :5520

# Oder anderen Port in .env setzen
MANAGER_PORT=18081
SERVER_PORT=5521
```

---

## Berechtigungsprobleme

### "Permission Denied" nach Update auf v2.0

**Problem:** Dateizugriffsfehler nach Update von v1.x auf v2.0.

**Ursache:** Container läuft jetzt als UID 9999 statt root.

**Lösung:**
```bash
sudo chown -R 9999:9999 /opt/hytale
sudo chmod -R g+rw /opt/hytale
```

---

### Panel zeigt Permission-Warnung

**Problem:** Banner im Panel zeigt "Permission Issues".

**Lösung:**
1. Führe den angezeigten Befehl aus
2. Oder manuell:
```bash
sudo chown -R 9999:9999 /opt/hytale
```

---

### Backups können nicht erstellt werden

**Problem:** Backup-Erstellung schlägt fehl mit Permission Error.

**Lösung:**
```bash
# Backup-Verzeichnis prüfen
ls -la /opt/hytale/backups

# Berechtigungen korrigieren
sudo chown -R 9999:9999 /opt/hytale/backups
sudo chmod 775 /opt/hytale/backups
```

---

## Verbindungsprobleme

### Panel nicht erreichbar

**Problem:** Browser zeigt "Verbindung abgelehnt".

**Checkliste:**
1. Container läuft?
   ```bash
   docker ps | grep hytale-manager
   ```

2. Port offen?
   ```bash
   sudo ufw allow 18080/tcp
   ```

3. Firewall prüfen?
   ```bash
   sudo iptables -L -n | grep 18080
   ```

4. Richtige IP?
   - Nicht `localhost` von extern
   - Server-IP verwenden

---

### CORS-Fehler

**Problem:** Browser-Konsole zeigt CORS-Fehler.

**Lösung:**
```env
# CORS_ORIGINS muss die URL enthalten, von der du zugreifst
CORS_ORIGINS=http://192.168.1.100:18080

# Bei mehreren Domains:
CORS_ORIGINS=http://localhost:18080,http://192.168.1.100:18080,https://panel.example.com
```

Nach Änderung:
```bash
docker-compose restart hytale-manager
```

---

### WebSocket verbindet nicht

**Problem:** Konsole zeigt keine Live-Logs, "Connecting..." Meldung.

**Lösungen:**

1. **Reverse Proxy konfigurieren:**
   ```nginx
   location / {
       proxy_pass http://localhost:18080;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
   }
   ```

2. **TRUST_PROXY aktivieren:**
   ```env
   TRUST_PROXY=true
   ```

3. **CORS prüfen:**
   ```env
   CORS_ORIGINS=https://deine-domain.com
   ```

---

### Server nicht über Internet erreichbar

**Problem:** Spieler können nicht beitreten.

**Checkliste:**

1. **Port-Weiterleitung im Router:**
   - Port: 5520
   - **Protokoll: UDP** (nicht TCP!)
   - Ziel: Server-LAN-IP

2. **Firewall auf Server:**
   ```bash
   sudo ufw allow 5520/udp
   ```

3. **Prüfen:**
   ```bash
   # Von extern (z.B. https://www.yougetsignal.com/tools/open-ports/)
   # Port 5520 UDP prüfen
   ```

---

## Login-Probleme

### Falsches Passwort

**Problem:** Login schlägt fehl obwohl Passwort korrekt.

**Lösungen:**

1. **Groß-/Kleinschreibung prüfen**

2. **Rate Limiting:**
   - Nach 5 Fehlversuchen: 15 Minuten warten
   - Oder Container neustarten

3. **Passwort zurücksetzen:**
   ```bash
   # Container stoppen
   docker stop hytale-manager

   # users.json bearbeiten
   docker run --rm -v manager-data:/data alpine cat /data/users.json
   # Oder Volume mounten und Datei löschen für Reset

   # Container starten (erstellt neuen Admin aus .env)
   docker start hytale-manager
   ```

---

### Token abgelaufen

**Problem:** "Token expired" Fehler nach einiger Zeit.

**Lösung:**
- Normal - Access Token läuft nach 15 Minuten ab
- Panel erneuert automatisch
- Bei Problemen: Ausloggen und neu einloggen

---

## Server-Probleme

### Server startet nicht

**Problem:** Hytale Server bleibt offline.

**Checkliste:**

1. **Server-Dateien vorhanden?**
   ```bash
   docker exec hytale ls -la /opt/hytale/server/
   # HytaleServer.jar und Assets.zip müssen existieren
   ```

2. **RAM ausreichend?**
   ```env
   JAVA_MIN_RAM=3G
   JAVA_MAX_RAM=4G
   # Host muss mehr RAM haben!
   ```

3. **Logs prüfen:**
   ```bash
   docker logs hytale
   ```

4. **Authentifizierung:**
   ```bash
   docker attach hytale
   /auth login device
   # Code eingeben
   ```

---

### Server stürzt ab (Out of Memory)

**Problem:** Server stoppt mit "OutOfMemoryError".

**Lösung:**
```env
# RAM erhöhen
JAVA_MIN_RAM=4G
JAVA_MAX_RAM=6G

# Docker Limit anpassen (muss > JAVA_MAX_RAM sein)
DOCKER_MEMORY_LIMIT=8G
```

---

### Hytale Auth fehlgeschlagen

**Problem:** Server kann nicht authentifiziert werden.

**Lösung:**
```bash
# An Container anhängen
docker attach hytale

# Neu authentifizieren
/auth login device

# Browser-Link öffnen
# Code eingeben
# Warten auf Bestätigung

# Container verlassen: Ctrl+P, Ctrl+Q
```

---

## Backup-Probleme

### Backup erstellt 0 KB Dateien

**Problem:** Native Hytale Backups sind leer.

**Ursache:** Hytale's eingebautes Backup ist derzeit defekt.

**Lösung:**
- Nutze **Scheduler-Backups** im Panel
- Diese erstellen funktionierende `.tar.gz` Archive

```env
# Native Backup deaktivieren (Standard in v2.0)
ENABLE_BACKUP=false
```

---

### Backup-Wiederherstellung schlägt fehl

**Problem:** Restore funktioniert nicht.

**Lösungen:**

1. **Server stoppen vor Restore**

2. **Berechtigungen prüfen:**
   ```bash
   sudo chown -R 9999:9999 /opt/hytale
   ```

3. **Manueller Restore:**
   ```bash
   # Backup entpacken
   tar -xzf backup_20240101.tar.gz -C /tmp/restore

   # Dateien kopieren
   docker cp /tmp/restore/. hytale:/opt/hytale/

   # Berechtigungen
   docker exec hytale chown -R hytale:hytale /opt/hytale
   ```

---

## Performance-Probleme

### Panel reagiert langsam

**Problem:** Web-Interface ist träge.

**Lösungen:**

1. **Browser-Cache leeren**

2. **Manager-Ressourcen erhöhen:**
   ```yaml
   # docker-compose.yml
   manager:
     deploy:
       resources:
         limits:
           memory: 1G
   ```

3. **Logs prüfen:**
   ```bash
   docker logs hytale-manager
   ```

---

### Hohe CPU-Auslastung

**Problem:** Server verbraucht viel CPU.

**Lösungen:**

1. **Spieleranzahl reduzieren**

2. **Mods prüfen** - einige sind ressourcenintensiv

3. **View Distance reduzieren:**
   - Quick Settings → Max View Radius

4. **CPU Limit erhöhen:**
   ```env
   DOCKER_CPU_LIMIT=6
   ```

---

## Mod/Plugin-Probleme

### Mod wird nicht geladen

**Problem:** Hochgeladener Mod erscheint nicht im Spiel.

**Checkliste:**

1. **Dateiformat:** Muss `.jar` sein
2. **Richtiger Ordner:** `/opt/hytale/mods/`
3. **Server neugestartet?**
4. **Mod aktiviert?** (Toggle im Panel)
5. **Kompatibilität:** Mod-Version passend zur Server-Version?

---

### Plugin-API Fehler

**Problem:** "Accept Early Plugins" Warnung.

**Lösung:**
- Settings → Accept Early Plugins aktivieren
- **Warnung:** Experimentelle Feature, kann instabil sein

---

## Docker-Probleme

### Volume-Daten verloren

**Problem:** Daten nach Container-Neustart weg.

**Ursache:** Volumes nicht korrekt gemountet.

**Prüfen:**
```bash
docker volume ls | grep hytale
docker volume inspect hytale-data
```

**Lösung:**
- Named Volumes in docker-compose.yml verwenden
- Nicht `docker rm -v` verwenden

---

### Container-Neustart-Schleife

**Problem:** Container startet immer wieder neu.

**Diagnose:**
```bash
docker logs --tail 100 hytale
docker logs --tail 100 hytale-manager
```

**Häufige Ursachen:**
- Fehlende Umgebungsvariablen
- Konfigurationsfehler
- Port-Konflikte

---

## Logs sammeln

Für Support-Anfragen:

```bash
# Server-Logs
docker logs hytale > hytale.log 2>&1

# Manager-Logs
docker logs hytale-manager > manager.log 2>&1

# Container-Status
docker ps -a > containers.log

# System-Info
docker info > docker-info.log
```

---

## Support erhalten

1. **Logs sammeln** (siehe oben)
2. **GitHub Issue erstellen:** [Repository](https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/issues)
3. **Discord:** [KyuubiSoft Server](https://dsc.gg/kyuubisoft)

**Hilfreiche Informationen:**
- Panel-Version
- Docker-Version
- Betriebssystem
- Fehlermeldungen
- Schritte zur Reproduktion

---

## Nächste Schritte

- [[Installation]] - Korrekte Installation
- [[Konfiguration]] - Alle Einstellungen
- [[Sicherheit]] - Sicherheitsprobleme
