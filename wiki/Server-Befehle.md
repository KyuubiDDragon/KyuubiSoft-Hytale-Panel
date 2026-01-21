# Server-Befehle

Vollständige Referenz aller Hytale Server-Befehle.

---

## Übersicht

Der Hytale Server unterstützt über 100 Befehle in verschiedenen Kategorien. Diese können über die Live-Konsole im Panel oder direkt im Spiel ausgeführt werden.

---

## Authentifizierung & Server

### /auth
Verwaltet die Server-Authentifizierung.

```
/auth login device     - Startet Device-Login-Flow
/auth login browser    - Öffnet Browser-Login
/auth logout           - Meldet Server ab
/auth status           - Zeigt Auth-Status
```

### /server
Server-Verwaltungsbefehle.

```
/server start          - Startet den Server
/server stop           - Stoppt den Server
/server restart        - Startet neu
/server status         - Zeigt Status
```

### /save
Welt-Speicherung.

```
/save                  - Speichert alle Welten
/save-all              - Speichert alles
/save-on               - Aktiviert Auto-Save
/save-off              - Deaktiviert Auto-Save
```

### /stop
Stoppt den Server ordnungsgemäß.

```
/stop                  - Stoppt den Server
```

### /reload
Lädt Konfigurationen neu.

```
/reload                - Lädt alle Configs neu
```

---

## Spielerverwaltung

### /kick
Entfernt einen Spieler vom Server.

```
/kick <spieler> [grund]
/kick Spieler1 "AFK zu lange"
```

### /ban
Sperrt einen Spieler dauerhaft.

```
/ban <spieler> [grund]
/ban Cheater123 "Hacking"
```

### /unban / /pardon
Hebt eine Sperre auf.

```
/unban <spieler>
/pardon <spieler>
```

### /banlist
Zeigt alle gesperrten Spieler.

```
/banlist
```

### /whitelist
Verwaltet die Whitelist.

```
/whitelist add <spieler>
/whitelist remove <spieler>
/whitelist list
/whitelist on
/whitelist off
```

### /op
Gibt einem Spieler Operator-Rechte.

```
/op <spieler>
```

### /deop
Entfernt Operator-Rechte.

```
/deop <spieler>
```

### /list
Zeigt online Spieler.

```
/list
```

---

## Teleportation

### /tp / /teleport
Teleportiert Spieler.

```
/tp <ziel>                    - Teleportiert zu Spieler
/tp <spieler> <ziel>          - Teleportiert Spieler zu Ziel
/tp <x> <y> <z>               - Teleportiert zu Koordinaten
/tp <spieler> <x> <y> <z>     - Teleportiert Spieler zu Koordinaten
```

**Beispiele:**
```
/tp Spieler1
/tp Spieler1 Spieler2
/tp 100 64 -200
/tp Spieler1 100 64 -200
/tp ~ ~10 ~                   - 10 Blöcke nach oben
```

### /spawn
Teleportiert zum Spawnpunkt.

```
/spawn                        - Eigener Spawn
/spawn <spieler>              - Spieler zum Spawn
```

### /home
Teleportiert nach Hause (wenn gesetzt).

```
/home
/sethome
```

---

## Spielmodus & Effekte

### /gamemode / /gm
Ändert den Spielmodus.

```
/gamemode <modus> [spieler]
/gm <modus> [spieler]
```

**Modi:**
- `creative` / `c` - Kreativmodus
- `adventure` / `a` - Abenteuermodus

**Beispiele:**
```
/gamemode creative
/gm c Spieler1
/gamemode adventure
```

### /effect
Wendet Statuseffekte an.

```
/effect give <spieler> <effekt> [dauer] [stärke]
/effect clear <spieler> [effekt]
```

**Beispiele:**
```
/effect give Spieler1 speed 60 2
/effect clear Spieler1
/effect clear Spieler1 speed
```

### /heal
Heilt einen Spieler vollständig.

```
/heal [spieler]
/heal Spieler1
```

### /kill
Tötet einen Spieler.

```
/kill [spieler]
/kill Spieler1
```

### /respawn
Lässt einen Spieler respawnen.

```
/respawn <spieler>
```

---

## Items & Inventar

### /give
Gibt Items an Spieler.

```
/give <spieler> <item> [anzahl]
```

**Beispiele:**
```
/give Spieler1 Cobalt_Sword 1
/give Spieler1 hytale:Iron_Pickaxe 5
/give Spieler1 Torch 64
```

### /clear
Leert das Inventar.

```
/clear [spieler] [item] [anzahl]
/clear Spieler1
/clear Spieler1 Cobalt_Sword
```

---

## Welt & Zeit

### /time
Steuert die Tageszeit.

```
/time set <zeit>
/time add <wert>
/time query <typ>
```

**Zeiten:**
- `day` - Tag (1000)
- `noon` - Mittag (6000)
- `night` - Nacht (13000)
- `midnight` - Mitternacht (18000)

**Beispiele:**
```
/time set day
/time set 6000
/time add 1000
/time query daytime
```

### /weather
Steuert das Wetter.

```
/weather <typ> [dauer]
```

**Typen:**
- `clear` - Klar
- `rain` - Regen
- `thunder` - Gewitter

**Beispiele:**
```
/weather clear
/weather rain 600
/weather thunder
```

### /world
Weltbezogene Befehle.

```
/world list                   - Zeigt Welten
/world <welt>                 - Wechselt Welt
```

### /difficulty
Setzt die Schwierigkeit.

```
/difficulty <stufe>
```

### /seed
Zeigt den Welt-Seed.

```
/seed
```

---

## Blöcke & Strukturen

### /setblock
Setzt einen Block.

```
/setblock <x> <y> <z> <block>
```

**Beispiele:**
```
/setblock 100 64 100 stone
/setblock ~ ~ ~ air
```

### /fill
Füllt einen Bereich.

```
/fill <x1> <y1> <z1> <x2> <y2> <z2> <block>
```

**Beispiele:**
```
/fill 0 60 0 10 70 10 stone
/fill ~-5 ~ ~-5 ~5 ~10 ~5 air
```

### /summon
Spawnt eine Entität.

```
/summon <entität> [x] [y] [z]
```

---

## Kommunikation

### /say
Sendet eine Server-Nachricht.

```
/say <nachricht>
```

**Beispiel:**
```
/say Willkommen auf dem Server!
```

### /tell / /msg / /whisper
Private Nachricht an Spieler.

```
/tell <spieler> <nachricht>
/msg <spieler> <nachricht>
```

### /broadcast / /bc
Server-weite Ankündigung.

```
/broadcast <nachricht>
/bc <nachricht>
```

---

## Information

### /help
Zeigt Hilfe.

```
/help [befehl]
/help kick
```

### /version
Zeigt Server-Version.

```
/version
```

### /tps
Zeigt Ticks per Second (Performance).

```
/tps
```

---

## Erlaubte Befehle im Panel

Das Panel erlaubt aus Sicherheitsgründen nur diese Befehle:

```
/kick, /ban, /unban, /whitelist, /tp, /teleport, /give,
/time, /weather, /say, /tell, /msg, /kill, /heal,
/gamemode, /gm, /effect, /clear, /op, /deop, /pardon,
/difficulty, /seed, /list, /stop, /save-all, /save-off,
/save-on, /setblock, /fill, /summon, /spawn, /respawn,
/world, /reload, /broadcast, /bc, /help, /version, /tps
```

---

## Relative Koordinaten

Befehle unterstützen relative Koordinaten mit `~`:

| Syntax | Bedeutung |
|--------|-----------|
| `~` | Aktuelle Position |
| `~5` | Aktuelle Position + 5 |
| `~-5` | Aktuelle Position - 5 |

**Beispiele:**
```
/tp ~ ~10 ~              - 10 Blöcke hoch
/tp ~5 ~ ~-5             - 5 nach Osten, 5 nach Norden
/setblock ~ ~-1 ~ stone  - Block unter dir
```

---

## Befehle im Panel ausführen

1. Öffne **Console** im Panel
2. Gib den Befehl ein (mit `/`)
3. Drücke Enter

**Oder via Quick Commands:**
1. Öffne **Scheduler** → **Quick Commands**
2. Erstelle Schnellbefehl
3. Ein-Klick-Ausführung

---

## Nächste Schritte

- [[Features]] - Spielerverwaltung im Panel
- [[API-Dokumentation]] - Befehle via API
- [[Fehlerbehebung]] - Bei Befehlsproblemen
