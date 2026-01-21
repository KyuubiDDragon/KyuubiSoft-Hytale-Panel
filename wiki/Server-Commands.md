# Server Commands

Complete reference for all Hytale server commands.

---

## Overview

The Hytale server supports over 100 commands in various categories. These can be executed via the Live Console in the panel or directly in-game.

---

## Authentication & Server

### /auth
Manages server authentication.

```
/auth login device     - Starts device login flow
/auth login browser    - Opens browser login
/auth logout           - Logs out server
/auth status           - Shows auth status
```

### /server
Server management commands.

```
/server start          - Starts the server
/server stop           - Stops the server
/server restart        - Restarts server
/server status         - Shows status
```

### /save
World saving.

```
/save                  - Saves all worlds
/save-all              - Saves everything
/save-on               - Enables auto-save
/save-off              - Disables auto-save
```

### /stop
Stops the server gracefully.

```
/stop                  - Stops the server
```

### /reload
Reloads configurations.

```
/reload                - Reloads all configs
```

---

## Player Management

### /kick
Removes a player from the server.

```
/kick <player> [reason]
/kick Player1 "AFK too long"
```

### /ban
Permanently bans a player.

```
/ban <player> [reason]
/ban Cheater123 "Hacking"
```

### /unban / /pardon
Removes a ban.

```
/unban <player>
/pardon <player>
```

### /banlist
Shows all banned players.

```
/banlist
```

### /whitelist
Manages the whitelist.

```
/whitelist add <player>
/whitelist remove <player>
/whitelist list
/whitelist on
/whitelist off
```

### /op
Gives a player operator rights.

```
/op <player>
```

### /deop
Removes operator rights.

```
/deop <player>
```

### /list
Shows online players.

```
/list
```

---

## Teleportation

### /tp / /teleport
Teleports players.

```
/tp <target>                    - Teleport to player
/tp <player> <target>           - Teleport player to target
/tp <x> <y> <z>                 - Teleport to coordinates
/tp <player> <x> <y> <z>        - Teleport player to coordinates
```

**Examples:**
```
/tp Player1
/tp Player1 Player2
/tp 100 64 -200
/tp Player1 100 64 -200
/tp ~ ~10 ~                     - 10 blocks up
```

### /spawn
Teleports to spawn point.

```
/spawn                          - Own spawn
/spawn <player>                 - Player to spawn
```

### /home
Teleports home (if set).

```
/home
/sethome
```

---

## Game Mode & Effects

### /gamemode / /gm
Changes game mode.

```
/gamemode <mode> [player]
/gm <mode> [player]
```

**Modes:**
- `creative` / `c` - Creative mode
- `adventure` / `a` - Adventure mode

**Examples:**
```
/gamemode creative
/gm c Player1
/gamemode adventure
```

### /effect
Applies status effects.

```
/effect give <player> <effect> [duration] [strength]
/effect clear <player> [effect]
```

**Examples:**
```
/effect give Player1 speed 60 2
/effect clear Player1
/effect clear Player1 speed
```

### /heal
Fully heals a player.

```
/heal [player]
/heal Player1
```

### /kill
Kills a player.

```
/kill [player]
/kill Player1
```

### /respawn
Respawns a player.

```
/respawn <player>
```

---

## Items & Inventory

### /give
Gives items to players.

```
/give <player> <item> [amount]
```

**Examples:**
```
/give Player1 Cobalt_Sword 1
/give Player1 hytale:Iron_Pickaxe 5
/give Player1 Torch 64
```

### /clear
Clears inventory.

```
/clear [player] [item] [amount]
/clear Player1
/clear Player1 Cobalt_Sword
```

---

## World & Time

### /time
Controls time of day.

```
/time set <time>
/time add <value>
/time query <type>
```

**Times:**
- `day` - Day (1000)
- `noon` - Noon (6000)
- `night` - Night (13000)
- `midnight` - Midnight (18000)

**Examples:**
```
/time set day
/time set 6000
/time add 1000
/time query daytime
```

### /weather
Controls weather.

```
/weather <type> [duration]
```

**Types:**
- `clear` - Clear
- `rain` - Rain
- `thunder` - Thunderstorm

**Examples:**
```
/weather clear
/weather rain 600
/weather thunder
```

### /world
World-related commands.

```
/world list                     - Shows worlds
/world <world>                  - Switches world
```

### /difficulty
Sets difficulty.

```
/difficulty <level>
```

### /seed
Shows world seed.

```
/seed
```

---

## Blocks & Structures

### /setblock
Sets a block.

```
/setblock <x> <y> <z> <block>
```

**Examples:**
```
/setblock 100 64 100 stone
/setblock ~ ~ ~ air
```

### /fill
Fills an area.

```
/fill <x1> <y1> <z1> <x2> <y2> <z2> <block>
```

**Examples:**
```
/fill 0 60 0 10 70 10 stone
/fill ~-5 ~ ~-5 ~5 ~10 ~5 air
```

### /summon
Spawns an entity.

```
/summon <entity> [x] [y] [z]
```

---

## Communication

### /say
Sends a server message.

```
/say <message>
```

**Example:**
```
/say Welcome to the server!
```

### /tell / /msg / /whisper
Private message to player.

```
/tell <player> <message>
/msg <player> <message>
```

### /broadcast / /bc
Server-wide announcement.

```
/broadcast <message>
/bc <message>
```

---

## Information

### /help
Shows help.

```
/help [command]
/help kick
```

### /version
Shows server version.

```
/version
```

### /tps
Shows Ticks per Second (performance).

```
/tps
```

---

## Allowed Commands in Panel

The panel only allows these commands for security reasons:

```
/kick, /ban, /unban, /whitelist, /tp, /teleport, /give,
/time, /weather, /say, /tell, /msg, /kill, /heal,
/gamemode, /gm, /effect, /clear, /op, /deop, /pardon,
/difficulty, /seed, /list, /stop, /save-all, /save-off,
/save-on, /setblock, /fill, /summon, /spawn, /respawn,
/world, /reload, /broadcast, /bc, /help, /version, /tps
```

---

## Relative Coordinates

Commands support relative coordinates with `~`:

| Syntax | Meaning |
|--------|---------|
| `~` | Current position |
| `~5` | Current position + 5 |
| `~-5` | Current position - 5 |

**Examples:**
```
/tp ~ ~10 ~              - 10 blocks up
/tp ~5 ~ ~-5             - 5 east, 5 north
/setblock ~ ~-1 ~ stone  - Block below you
```

---

## Execute Commands in Panel

1. Open **Console** in panel
2. Enter command (with `/`)
3. Press Enter

**Or via Quick Commands:**
1. Open **Scheduler** → **Quick Commands**
2. Create quick command
3. One-click execution

---

## Next Steps

- [[Features]] - Player management in panel
- [[API-Documentation]] - Commands via API
- [[Troubleshooting]] - For command issues
