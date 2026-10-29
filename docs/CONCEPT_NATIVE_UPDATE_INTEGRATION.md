# Konzept: Hytale Native Update System Integration

## Übersicht

Mit dem Hytale Server Update vom 24.01.2026 wurde ein natives Auto-Update-System eingeführt. Dieses Konzept beschreibt, wie wir diese Funktionalität in das KyuubiSoft Hytale Panel integrieren.

---

## 1. Neue Hytale Server Features

### 1.1 UpdateConfig (in config.json)

```json
{
  "updateConfig": {
    "enabled": true,
    "checkIntervalSeconds": 3600,
    "notifyPlayersOnAvailable": true,
    "patchline": "release",
    "runBackupBeforeUpdate": true,
    "backupConfigBeforeUpdate": true,
    "autoApplyMode": "DISABLED",
    "autoApplyDelayMinutes": 5
  }
}
```

**Felder:**
| Feld | Typ | Beschreibung | Default |
|------|-----|--------------|---------|
| `enabled` | boolean | Update-System aktiviert | true |
| `checkIntervalSeconds` | integer | Prüfintervall in Sekunden | 3600 |
| `notifyPlayersOnAvailable` | boolean | Spieler bei Update benachrichtigen | true |
| `patchline` | string | "release" oder "pre-release" | "release" |
| `runBackupBeforeUpdate` | boolean | Server-Backup vor Update | true |
| `backupConfigBeforeUpdate` | boolean | Config-Backup vor Update | true |
| `autoApplyMode` | enum | Automatische Anwendung | "DISABLED" |
| `autoApplyDelayMinutes` | integer | Verzögerung bei SCHEDULED | 5 |

**AutoApplyMode Optionen:**
- `DISABLED` - Nur manuell
- `WHEN_EMPTY` - Automatisch wenn keine Spieler online
- `SCHEDULED` - Nach Verzögerung (autoApplyDelayMinutes)

### 1.2 Neue Server-Befehle

| Befehl | Beschreibung |
|--------|--------------|
| `/update status` | Zeigt Update-Status |
| `/update check` | Prüft auf Updates |
| `/update download` | Lädt Update herunter |
| `/update apply` | Wendet Update an (Neustart) |
| `/update cancel` | Bricht Download ab |
| `/update patchline [set <value>]` | Zeigt/Ändert Patchline |

### 1.3 Neue Permissions

| Permission | Beschreibung |
|------------|--------------|
| `hytale:world_map_coordinate_teleport` | Teleport via Koordinaten auf Weltkarte |
| `hytale:world_map_marker_teleport` | Teleport via Marker auf Weltkarte |
| `hytale:update_notify` | Update-Benachrichtigungen erhalten |

### 1.4 Exit Code 8 (Update Restart)

Der Server gibt Exit Code 8 zurück, wenn er für ein Update neu gestartet werden soll.
Das neue `start.sh` Script behandelt dies automatisch.

### 1.5 Staged Updates

Updates werden in `updater/staging/` heruntergeladen und beim nächsten Start angewendet.
Vorherige Dateien werden in `updater/backup/` gesichert.

---

## 2. Integration in das Panel

### 2.1 Configuration Editor - UpdateConfig Sektion

**Ziel:** Neue Sektion im Configuration Editor für Update-Einstellungen.

**Backend-Änderungen:**

Datei: `manager/backend/src/routes/config.ts`

```typescript
// Neuer Endpoint für UpdateConfig
router.get('/update-config', authMiddleware, requirePermission('config.view'), async (req, res) => {
  const configPath = path.join(config.serverPath, 'config.json');
  const serverConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  res.json(serverConfig.updateConfig || getDefaultUpdateConfig());
});

router.put('/update-config', authMiddleware, requirePermission('config.edit'), async (req, res) => {
  const configPath = path.join(config.serverPath, 'config.json');
  const serverConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  serverConfig.updateConfig = {
    ...serverConfig.updateConfig,
    ...req.body
  };
  await fs.writeFile(configPath, JSON.stringify(serverConfig, null, 2));
  res.json({ success: true });
});

function getDefaultUpdateConfig() {
  return {
    enabled: true,
    checkIntervalSeconds: 3600,
    notifyPlayersOnAvailable: true,
    patchline: 'release',
    runBackupBeforeUpdate: true,
    backupConfigBeforeUpdate: true,
    autoApplyMode: 'DISABLED',
    autoApplyDelayMinutes: 5
  };
}
```

**Frontend-Änderungen:**

Datei: `manager/frontend/src/views/Configuration.vue`

Neue Komponente oder Sektion für Update-Config:

```vue
<template>
  <div class="card">
    <div class="card-header">
      <h3>🔄 Update Configuration</h3>
    </div>
    <div class="card-body space-y-4">
      <!-- Enable Updates -->
      <div class="flex items-center justify-between">
        <label>Enable Auto-Updates</label>
        <toggle v-model="updateConfig.enabled" />
      </div>

      <!-- Check Interval -->
      <div>
        <label>Check Interval (seconds)</label>
        <input type="number" v-model="updateConfig.checkIntervalSeconds" min="60" />
        <span class="text-gray-400">{{ formatInterval(updateConfig.checkIntervalSeconds) }}</span>
      </div>

      <!-- Patchline -->
      <div>
        <label>Patchline</label>
        <select v-model="updateConfig.patchline">
          <option value="release">Release (Stable)</option>
          <option value="pre-release">Pre-Release (Beta)</option>
        </select>
      </div>

      <!-- Notify Players -->
      <div class="flex items-center justify-between">
        <label>Notify players when update available</label>
        <toggle v-model="updateConfig.notifyPlayersOnAvailable" />
      </div>

      <!-- Auto-Apply Mode -->
      <div>
        <label>Auto-Apply Mode</label>
        <select v-model="updateConfig.autoApplyMode">
          <option value="DISABLED">Disabled - Manual only</option>
          <option value="WHEN_EMPTY">When Empty - No players online</option>
          <option value="SCHEDULED">Scheduled - After delay</option>
        </select>
      </div>

      <!-- Auto-Apply Delay (nur bei SCHEDULED) -->
      <div v-if="updateConfig.autoApplyMode === 'SCHEDULED'">
        <label>Auto-Apply Delay (minutes)</label>
        <input type="number" v-model="updateConfig.autoApplyDelayMinutes" min="1" />
      </div>

      <!-- Backup Options -->
      <div class="border-t pt-4 mt-4">
        <h4 class="font-semibold mb-2">Backup Options</h4>
        <div class="flex items-center justify-between mb-2">
          <label>Backup server before update</label>
          <toggle v-model="updateConfig.runBackupBeforeUpdate" />
        </div>
        <div class="flex items-center justify-between">
          <label>Backup config before update</label>
          <toggle v-model="updateConfig.backupConfigBeforeUpdate" />
        </div>
      </div>

      <button @click="saveUpdateConfig" class="btn btn-primary">
        Save Update Settings
      </button>
    </div>
  </div>
</template>
```

---

### 2.2 Dashboard - Update Management

**Ziel:** Erweiterte Update-Verwaltung im Dashboard mit Aktions-Buttons.

**Konzept:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔄 Hytale Server Updates                         [⚙️ Settings] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Installed Version    Latest Available    Patchline            │
│  ┌─────────────┐      ┌─────────────┐     ┌──────────────┐     │
│  │   0.5.123   │      │   0.5.125   │     │   Release    │     │
│  └─────────────┘      └─────────────┘     └──────────────┘     │
│                                                                 │
│  ⚠️ Update available! Version 0.5.125 is ready.                │
│                                                                 │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────┐          │
│  │ Check Now  │  │  Download  │  │ Apply & Restart  │          │
│  └────────────┘  └────────────┘  └──────────────────┘          │
│                                                                 │
│  Download Progress:                                             │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 67%              │
│  Downloading: Server/HytaleServer.jar (45 MB / 67 MB)          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Auto-Update: When Empty │ Next Check: in 45 minutes     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Implementierung:**

Die Buttons senden Befehle über die bestehende Konsolen-API:

```typescript
// In Dashboard.vue oder neue UpdateCard.vue Komponente

async function checkForUpdates() {
  await serverApi.sendCommand('/update check');
  // Parse console output für Status
}

async function downloadUpdate() {
  await serverApi.sendCommand('/update download');
  // Polling für Download-Fortschritt
}

async function applyUpdate() {
  if (confirm('Server will restart to apply update. Continue?')) {
    await serverApi.sendCommand('/update apply');
  }
}

async function cancelDownload() {
  await serverApi.sendCommand('/update cancel');
}
```

**Alternative: Direkter API-Ansatz**

Neuer Backend-Endpoint der Befehle ausführt und Output parsed:

```typescript
// manager/backend/src/routes/server.ts

router.post('/native-update/check', authMiddleware, requirePermission('server.restart'), async (req, res) => {
  const result = await dockerService.execCommand('/update check');
  // Parse output für strukturierte Antwort
  res.json({
    updateAvailable: result.includes('Update available'),
    currentVersion: extractVersion(result, 'current'),
    latestVersion: extractVersion(result, 'latest'),
    rawOutput: result
  });
});

router.post('/native-update/download', ...);
router.post('/native-update/apply', ...);
router.post('/native-update/cancel', ...);
router.get('/native-update/status', ...);
```

---

### 2.3 Permission Editor - Neue Permissions

**Ziel:** Die neuen Hytale Permissions im Permission Editor verfügbar machen.

**Datei:** `manager/frontend/src/views/Permissions.vue`

```typescript
// Erweitere PERMISSION_CATEGORIES

const PERMISSION_CATEGORIES = [
  // ... bestehende Kategorien ...

  {
    name: 'World Map',
    icon: 'map',
    permissions: [
      {
        key: 'hytale:world_map_coordinate_teleport',
        label: 'Coordinate Teleport',
        description: 'Allow teleporting to coordinates via world map'
      },
      {
        key: 'hytale:world_map_marker_teleport',
        label: 'Marker Teleport',
        description: 'Allow teleporting to markers via world map'
      }
    ]
  },
  {
    name: 'Updates',
    icon: 'refresh',
    permissions: [
      {
        key: 'hytale:update_notify',
        label: 'Update Notifications',
        description: 'Receive notifications when updates are available'
      }
    ]
  }
];
```

---

### 2.4 Downloader vs. Native Update System

**Problem:** Wir haben jetzt zwei Update-Systeme:
1. Unser `hytale-downloader` (OAuth-basiert, extern)
2. Hytales natives `UpdateModule` (im Server integriert)

**Lösung - Aufgabenteilung:**

| Aufgabe | System | Grund |
|---------|--------|-------|
| Erstinstallation | Downloader | Server existiert noch nicht |
| Patchline-Wechsel | Downloader | Komplett neuer Download nötig |
| Server offline Update | Downloader | Natives System braucht laufenden Server |
| Automatische Updates | Native | Besser integriert, Spieler-Benachrichtigung |
| Laufzeit-Updates | Native | Staged Updates, Backup, etc. |

**Code-Anpassung:**

```typescript
// In Dashboard.vue - checkForUpdates()

async function checkForUpdates() {
  // Prüfe ob Server läuft
  if (serverStatus.running) {
    // Nutze natives Update-System
    const result = await serverApi.nativeUpdateCheck();
    updateInfo.value = result;
  } else {
    // Server offline - nutze Downloader
    const result = await serverApi.checkForUpdates(); // Bestehende Funktion
    updateInfo.value = result;
  }
}
```

**Downloader Auth Warning anpassen:**

Die Warnung im Dashboard sollte nur erscheinen wenn:
- Server nicht läuft UND
- Downloader-Auth fehlt/abgelaufen

Wenn der Server läuft, nutzen wir das native System und brauchen keine Downloader-Auth.

---

### 2.5 Docker/Infrastructure Anpassungen

**Exit Code 8 Handling:**

Datei: `docker/entrypoint.sh` oder `docker-compose.yml`

```bash
#!/bin/bash
# entrypoint.sh

while true; do
    # Start server
    java -jar /opt/hytale/server/HytaleServer.jar "$@"
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 8 ]; then
        echo "[Entrypoint] Server requested restart for update (exit code 8)"
        # Kurze Pause für Cleanup
        sleep 2
        continue  # Neustart
    fi

    # Anderer Exit Code = Beenden
    exit $EXIT_CODE
done
```

**Docker Compose Anpassung:**

```yaml
services:
  hytale-server:
    # ...
    restart: "no"  # Wir handhaben Restarts selbst im entrypoint
    # ODER
    restart: on-failure  # Neustart nur bei Fehler, nicht bei 0 oder 8
```

**Staged Updates Verzeichnis:**

Volume für `updater/` Verzeichnis hinzufügen:

```yaml
volumes:
  - ./server:/opt/hytale/server
  - ./updater:/opt/hytale/updater  # Für staged updates; neben dem Server-Ordner, der Server sucht ../updater
```

---

### 2.6 Scheduler Integration (Optional)

**Ziel:** Update-Checks in den Scheduler integrieren.

**Neuer Scheduler-Task-Typ:**

```typescript
interface UpdateCheckTask {
  type: 'update_check';
  enabled: boolean;
  schedule: string; // Cron expression
  autoDownload: boolean;
  autoApplyWhenEmpty: boolean;
  announceBeforeApply: boolean;
  announceMinutes: number;
}
```

**UI im Scheduler:**

```
┌─────────────────────────────────────────────────────┐
│ 🔄 Scheduled Update Checks                          │
├─────────────────────────────────────────────────────┤
│ ☑ Enable scheduled update checks                    │
│                                                     │
│ Schedule: [0 4 * * *] (Every day at 04:00)         │
│                                                     │
│ ☑ Auto-download if update available                │
│ ☑ Auto-apply when no players online                │
│ ☑ Announce 5 minutes before restart                │
└─────────────────────────────────────────────────────┘
```

---

## 3. Implementierungs-Phasen

### Phase 1: Grundlagen (Priorität: HOCH)
- [ ] UpdateConfig Endpoint im Backend
- [ ] UpdateConfig UI im Configuration Editor
- [ ] Neue Permissions im Permission Editor

### Phase 2: Dashboard Integration (Priorität: HOCH)
- [ ] Native Update Status Endpoint
- [ ] Update-Buttons im Dashboard (Check, Download, Apply)
- [ ] Download-Fortschrittsanzeige

### Phase 3: System-Integration (Priorität: MITTEL)
- [ ] Downloader/Native System Logik
- [ ] Downloader Auth Warning anpassen
- [ ] Exit Code 8 im Docker Handling

### Phase 4: Erweiterungen (Priorität: NIEDRIG)
- [ ] Scheduler Update-Tasks
- [ ] Update-History/Log
- [ ] Rollback-Funktion (aus updater/backup/)

---

## 4. Offene Fragen

1. **Wie parsed man den Output von `/update status`?**
   - Brauchen wir Regex-Pattern oder gibt es strukturierte Ausgabe?

2. **Wie erkennt man Download-Fortschritt?**
   - Polling via `/update status`?
   - WebSocket für Live-Updates?

3. **Soll der Scheduler das native System oder eigene Logik nutzen?**
   - Native: `autoApplyMode: SCHEDULED`
   - Eigene: Mehr Kontrolle, aber Duplikation

4. **Wie verhält sich das native System bei Mod-Updates?**
   - Werden Mods überschrieben?
   - Brauchen wir Backup-Warnungen?

---

## 5. Risiken und Mitigationen

| Risiko | Mitigation |
|--------|------------|
| Natives System ändert sich in zukünftigen Updates | Abstraktionsschicht, Feature-Detection |
| Doppelte Update-Systeme verwirren User | Klare UI-Trennung, Tooltips |
| Exit Code 8 wird nicht korrekt behandelt | Logging, Fallback auf manuellen Restart |
| Download-Fortschritt nicht trackbar | Fallback auf "Download läuft..." ohne Prozent |

---

## 6. Zusammenfassung

Die Integration des nativen Hytale Update-Systems bietet:
- **Bessere UX:** Spieler-Benachrichtigungen, Staged Updates
- **Mehr Sicherheit:** Automatische Backups vor Updates
- **Weniger Wartung:** Hytale pflegt das System
- **Flexibilität:** Kombination aus nativem und Downloader-System

Die Implementierung erfolgt schrittweise, wobei Phase 1 und 2 die wichtigsten Features abdecken.
