<div align="center">

# Hytale Server Commands Documentation

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)
[![Discord](https://img.shields.io/badge/Discord-KyuubiDDragon-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com)

</div>

This document lists all available commands for the Hytale server. Commands can be executed through the Admin Panel console or directly in the server console.

## Table of Contents

- [Player Commands](#player-commands)
- [Administration Commands](#administration-commands)
- [World Commands](#world-commands)
- [Server Commands](#server-commands)
- [Teleportation Commands](#teleportation-commands)
- [Game Mechanics Commands](#game-mechanics-commands)
- [Debug Commands](#debug-commands)

---

## Player Commands

### Player Management

| Command | Description | Usage |
|---------|-------------|-------|
| `/kick` | Kick a player from the server | `/kick <player> [reason]` |
| `/ban` | Ban a player from the server | `/ban <player> [reason]` |
| `/unban` | Remove a player's ban | `/unban <player>` |
| `/op add` | Give operator permissions | `/op add <player>` |
| `/op remove` | Remove operator permissions | `/op remove <player>` |
| `/whitelist add` | Add player to whitelist | `/whitelist add <player>` |
| `/whitelist remove` | Remove player from whitelist | `/whitelist remove <player>` |
| `/kill` | Kill a player | `/kill <player>` |

### Player Stats & Effects

| Command | Description | Usage |
|---------|-------------|-------|
| `/player stats settomax` | Set a player stat to maximum | `/player stats settomax <player> health` |
| `/player stats set` | Set a specific stat value | `/player stats set <player> <stat> <value>` |
| `/player effect apply` | Apply an effect to a player | `/player effect apply <player> <effect>` |
| `/player effect clear` | Clear all effects from a player | `/player effect clear <player>` |
| `/player respawn` | Force respawn a player | `/player respawn <player>` |

### Inventory Management

| Command | Description | Usage |
|---------|-------------|-------|
| `/give` | Give items to a player | `/give <player> <item> [amount]` |
| `/inventory clear` | Clear a player's inventory | `/inventory clear <player>` |
| `/inventory open` | Open inventory management | `/inventory open <player>` |

### Gamemode

| Command | Description | Usage |
|---------|-------------|-------|
| `/gamemode survival` | Set survival mode | `/gamemode survival [player]` |
| `/gamemode creative` | Set creative mode | `/gamemode creative [player]` |
| `/gamemode adventure` | Set adventure mode | `/gamemode adventure [player]` |
| `/gamemode spectator` | Set spectator mode | `/gamemode spectator [player]` |

---

## Administration Commands

### Server Management

| Command | Description | Usage |
|---------|-------------|-------|
| `/stop` | Stop the server | `/stop` |
| `/restart` | Restart the server | `/restart` |
| `/save` | Force save all worlds | `/save` |
| `/reload` | Reload server configuration | `/reload` |

### Messaging

| Command | Description | Usage |
|---------|-------------|-------|
| `/say` | Broadcast a message | `/say <message>` |
| `/tell` | Send private message | `/tell <player> <message>` |
| `/broadcast` | Server-wide broadcast | `/broadcast <message>` |

### Server Info

| Command | Description | Usage |
|---------|-------------|-------|
| `/list` | List online players | `/list` |
| `/info` | Show server information | `/info` |
| `/help` | Show command help | `/help [command]` |
| `/version` | Show server version | `/version` |
| `/status` | Show server status | `/status` |
| `/performance` | Show performance stats | `/performance` |

---

## World Commands

### World Management

| Command | Description | Usage |
|---------|-------------|-------|
| `/world list` | List all worlds | `/world list` |
| `/world create` | Create a new world | `/world create <name>` |
| `/world delete` | Delete a world | `/world delete <name>` |
| `/world load` | Load a world | `/world load <name>` |
| `/world unload` | Unload a world | `/world unload <name>` |

### Time & Weather

| Command | Description | Usage |
|---------|-------------|-------|
| `/time set` | Set world time | `/time set <day|night|noon|midnight|value>` |
| `/time add` | Add to world time | `/time add <value>` |
| `/weather clear` | Set clear weather | `/weather clear [duration]` |
| `/weather rain` | Set rain | `/weather rain [duration]` |
| `/weather storm` | Set thunderstorm | `/weather storm [duration]` |

### Difficulty & Rules

| Command | Description | Usage |
|---------|-------------|-------|
| `/difficulty` | Set game difficulty | `/difficulty <peaceful|easy|normal|hard>` |
| `/gamerule` | Set game rules | `/gamerule <rule> <value>` |

---

## Teleportation Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `/tp` | Teleport player to player | `/tp <player> <target>` |
| `/tp` | Teleport to coordinates | `/tp <player> <x> <y> <z>` |
| `/tp` | Teleport self to player | `/tp <target>` |
| `/tp` | Teleport self to coords | `/tp <x> <y> <z>` |
| `/tp` | Teleport to world | `/tp <player> <x> <y> <z> --world <name>` |
| `/top` | Teleport to top | `/top` |
| `/spawn` | Teleport to spawn | `/spawn [player]` |
| `/home` | Teleport to home | `/home [player]` |
| `/sethome` | Set home location | `/sethome [player]` |
| `/warp` | Teleport to warp point | `/warp <name> [player]` |
| `/setwarp` | Create warp point | `/setwarp <name>` |
| `/delwarp` | Delete warp point | `/delwarp <name>` |

---

## Game Mechanics Commands

### Entities & NPCs

| Command | Description | Usage |
|---------|-------------|-------|
| `/summon` | Spawn an entity | `/summon <entity> [x] [y] [z]` |
| `/entity kill` | Kill entities | `/entity kill <type|all>` |
| `/npc create` | Create an NPC | `/npc create <name>` |
| `/npc remove` | Remove an NPC | `/npc remove <id>` |

### Blocks & Items

| Command | Description | Usage |
|---------|-------------|-------|
| `/setblock` | Set a block | `/setblock <x> <y> <z> <block>` |
| `/fill` | Fill area with blocks | `/fill <x1> <y1> <z1> <x2> <y2> <z2> <block>` |
| `/clone` | Clone area | `/clone <x1> <y1> <z1> <x2> <y2> <z2> <x> <y> <z>` |

### Experience & Skills

| Command | Description | Usage |
|---------|-------------|-------|
| `/xp add` | Add experience | `/xp add <player> <amount>` |
| `/xp set` | Set experience | `/xp set <player> <amount>` |
| `/level add` | Add levels | `/level add <player> <amount>` |
| `/level set` | Set level | `/level set <player> <amount>` |

---

## Debug Commands

These commands are useful for server administration and debugging.

| Command | Description | Usage |
|---------|-------------|-------|
| `/debug` | Toggle debug mode | `/debug [on|off]` |
| `/tps` | Show ticks per second | `/tps` |
| `/gc` | Run garbage collection | `/gc` |
| `/memory` | Show memory usage | `/memory` |
| `/chunk load` | Force load chunks | `/chunk load <x> <z>` |
| `/chunk unload` | Unload chunks | `/chunk unload <x> <z>` |
| `/entity count` | Count entities | `/entity count` |
| `/log level` | Set log level | `/log level <debug|info|warn|error>` |

---

## Permissions

Commands require appropriate permissions. The permission format typically follows:
- `hytale.command.<command>` - Basic command permission
- `hytale.admin.*` - All admin permissions
- `hytale.mod.*` - All moderator permissions

Example permissions:
- `hytale.command.kick` - Permission to kick players
- `hytale.command.ban` - Permission to ban players
- `hytale.command.teleport` - Permission to teleport
- `hytale.command.gamemode` - Permission to change gamemode
- `hytale.command.give` - Permission to give items

---

## Notes

1. **Case Sensitivity**: Commands are generally case-insensitive, but player names may be case-sensitive.

2. **Tab Completion**: The server supports tab completion for most commands and arguments.

3. **Aliases**: Some commands may have aliases (e.g., `/tp` for `/teleport`).

4. **Console vs In-Game**: Some commands may behave differently when run from console vs in-game.

5. **Coordinates**:
   - `~` represents relative coordinates (e.g., `~ ~1 ~` means current position + 1 on Y axis)
   - Coordinates can be decimal values

6. **Selectors**: Target selectors may be supported:
   - `@a` - All players
   - `@p` - Nearest player
   - `@r` - Random player
   - `@s` - Self (command executor)

---

## Quick Reference

### Most Common Commands

```
/kick <player>                    - Kick player
/ban <player>                     - Ban player
/op add <player>                  - Give OP
/tp <player> <target>             - Teleport player to player
/tp <player> <x> <y> <z>          - Teleport to coordinates
/gamemode creative <player>       - Set creative mode
/give <player> <item> <amount>    - Give items
/time set day                     - Set daytime
/weather clear                    - Clear weather
/server stats memory              - Show memory stats
/save                            - Save worlds
/stop                            - Stop server
```

---

<div align="center">

*Last updated: January 2025*
*Based on Hytale Server JAR analysis*

---

**[Back to README](../README.md)**

Made with :heart: by [KyuubiDDragon](https://github.com/KyuubiDDragon)

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)

</div>
