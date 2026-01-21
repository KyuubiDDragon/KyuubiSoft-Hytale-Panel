# Features

Vollständige Übersicht aller Funktionen des KyuubiSoft Hytale Panels.

---

## Dashboard

Das Dashboard bietet einen schnellen Überblick über den Serverstatus:

- **Server-Status** - Online/Offline mit Uptime
- **Spieleranzahl** - Aktuelle und maximale Spieler
- **Ressourcenverbrauch** - CPU und RAM in Echtzeit
- **Quick Actions** - Start, Stop, Restart Buttons
- **Aktivitäts-Feed** - Letzte Admin-Aktionen

---

## Live Konsole

Echtzeit-Serverprotokollierung mit erweiterten Funktionen:

### Funktionen
- **Echtzeit-Logs** - Live-Streaming via WebSocket
- **Log-Filterung** - Nach Level (INFO, WARN, ERROR)
- **Suchfunktion** - Durchsuchen der Logs
- **Auto-Scroll** - Automatisches Scrollen zu neuen Einträgen
- **Befehlshistorie** - Zugriff auf vorherige Befehle
- **Kopieren** - Logs in Zwischenablage kopieren
- **Alle Logs laden** - Bis zu 10.000 Zeilen

### Befehle ausführen
```
/say Hallo Welt!
/time set day
/weather clear
```

---

## Performance Monitor

Detaillierte Leistungsüberwachung:

### Metriken
| Metrik | Beschreibung |
|--------|--------------|
| CPU | Prozessorauslastung in % |
| RAM | Speicherverbrauch (Used/Total) |
| JVM Heap | Java Heap Memory |
| TPS | Ticks Per Second (mit Plugin) |
| MSPT | Milliseconds Per Tick |

### Grafiken
- Echtzeit-Graphen mit Verlauf
- Anpassbarer Zeitraum
- Export-Funktionalität

---

## Spielerverwaltung

Umfassende Spielerverwaltung mit allen notwendigen Aktionen:

### Spielerliste
- **Online-Spieler** - Aktuell verbundene Spieler
- **Offline-Spieler** - Alle jemals beigetretenen Spieler
- **Suchfunktion** - Schnelle Spielersuche

### Spieleraktionen

| Aktion | Beschreibung | Berechtigung |
|--------|--------------|--------------|
| **Kick** | Spieler vom Server werfen | `players.kick` |
| **Ban** | Spieler dauerhaft sperren | `players.ban` |
| **Unban** | Sperre aufheben | `players.unban` |
| **Teleport** | Zu Koordinaten/Spieler teleportieren | `players.teleport` |
| **Gamemode** | Spielmodus ändern (Creative/Adventure) | `players.gamemode` |
| **Give** | Items geben | `players.give` |
| **Heal** | Spieler heilen | `players.heal` |
| **Kill** | Spieler töten | `players.kill` |
| **Respawn** | Spieler respawnen | `players.respawn` |
| **Effekte** | Status-Effekte anwenden/entfernen | `players.effects` |
| **Inventar leeren** | Inventar löschen | `players.clear_inventory` |
| **Nachricht** | Private Nachricht senden | `players.message` |

### Spielerdetails (mit Plugin)
- **Übersicht** - Name, UUID, Position, Gamemode
- **Inventar** - Item-Anzeige mit Icons
- **Aussehen** - Spieler-Skin/Appearance
- **Chat-Verlauf** - Alle Nachrichten des Spielers
- **Todespositionen** - Letzte Todespunkte mit Teleport-Option

---

## Spielerstatistiken

Detaillierte Statistiken und Analysen:

- **Top-Spieler** - Nach Spielzeit sortiert
- **Spielzeit-Tracking** - Gesamtspielzeit pro Spieler
- **Aktivitätstrends** - Tägliche/Wöchentliche Aktivität
- **Engagement-Metriken** - Durchschnittliche Sitzungsdauer

---

## Chat-System

Vollständiges Chat-Management:

- **Globaler Chat** - Alle Nachrichten
- **Spieler-Chat** - Nachrichten nach Spieler gefiltert
- **Zeitfilter** - 7/14/30 Tage oder alle
- **Suchfunktion** - Nach Inhalt suchen
- **UUID-Tracking** - Spieler über Namensänderungen verfolgen

---

## Whitelist & Bans

Zugriffskontrolle für den Server:

### Whitelist
- Spieler zur Whitelist hinzufügen/entfernen
- Whitelist aktivieren/deaktivieren
- Import/Export Funktionalität

### Banlist
- Spieler bannen/entbannen
- Ban-Grund angeben
- Ban-Historie anzeigen

---

## Backup-System

Robustes Backup-Management:

### Manuelle Backups
- **Backup erstellen** - Mit optionalem Namen
- **Backup wiederherstellen** - Vollständige Wiederherstellung
- **Backup herunterladen** - Als .tar.gz Archiv
- **Backup löschen** - Alte Backups entfernen

### Automatische Backups
- Im Scheduler konfigurierbar
- Retention Policy (Anzahl aufbewahren)
- Zeitgesteuerte Erstellung

### Backup-Inhalt
- Weltdaten
- Spielerdaten
- Konfigurationsdateien
- Mods & Plugins

---

## Scheduler

Automatisierte Aufgaben und Planung:

### Auto-Backups
- Zeitplan konfigurieren
- Aufbewahrungsrichtlinie
- Benachrichtigungen

### Auto-Restart
- Geplante Neustarts
- Countdown-Warnungen
- Spielerbenachrichtigung vor Restart

### Server Broadcasts
- Geplante Ankündigungen
- Wiederkehrende Nachrichten
- Ereignisbasierte Broadcasts

### Quick Commands
- Benutzerdefinierte Schnellbefehle
- Ein-Klick-Ausführung
- Kategorisierung

---

## Welten-Verwaltung

Übersicht aller Serverwelten:

- **Weltliste** - Alle geladenen Welten
- **Weltstatistiken** - Größe, Spieleranzahl
- **Weltinformationen** - Seed, Spawn-Position

---

## Mods & Plugins

### Mod-Verwaltung
- **Upload** - .jar Dateien hochladen
- **Aktivieren/Deaktivieren** - Mods ein-/ausschalten
- **Konfiguration** - Mod-Config-Dateien bearbeiten
- **Löschen** - Mods entfernen

### Plugin-Verwaltung
- Gleiche Funktionen wie Mods
- Separate Plugin-Ordner

### Mod-Stores
- **Modtale Integration** - Mods durchsuchen und installieren
- **StackMart Integration** - Ressourcen entdecken

---

## Asset Explorer

Durchsuchen und Analysieren von Hytale-Assets:

### Funktionen
- **Verzeichnis-Browser** - Navigieren durch Assets
- **Datei-Viewer** - JSON, Bilder, Text, Hex
- **Suche** - Plaintext, Glob, Regex
- **Download** - Assets herunterladen

### Unterstützte Formate
- JSON-Dateien mit Syntax-Highlighting
- Bilder (PNG, JPG, etc.)
- Textdateien
- Binärdateien (Hex-Ansicht)

---

## Konfigurationseditor

Server-Konfiguration direkt bearbeiten:

### Unterstützte Formate
- JSON
- Properties
- YAML
- TOML
- INI

### Funktionen
- Syntax-Highlighting
- Validierung
- Backup vor Änderungen

---

## WebMap Integration

Live-Serverkarte mit EasyWebMap Mod:

- **Echtzeit-Karte** - Live-Ansicht der Welt
- **Spielerpositionen** - Spieler auf der Karte
- **Zonen/Regionen** - Gebiete anzeigen
- **HTTPS-Proxy** - Über Panel proxied

Zugriff: `http://dein-server:18081`

---

## Aktivitätsprotokoll

Vollständige Audit-Trail aller Admin-Aktionen:

### Protokollierte Aktionen
- Benutzer-Logins
- Server Start/Stop/Restart
- Spieleraktionen (Kick, Ban, etc.)
- Konfigurationsänderungen
- Backup-Operationen
- Benutzer/Rollen-Änderungen

### Funktionen
- Filterung nach Kategorie
- Filterung nach Benutzer
- Zeitstempel
- Erfolg/Fehlschlag Status

---

## Hytale Auth

Verwaltung der Server-Authentifizierung:

- **Device Login** - OAuth-Authentifizierung
- **Status anzeigen** - Authentifizierungsstatus
- **Credentials zurücksetzen** - Bei Problemen
- **Persistence-Modus** - Memory oder Encrypted

---

## Offizieller Downloader

Automatischer Server-Download:

- **Automatischer Download** - Server-Dateien herunterladen
- **Patchline wählen** - Release oder Pre-Release
- **Update-Check** - Auf neue Versionen prüfen
- **Auto-Update** - Automatische Updates (optional)

---

## Mehrsprachigkeit

Das Panel unterstützt mehrere Sprachen:

| Sprache | Code |
|---------|------|
| Deutsch | `de` |
| Englisch | `en` |
| Portugiesisch | `pt` |

Sprachauswahl im Panel unter **Settings**.

---

## Nächste Schritte

- [[Benutzerverwaltung]] - Benutzer und Rollen einrichten
- [[API-Dokumentation]] - REST API nutzen
- [[Server-Befehle]] - Alle verfügbaren Befehle
