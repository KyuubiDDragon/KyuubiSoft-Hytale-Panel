# Benutzerverwaltung

Anleitung zur Verwaltung von Benutzern, Rollen und Berechtigungen.

---

## Übersicht

Das KyuubiSoft Hytale Panel bietet ein umfassendes Benutzerverwaltungssystem:

- **Multi-User Support** - Mehrere Administratoren möglich
- **Rollenbasierte Zugriffskontrolle (RBAC)** - 60+ granulare Berechtigungen
- **Benutzerdefinierte Rollen** - Eigene Rollen mit spezifischen Berechtigungen
- **Audit-Trail** - Alle Aktionen werden protokolliert

---

## Benutzer

### Benutzer erstellen

1. Navigiere zu **Users** im Panel
2. Klicke auf **Neuer Benutzer**
3. Fülle das Formular aus:
   - **Benutzername:** Eindeutiger Name
   - **Passwort:** Mindestens 8 Zeichen
   - **Rolle:** Zugewiesene Rolle

### Benutzer bearbeiten

1. Klicke auf den Benutzer in der Liste
2. Ändere Passwort oder Rolle
3. Speichern

### Benutzer löschen

1. Klicke auf das Löschen-Symbol
2. Bestätige die Löschung

> **Hinweis:** Du kannst dich nicht selbst löschen.

### Passwort-Anforderungen

- Mindestens 8 Zeichen
- Für Admins: 12+ Zeichen empfohlen
- Darf nicht `admin`, `password`, `123456` sein

---

## Rollen

### System-Rollen

Diese Rollen sind vordefiniert und können nicht gelöscht werden:

#### Administrator
- **Beschreibung:** Vollständiger Zugriff auf alle Funktionen
- **Berechtigungen:** `*` (Wildcard - alle Berechtigungen)
- **Farbe:** Rot

#### Moderator
- **Beschreibung:** Spielerverwaltung und Chat-Moderation
- **Berechtigungen:**
  - Dashboard anzeigen
  - Spieler anzeigen, kicken, bannen, entbannen
  - Chat anzeigen
  - Whitelist verwalten
- **Farbe:** Blau

#### Operator
- **Beschreibung:** Server-Management und technische Aufgaben
- **Berechtigungen:**
  - Dashboard anzeigen
  - Server starten, stoppen, neustarten
  - Konsole anzeigen und Befehle ausführen
  - Performance anzeigen
  - Backups verwalten
  - Scheduler verwalten
  - Konfiguration bearbeiten
- **Farbe:** Grün

#### Viewer
- **Beschreibung:** Nur-Lese-Zugriff
- **Berechtigungen:**
  - Dashboard anzeigen
  - Server-Status anzeigen
  - Spieler anzeigen
  - Chat anzeigen
  - Performance anzeigen
- **Farbe:** Grau

### Benutzerdefinierte Rollen

Du kannst eigene Rollen mit beliebigen Berechtigungskombinationen erstellen.

#### Rolle erstellen

1. Navigiere zu **Roles** im Panel
2. Klicke auf **Neue Rolle**
3. Fülle das Formular aus:
   - **Name:** Rollenname
   - **Beschreibung:** Was die Rolle macht
   - **Farbe:** Badge-Farbe (Hex-Code)
   - **Berechtigungen:** Auswählen

#### Beispiel: Helper-Rolle

```
Name: Helper
Beschreibung: Hilft Spielern bei Fragen
Farbe: #00FF00
Berechtigungen:
  - dashboard.view
  - players.view
  - players.message
  - chat.view
```

#### Beispiel: Builder-Rolle

```
Name: Builder
Beschreibung: Kann Welten bearbeiten
Farbe: #FFA500
Berechtigungen:
  - dashboard.view
  - server.view_status
  - console.view
  - console.execute
  - worlds.view
  - assets.view
```

---

## Berechtigungen

### Berechtigungskategorien

#### Dashboard
| Berechtigung | Beschreibung |
|--------------|--------------|
| `dashboard.view` | Dashboard anzeigen |

#### Server
| Berechtigung | Beschreibung |
|--------------|--------------|
| `server.view_status` | Server-Status anzeigen |
| `server.start` | Server starten |
| `server.stop` | Server stoppen |
| `server.restart` | Server neustarten |

#### Konsole
| Berechtigung | Beschreibung |
|--------------|--------------|
| `console.view` | Konsole/Logs anzeigen |
| `console.execute` | Befehle ausführen |

#### Performance
| Berechtigung | Beschreibung |
|--------------|--------------|
| `performance.view` | Performance-Metriken anzeigen |

#### Spieler
| Berechtigung | Beschreibung |
|--------------|--------------|
| `players.view` | Spielerliste anzeigen |
| `players.kick` | Spieler kicken |
| `players.ban` | Spieler bannen |
| `players.unban` | Spieler entbannen |
| `players.teleport` | Spieler teleportieren |
| `players.gamemode` | Spielmodus ändern |
| `players.give` | Items geben |
| `players.heal` | Spieler heilen |
| `players.kill` | Spieler töten |
| `players.respawn` | Spieler respawnen |
| `players.effects` | Effekte anwenden |
| `players.clear_inventory` | Inventar leeren |
| `players.message` | Private Nachricht senden |
| `players.op` | Operator-Status verwalten |
| `players.whitelist` | Whitelist verwalten |
| `players.edit` | Spielerdaten bearbeiten |

#### Chat
| Berechtigung | Beschreibung |
|--------------|--------------|
| `chat.view` | Chat-Verlauf anzeigen |
| `chat.delete` | Chat-Nachrichten löschen |

#### Backups
| Berechtigung | Beschreibung |
|--------------|--------------|
| `backups.view` | Backups anzeigen |
| `backups.create` | Backups erstellen |
| `backups.restore` | Backups wiederherstellen |
| `backups.delete` | Backups löschen |
| `backups.download` | Backups herunterladen |

#### Scheduler
| Berechtigung | Beschreibung |
|--------------|--------------|
| `scheduler.view` | Scheduler anzeigen |
| `scheduler.edit` | Scheduler bearbeiten |

#### Welten
| Berechtigung | Beschreibung |
|--------------|--------------|
| `worlds.view` | Welten anzeigen |

#### Mods
| Berechtigung | Beschreibung |
|--------------|--------------|
| `mods.view` | Mods anzeigen |
| `mods.install` | Mods installieren |
| `mods.delete` | Mods löschen |
| `mods.config` | Mod-Konfiguration bearbeiten |

#### Plugins
| Berechtigung | Beschreibung |
|--------------|--------------|
| `plugins.view` | Plugins anzeigen |
| `plugins.install` | Plugins installieren |
| `plugins.delete` | Plugins löschen |
| `plugins.config` | Plugin-Konfiguration bearbeiten |

#### Konfiguration
| Berechtigung | Beschreibung |
|--------------|--------------|
| `config.view` | Konfiguration anzeigen |
| `config.edit` | Konfiguration bearbeiten |

#### Assets
| Berechtigung | Beschreibung |
|--------------|--------------|
| `assets.view` | Assets durchsuchen |
| `assets.manage` | Assets verwalten (extrahieren) |

#### Benutzer
| Berechtigung | Beschreibung |
|--------------|--------------|
| `users.view` | Benutzer anzeigen |
| `users.create` | Benutzer erstellen |
| `users.edit` | Benutzer bearbeiten |
| `users.delete` | Benutzer löschen |

#### Rollen
| Berechtigung | Beschreibung |
|--------------|--------------|
| `roles.view` | Rollen anzeigen |
| `roles.manage` | Rollen erstellen/bearbeiten/löschen |

#### Aktivität
| Berechtigung | Beschreibung |
|--------------|--------------|
| `activity.view` | Aktivitätsprotokoll anzeigen |
| `activity.clear` | Aktivitätsprotokoll leeren |

#### Hytale Auth
| Berechtigung | Beschreibung |
|--------------|--------------|
| `hytale_auth.manage` | Hytale-Authentifizierung verwalten |

#### Einstellungen
| Berechtigung | Beschreibung |
|--------------|--------------|
| `settings.view` | Einstellungen anzeigen |
| `settings.edit` | Einstellungen bearbeiten |

---

## Wildcard-Berechtigung

Die `*` Berechtigung gewährt Zugriff auf ALLE Funktionen:

```
permissions: ["*"]
```

> **Warnung:** Nur für vertrauenswürdige Administratoren verwenden!

---

## Best Practices

### Prinzip der geringsten Berechtigung

Gib Benutzern nur die Berechtigungen, die sie wirklich benötigen:

```
❌ Schlecht: Allen Helfern Administrator-Rolle geben
✅ Gut: Benutzerdefinierte Helper-Rolle mit spezifischen Berechtigungen
```

### Rollenplanung

Plane deine Rollen vor der Erstellung:

| Rolle | Zweck | Berechtigungen |
|-------|-------|----------------|
| Admin | Server-Verwaltung | `*` |
| Moderator | Spieler-Moderation | players.*, chat.* |
| Helper | Spieler-Support | players.view, chat.view, players.message |
| Builder | Welt-Gestaltung | console.execute, worlds.view |

### Regelmäßige Überprüfung

- Überprüfe regelmäßig die Benutzerliste
- Entferne inaktive Benutzer
- Aktualisiere Rollen bei Bedarf

---

## Aktivitätsprotokoll

Alle Benutzeraktionen werden protokolliert:

### Anzeigen

1. Navigiere zu **Activity Log**
2. Filtere nach:
   - Kategorie (player, server, backup, etc.)
   - Benutzer
   - Zeitraum

### Protokollierte Aktionen

- Login/Logout
- Spieleraktionen (Kick, Ban, etc.)
- Server Start/Stop
- Konfigurationsänderungen
- Benutzer-/Rollenverwaltung
- Backup-Operationen

### Beispiel-Eintrag

```
2024-01-01 12:00:00 | admin | Spieler gekickt | Spieler1 | Grund: AFK
```

---

## API-Verwendung

### Benutzer via API erstellen

```bash
curl -X POST http://localhost:18080/api/auth/users \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "neuerbenutzer",
    "password": "sicherespasswort123",
    "roleId": "moderator"
  }'
```

### Rolle via API erstellen

```bash
curl -X POST http://localhost:18080/api/roles \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Helper",
    "description": "Hilft Spielern",
    "permissions": ["players.view", "chat.view", "players.message"],
    "color": "#00FF00"
  }'
```

---

## Fehlerbehebung

### Kann mich nicht einloggen

1. Prüfe Benutzername/Passwort
2. Prüfe ob Benutzer existiert
3. Prüfe Rate Limiting (5 Versuche / 15 Min)

### Berechtigung verweigert

1. Prüfe zugewiesene Rolle
2. Prüfe Rollenberechtigungen
3. Prüfe ob Berechtigung korrekt geschrieben

### Kann Rolle nicht löschen

- System-Rollen (Administrator, Moderator, Operator, Viewer) können nicht gelöscht werden
- Rolle muss keinem Benutzer zugewiesen sein

---

## Nächste Schritte

- [[Sicherheit]] - Mehr über Sicherheit
- [[Features]] - Alle Panel-Funktionen
- [[API-Dokumentation]] - API für Benutzerverwaltung
