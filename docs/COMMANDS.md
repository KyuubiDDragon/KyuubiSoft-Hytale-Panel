<div align="center">

# Hytale Server Commands Documentation

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)
[![Discord](https://img.shields.io/badge/Discord-KyuubiDDragon-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com)

</div>

This document lists the Hytale 0.7 console commands the panel uses and documents. Commands can be run from the panel console or directly in the server console. Append `--help` to any command to see its full syntax (`/kick --help`).

The full list of a server, including the commands of its mods, is in the panel under **Help** ("This server") and in the console autocomplete. It comes from the server itself through the KyuubiSoft API plugin.

## Table of Contents

- [Which commands the panel runs](#which-commands-the-panel-runs)
- [Players](#players)
- [Access](#access)
- [Server](#server)
- [World, Time & Weather](#world-time--weather)
- [Announcements](#announcements)
- [Not in Hytale 0.7](#not-in-hytale-07)
- [Text in commands](#text-in-commands)

---

## Which commands the panel runs

The panel only sends commands that exist on the server: the server's own command list (read through the KyuubiSoft API plugin, cached, and kept as a snapshot while the server is offline), or the vanilla Hytale 0.7.3 commands when there is no list yet.

Each command needs one of two panel permissions:

| Panel permission | Commands |
|------------------|----------|
| `console.execute` | `/help`, `/who`, `/version`, `/whoami`, `/whereami`, `/server stats` (`cpu`, `gc`, `memory`), `/world list`, `/world perf` (`graph`, `reset`), `/world save`, `/plugin list`, `/packs list`, `/warp list`, `/whitelist status`, `/whitelist list`, `/say`, `/notify`, `/eventtitle`, `/time` and its subcommands except `/time dilation`, `/weather` (`get`, `set`, `reset`) |
| `console.execute.admin` | Every other command, among them `/op`, `/perm`, `/setgroup`, `/auth`, `/stop`, `/update`, `/backup`, `/ban`, `/unban`, `/kick`, `/whitelist add/remove/enable/disable/clear`, `/give`, `/kill`, `/gamemode`, `/sudo`, `/plugin load/unload/reload`, `/world add/remove/load/prune`, `/maxplayers`, and every command of a mod |

Aliases count as the command they stand for (`/shutdown` is `/stop`, `/gm` is `/gamemode`). A subcommand a server update adds starts on the admin tier until the panel lists it. Scheduled commands, quick commands and event actions are checked the same way, against the rights of the user who saved them.

---

## Players

| Command | Description | Usage |
|---------|-------------|-------|
| `/who` | List the online players per world | `/who` |
| `/whoami` | Show a player's UUID | `/whoami <player>` |
| `/whereami` | Show a player's world and position | `/whereami <player>` |
| `/kick` | Disconnect a player (no reason in Hytale 0.7; the panel keeps the reason in its history) | `/kick <player>` |
| `/kill` | Kill a player | `/kill <player>` |
| `/gamemode` | Set a player's game mode | `/gamemode <adventure\|creative> <player>` |
| `/give` | Give a player an item | `/give <player> <item> --quantity=<n>` |
| `/player stats settomax` | Restore a stat (the panel's heal uses `Health` and `Stamina`) | `/player stats settomax Health --player <player>` |
| `/player respawn` | Respawn a dead player | `/player respawn <player>` |
| `/player effect apply` | Apply an effect | `/player effect apply <player> <effect> [--duration=<seconds>]` |
| `/player effect clear` | Remove all effects | `/player effect clear <player>` |
| `/tp` | Teleport a player to another player | `/tp <player> <targetPlayer>` |
| `/tp` | Teleport a player to coordinates | `/tp <player> <x> <y> <z>` |

`/inventory clear` only clears the inventory of whoever runs it. Clearing another player's inventory from the panel needs the KyuubiSoft API plugin.

---

## Access

| Command | Description | Usage |
|---------|-------------|-------|
| `/whitelist status` | Show whether the whitelist is on | `/whitelist status` |
| `/whitelist list` | List the whitelisted players | `/whitelist list` |
| `/whitelist enable` / `disable` | Turn the whitelist on or off | `/whitelist enable` |
| `/whitelist add` / `remove` | Add or remove a player | `/whitelist add <player>` |
| `/ban` | Ban a player; the server disconnects them | `/ban <player> [reason]` |
| `/unban` | Lift a ban | `/unban <player>` |
| `/op add` / `remove` | Give or take operator rights | `/op add <player>` |
| `/perm user add` | Give a player (by UUID) a permission | `/perm user add <uuid> <permission>` |
| `/perm group add` | Give a group a permission | `/perm group add <group> <permission>` |

---

## Server

| Command | Description | Usage |
|---------|-------------|-------|
| `/help` | Show the syntax of a command | `/help <command>` |
| `/version` | Show the server version | `/version` |
| `/server stats` | Memory, CPU or garbage collection statistics | `/server stats <memory\|cpu\|gc>` |
| `/plugin list` | List the loaded plugins and mods | `/plugin list` |
| `/maxplayers` | Show or set the player limit (the new limit is an option, a bare number is refused) | `/maxplayers [--amount <n>]` |
| `/backup` | The server's own backup (needs `--backup-dir` at start) | `/backup` |
| `/update` | Check, download and apply server updates | `/update <status\|check\|download\|apply --confirm>` |
| `/auth status` | Show the server's Hytale sign-in | `/auth status` |
| `/stop` | Stop the server (alias `/shutdown`) | `/stop` |

---

## World, Time & Weather

| Command | Description | Usage |
|---------|-------------|-------|
| `/world list` | List the loaded worlds | `/world list` |
| `/world save` | Save all worlds now | `/world save --all --confirm` |
| `/world perf` | Ticks per second of a world | `/world perf` |
| `/world add` | Create a world | `/world add <name>` |
| `/world load` | Load a world | `/world load <name>` |
| `/time set` | Set the time of day (`day`, `noon`, `night` work too) | `/time set <dawn\|midday\|dusk\|midnight>` |
| `/time pause` | Pause the time of day | `/time pause` |
| `/weather set` | Force a weather | `/weather set Zone1_Rain` |
| `/weather reset` | Back to the natural weather (alias `/weather clear`) | `/weather reset` |
| `/warp list` | List the warp points | `/warp list` |

---

## Announcements

| Command | Description | Usage |
|---------|-------------|-------|
| `/say` | Chat message to all players (alias `/broadcast`) | `/say <message>` |
| `/notify` | Notice to all players, optionally styled | `/notify [warning\|danger\|success] <message>` |
| `/eventtitle` | Large title on every player's screen | `/eventtitle <title> [--secondary=<text>]` |

---

## Not in Hytale 0.7

These commands from other games or older panel versions do not exist: `/save`, `/save-all`, `/save-on`, `/save-off`, `/list`, `/tps`, `/tell`, `/msg`, `/whisper`, `/mute`, `/unmute`, `/difficulty`, `/gamerule`, `/xp`, `/home`, `/sethome`, `/restart`, `/weather rain`. The panel therefore has no chat mute and no private messages; its kick sends no reason.

---

## Text in commands

The server console is no shell: `< > & ; | $` are ordinary text. The Hytale command parser reads the whole line first, though, and rejects a command with an unbalanced `"` (or `'` at the start of a word), a backslash, a stray or nested `[ ]`, two commas in a row or a word starting with `--`. When the panel puts free text into a command (announcements, the Discord relay, the welcome message, ban reasons), it replaces exactly those characters with look-alikes. A message starting with `{` would be read as a formatted (JSON) message, so the panel replaces that brace too.

---

<div align="center">

*Last updated: October 2026*
*Based on the command list of a Hytale 0.7.3 server*

---

**[Back to README](../README.md)**

Made with :heart: by [KyuubiDDragon](https://github.com/KyuubiDDragon)

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/kyuubiddragon)

</div>
