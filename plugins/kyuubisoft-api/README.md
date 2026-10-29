# KyuubiSoft API Plugin

REST API and WebSocket plugin for KyuubiSoft Panel - provides accurate player data, server statistics, and real-time events.

> **2.0.0: every request needs a token.** The plugin refuses HTTP requests and
> WebSocket connections without `Authorization: Bearer <token>`. The
> KyuubiSoft Panel creates the token and writes it into the plugin config
> before each server start, so panel users don't have to do anything. See
> [Upgrading from 1.4.x](#upgrading-from-14x) if you call the API yourself.

## What's new in 2.1.1

- **Player actions with the Hytale 0.7 syntax:** heal restores health and
  stamina (`player stats settomax`), respawn uses the variant that takes the
  player, and clearing an inventory is done directly on the player's world
  thread (the server's `/inventory clear` only clears whoever runs it).
  2.1.0 sent the old syntax and these three actions failed.
- **No exception text in answers:** when clearing an inventory fails
  unexpectedly, the answer is a fixed message and the details go to the
  server log only, like for every other endpoint.

## What's new in 2.1

- **Real TPS per world.** Hytale ticks at 30 TPS and every world on its own
  thread. TPS and tick time (min/avg/max over 10 s, 1 min and 5 min) now come
  from the server's own tick history, computed the way `/world perf` does,
  with the target rate of each world. 2.0 capped the value at 20 and reported
  the tick interval as "MSPT". New: `GET /api/server/tps`,
  `GET /api/worlds/{name}/perf`, per-world Prometheus series.
- **`tps_update` every 5 s per world** and **`player_death` with cause and
  killer** on the WebSocket. Both were documented before but never sent.
- **Correct server values:** uptime since the server process started,
  `maxPlayers` from the server config (also in `/metrics`), entity and loaded
  chunk counts from the world stores, CPU load never negative (omitted while
  unknown), thread count of the whole JVM.
- **No more blocking:** player components are read on the player's world
  thread, commands run on a worker pool, the CPU load is sampled in the
  background; a world that does not answer gives `504` instead of a hung
  request.
- **Chat:** messages that another mod cancelled (mute, filter) are no longer
  forwarded.
- **Stricter HTTP:** query strings no longer break routing, invalid JSON gives
  `400`, errors never echo internal exception text.
- **Lifecycle:** the port opens in the plugin's `start()` and closes cleanly on
  shutdown, so a plugin reload works. The config moved to the plugin's data
  directory, see [Configuration](#configuration).
- **Manifest** targets server `0.7.0` (`>=0.7.0 <0.8.0`), so the server no
  longer warns that the plugin does not name a server version.
- **Live data from the server modules** instead of logs and files: build,
  update and auth state (never tokens), every plugin/mod with load state,
  load error and version mismatch, the 0.7 whitelist (join permission), bans,
  permission groups and user rights, online sessions with join time, ping and
  groups, live player data and the **real inventory** (the old placeholder is
  gone; `501` where the server build offers no data). See
  [Live data](#live-data-21).
- **New events:** `player_gamemode`, `player_join_denied`, `world_added`,
  `world_removed`, `server_shutdown`, `plugin_state`, `permission_changed`.
- **Commands with a real answer:** `POST /api/commands/execute` runs a
  command as `Panel:<user>` and returns the server's reply lines and the
  outcome (done, still running, unknown, rejected, failed). `GET /api/commands`
  lists every registered command (vanilla and mods) with syntax and
  permission, `GET /api/commands/complete` gives the server's own suggestions,
  and `commands_changed` tells the panel when the list changed. Player actions
  report the command's real result as well. See [Commands](#commands-21).
- **Status pages for your mods:** mods register a status snapshot and admin
  actions with `PanelRegistry` (optional dependency, the mod runs unchanged
  without this plugin) and send their own `mod_event`s. The panel shows them
  on its "Mod Status" page. See [Integrating your mod](#integrating-your-mod).

## Features

- **Accurate Player Data** - Direct access to server player list (no log parsing),
  incl. real gamemode (Adventure/Creative) and health via the entity-stats component
- **Player Actions** - heal, kill, respawn, teleport, gamemode and clear-inventory,
  executed in-process through the server's own commands (no console round-trip);
  clearing another player's inventory is done directly on the player's world thread,
  since the server's `/inventory clear` only clears the sender
- **World Information** - List all worlds with live player counts / tick state,
  entities and loaded chunks
- **Server Statistics** - real TPS and tick time per world (the server's own tick
  history), memory, uptime
- **Real-time Events** - WebSocket for player join/leave/chat/death, per-world
  `tps_update` and periodic `player_position` frames with real client latency
  (`PacketHandler.getPingInfo`)
- **Required auth** - bearer token for every route and the WebSocket, checked
  before the WebSocket handshake; CORS off unless you allow-list origins

## Authentication

Every endpoint, `/metrics` and the WebSocket require

```
Authorization: Bearer <authToken>
```

| Situation | Response |
|-----------|----------|
| Token missing or wrong | `401` with `{"status":401,"error":"Unauthorized","code":"auth_invalid"}` |
| No token configured on the server (or shorter than 16 characters) | `503` with `{"status":503,"error":"API locked: no auth token configured","code":"auth_not_configured"}` |
| WebSocket upgrade without a valid token | `401`/`503` as above, never `101 Switching Protocols` |

The plugin is **fail-closed**: without a usable token it starts, logs a
`SEVERE` line saying the API is locked, and answers every request with 503.
Tokens are compared in constant time and never written to the log.

Token sources, first match wins:

1. `authToken` in the [config file](#configuration)
2. the environment variable `KYUUBISOFT_API_TOKEN` (the panel sets it on
   additional server containers it creates)

Generate a token yourself with `openssl rand -hex 32` if you run the plugin
without the panel.

## API Endpoints

### Players

| Endpoint | Description |
|----------|-------------|
| `GET /api/players` | All online players |
| `GET /api/players/{world}` | Players in specific world |
| `GET /api/players/{name}/details` | Detailed player info (position, health, etc.) |

### Worlds

| Endpoint | Description |
|----------|-------------|
| `GET /api/worlds` | All worlds |
| `GET /api/worlds/{name}` | Specific world info |
| `GET /api/worlds/{name}/stats` | World statistics: entities, loaded chunks, current tick, `perf` (as below) |
| `GET /api/worlds/{name}/perf` | Tick metrics of the world (2.1+) |

World tick metrics (`/api/worlds/{name}/perf`, also each entry of `worlds` in
`/api/server/tps`):

```json
{
  "world": "default",
  "targetTps": 30,
  "tickBudgetMs": 33.333,
  "tps": 30.0,
  "mspt": 0.433,
  "windows": [
    { "window": "10s", "tpsAvg": 30.0, "tpsMin": 30.0, "tpsMax": 30.0, "tickMsAvg": 0.433, "tickMsMin": 0.18, "tickMsMax": 31.327 },
    { "window": "1m",  "tpsAvg": 30.0, "tpsMin": 20.07, "tpsMax": 30.0, "tickMsAvg": 0.516, "tickMsMin": 0.078, "tickMsMax": 49.826 },
    { "window": "5m",  "tpsAvg": 30.0, "tpsMin": 0.93, "tpsMax": 30.0, "tickMsAvg": 3.359, "tickMsMin": 0.052, "tickMsMax": 1072.927 }
  ],
  "players": 0,
  "entities": 1,
  "loadedChunks": 0
}
```

`tickMs*` is the time a tick took to compute, not the interval between ticks.
TPS follows the server's own formula: a tick within the budget counts as the
full target rate, a slower one as `1000 / tickMs`; so `tpsMin` comes from the
slowest tick. `tps`/`mspt` are the 10 s averages. Counts are `-1` when the
server cannot provide them.

### Player Actions (POST)

| Endpoint | Body | Description |
|----------|------|-------------|
| `POST /api/players/{name}/heal` | – | Health and stamina to their maximum |
| `POST /api/players/{name}/kill` | – | Kill the player |
| `POST /api/players/{name}/respawn` | – | Respawn at spawn point |
| `POST /api/players/{name}/teleport` | `{x,y,z}` or `{target}` | Teleport to coords/player |
| `POST /api/players/{name}/gamemode` | `{gamemode}` | `creative` or `adventure` only |
| `POST /api/players/{name}/inventory/clear` | – | Clear the whole inventory, tools included |

Actions return `{ "success": true|false, "message": "..." }`. The plugin
runs the server's own commands as `Panel:player-action` and reports their real
result: an unknown command, wrong syntax or an error the command reports is
`success: false` with the server's message. A command that is still running
after 3 s counts as queued (`success: true`).

### Commands (2.1+)

| Endpoint | Description |
|----------|-------------|
| `POST /api/commands/execute` | Run a command and return the server's answer |
| `GET /api/commands[?ifRevision=<rev>]` | Every registered command (vanilla and mods) |
| `GET /api/commands/complete?line=<text>` | The server's suggestions for the last word of `line` |

`POST /api/commands/execute` takes
`{ "command": "who", "actor": "alice", "echo": false, "timeoutMs": 5000 }`
(`command` with or without the leading `/`; the rest is optional). The command
runs as `Panel:<actor>` with console rights, and the server log names that
sender (`Panel:alice executed command: who`). `actor` keeps `A-Z a-z 0-9 _ . @ / -`
and up to 48 characters; other characters are replaced. The reply text is
collected for the panel and only written to the server console with
`echo: true`. Messages the command sends after the reply went out (download
progress, results from a world thread) are always written to the server
console, so they are not lost; only the caller sees the reply itself, the
server log keeps the `executed command` line.

```json
{ "ok": true, "status": "DONE", "command": "who", "sender": "Panel:alice",
  "output": ["..."], "messageIds": ["..."],
  "truncated": false, "durationMs": 203 }
```

- Every outcome is HTTP `200`; `status` says what happened: `DONE`,
  `RUNNING` (accepted, still running at `timeoutMs`), `NOT_FOUND`, `REJECTED`
  (wrong syntax, or a command only players can run) or `FAILED`. `ok` is true for
  `DONE` and `RUNNING`; `error` carries the server's message otherwise.
- `timeoutMs` defaults to 5000 and is kept between 500 and 30000. Messages that
  arrive within 200 ms after the command returned are still collected.
- The answer holds at most 500 lines of 2000 characters (`truncated: true`
  when cut). ANSI and control characters are removed.
- `400` for an empty command, more than 4096 characters or control
  characters (line breaks included, so one request is always one command);
  `403` while `insecureDisableAuth` is on (the API is read-only then, see
  [Configuration](#configuration)); `405` for another method; `503` while the
  command system is not up yet.
- `stop` shuts the server down before the answer is written; the connection
  closes without a response.

`GET /api/commands` answers
`{ revision, generatedAt, count, commands: [...] }`. Each command has `name`,
`aliases`, `description` (in the server's default language), `permission`,
`owner` (e.g. `Hytale:Teleport` or a mod id), `builtin`, `usage`,
`requiredArgs`, `optionalArgs` (`kind` `optional`, `default` or `flag`, with
type and default value), `variants` and `subcommands` (same shape, up to 8
levels). A command a mod registered that cannot be read is listed with
`error: "unreadable"`. Pass the last `revision` as `ifRevision` to get
`{ "revision": "...", "unchanged": true }` while nothing changed.

`GET /api/commands/complete?line=/plugin%20l` answers
`{ "wordIndex": 1, "prefix": "l", "suggestions": ["list", "load"], "truncated": false }`:
at most 50 suggestions for a line of at most 512 characters (`400` otherwise).

### Errors

Every error has the body `{ "status": <code>, "error": "<message>" }`.
Routes ignore the query string.

| Status | When |
|--------|------|
| `400` | Request body is not valid JSON, or a required field is missing |
| `403` | Any method but GET, HEAD and OPTIONS while `insecureDisableAuth` is on (code `auth_disabled_read_only`) |
| `404` | Unknown route, player or world (also: player not in a world right now) |
| `405` | Wrong method for a route that only takes GET or POST |
| `409` | The player is changing worlds; try again |
| `501` | The server build offers no such data (live data, see below) |
| `503` | The world is starting or shutting down, or a subsystem (commands, live data, mod pages) is not ready yet |
| `504` | The world thread did not answer within 2 s |
| `500` | Anything else; details are only in the server log |

### Server

| Endpoint | Description |
|----------|-------------|
| `GET /api/server/info` | Server version, uptime (since the server process started), `maxPlayers` (server config), TPS |
| `GET /api/server/tps` | Tick metrics of every world (2.1+) |
| `GET /api/server/performance` | TPS, entities and loaded chunks (all worlds), CPU, JVM threads, `worlds` |
| `GET /api/server/memory` | Heap usage, memory stats |
| `GET /metrics` | Prometheus exposition format |

`tps`/`mspt` in `/api/server/info`, `/api/server/performance` and
`/api/server/tps` describe the world with the **lowest TPS relative to its
target** (named in `tpsWorld` / `world`), since each world ticks on its own
thread and that is where players feel lag. They are omitted while no world
runs. `targetTps` is that world's target rate (30 by default).

```json
{ "world": "default", "tps": 30.0, "mspt": 0.433, "targetTps": 30, "worlds": [ ... ] }
```

`cpuUsage` / `processCpuUsage` (percent) are sampled every 5 s in the
background and omitted until the first sample exists.

Prometheus: the unlabeled `hytale_tps_*` / `hytale_mspt_*` gauges keep their
names and describe the slowest world (`hytale_tps_current` = 10 s average,
`average`/`min`/`max` = 1 min window, `hytale_mspt_*` = tick compute time).
New in 2.1: `hytale_world_tps{world,window,stat}`,
`hytale_world_tick_ms{world,window,stat}` (`stat` = `avg`/`min`/`max`,
`window` = `10s`/`1m`/`5m`), `hytale_world_tps_target{world}`,
`hytale_world_entities{world}`, `hytale_world_chunks_loaded{world}`,
`hytale_entities_total`, `hytale_chunks_loaded_total`. `hytale_players_max`
comes from the server config, `hytale_uptime_seconds` counts from the server
start; the CPU gauges are left out while no sample exists.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:18085/api/server/info
```

Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: hytale
    authorization:
      credentials: <authToken>
    static_configs:
      - targets: ['hytale:18085']
```

### Live data (2.1+)

Read-only, straight from the running server modules. Changes go through the
server commands (`/whitelist`, `/ban`, `/unban`, `/perm ...`), so the server
stays the single writer.

| Endpoint | Description |
|----------|-------------|
| `GET /api/server/status` | `build` (version, revision, patchline), `update` (latest known, staged, download progress), `auth` (mode, which tokens exist, expiry, profile; **never the tokens**), `lifecycle` (booted, shutting down, reason) |
| `GET /api/plugins` | Every plugin/mod: `state` (`ENABLED`, `FAILED`, ..., `NOT_LOADED`, `REJECTED` for a jar the server refused before setup), version, `error`, `serverVersionCheck`/`versionMismatch`, dependencies; `failedCount`, `mismatchCount` |
| `GET /api/access/whitelist` | `enabled` (`RequireJoinPermission`) and the users holding the join permission (`hytale.server.join`); members of wildcard groups (Admin) may join without an entry |
| `GET /api/access/bans` | Bans with target, author, time, expiry (`permanent`), reason, `inEffect` |
| `GET /api/permissions/groups` | Groups with parent, own and effective permissions, virtual groups, providers |
| `GET /api/permissions/users` | Online, whitelisted and wildcard users with groups and own permissions (`complete: false`: the server cannot list every user) |
| `GET /api/permissions/users/{uuid}` | One user: groups, permissions, operator, join grant, banned |
| `GET /api/sessions` | Online sessions: world, `joinedAt`, language, groups, ping (last, 1 min avg/min/max, 5 min avg), protocol checksum |
| `GET /api/players/{name\|uuid}/live` | Session data plus game mode, health/stamina/mana/oxygen, position, head rotation, skin parts |
| `GET /api/players/{name\|uuid}/inventory` | The real inventory: `sections` (hotbar with `activeSlot`, storage, armor, utility, tools, backpack) with capacity and items (`slot`, `itemId`, `amount`, `durability`/`maxDurability` when the item wears) |
| `GET /api/players/{name\|uuid}/appearance` | Skin parts by slot |

Player routes read on the player's world thread: `404` while the player is
offline, `409` while changing worlds, `504` when the world does not answer;
`501` when the server build has no such data (e.g. no inventory component).
`joinedAt` is missing for players that were online before the plugin started;
the server keeps no client build string, `protocolCrc` identifies the protocol.

### WebSocket

Connect to `ws://localhost:18085/ws` with the `Authorization` header on the
upgrade request (Node `ws`: `new WebSocket(url, { headers: { Authorization: 'Bearer …' } })`).
The token is not accepted in the URL, so it never ends up in access logs.

```json
{ "type": "player_join", "player": "Steve", "uuid": "...", "timestamp": "..." }
{ "type": "player_leave", "player": "Steve", "uuid": "...", "timestamp": "..." }
{ "type": "tps_update", "world": "default", "tps": 30.0, "mspt": 0.65,
  "targetTps": 30, "tickBudgetMs": 33.333, "windows": [ ... ],
  "players": 3, "entities": 812, "loadedChunks": 441, "timestamp": "..." }
{ "type": "player_death",
  "player": "Steve", "uuid": "...",
  "cause": "Physical",
  "killer": "Alex", "killerUuid": "...", "killerType": "player",
  "world": "default", "x": 12.5, "y": 64.0, "z": -32.25,
  "timestamp": "..." }
{ "type": "player_position",
  "player": "Steve", "uuid": "...",
  "world": "overworld",
  "x": 12.5, "y": 64.0, "z": -32.25,
  "yaw": 90.0, "pitch": 0.0,
  "latencyMs": 42,
  "timestamp": "..." }
```

`player_position` is emitted periodically (default every 2 s) for every
online player while at least one WebSocket client is connected. Positions are
copied on each world's own thread (so x/y/z always belong to the same tick);
`yaw`/`pitch` are the head rotation, i.e. where the player looks. `latencyMs`
is read from the connection's ping metrics
(`PlayerRef.getPacketHandler().getPingInfo(...)`) and is `null` only when no
sample exists yet (e.g. the player just connected). Set the JVM system
property `-DKYUUBI_DEBUG_POSITIONS=1` to log every tick on stdout for debugging.

`tps_update` is sent every 5 s for every running world while a client is
connected (`tps`/`mspt` = 10 s averages, `windows` as in
`/api/worlds/{name}/perf`). `player_death` is sent when a player dies:
`cause` is the server's damage cause id; `killerType` is `player`, `entity`,
`environment` or `command`; `killer`/`killerUuid` are left out when unknown.

Live-data events (2.1+); fields are left out when unknown:

```json
{ "type": "player_gamemode", "player": "Steve", "uuid": "...", "world": "default",
  "from": "adventure", "to": "creative", "timestamp": "..." }
{ "type": "player_join_denied", "player": "Steve", "uuid": "...",
  "kind": "banned", "reason": "...", "reasonId": "...", "timestamp": "..." }
{ "type": "world_added", "world": "arena", "timestamp": "..." }
{ "type": "world_removed", "world": "arena", "reason": "GENERAL", "timestamp": "..." }
{ "type": "server_shutdown", "reason": "normal", "exitCode": 0, "timestamp": "..." }
{ "type": "plugin_state", "plugin": "Hytale:Parkour", "name": "Parkour", "version": "1.0.0",
  "from": "ENABLED", "to": "UNLOADED", "timestamp": "..." }
{ "type": "permission_changed", "scope": "user", "action": "group_added",
  "uuid": "...", "group": "hytale:Builder", "timestamp": "..." }
```

- `player_gamemode` is sent once the change is applied; a cancelled change is never reported.
- `player_join_denied`: `kind` is `banned`, `whitelist` (join permission) or `other` (refused by a plugin). Anyone can cause it by connecting under any name, so it is sent at most once per name in 30 s.
- `world_removed` carries `serverShuttingDown: true` when the server shuts down; the server then reports `EXCEPTIONAL` although nothing failed.
- `server_shutdown` is sent first thing during a shutdown, so a planned stop can be told from a crash.
- `plugin_state` compares the plugin states every 5 s; `NOT_LOADED`/`UNLOADED` mark plugins appearing or disappearing, `error` comes with `FAILED`.
- `permission_changed`: `scope` `user` or `group`; `action` `group_added`, `group_removed`, `permissions_added` or `permissions_removed` (with `permissions`). `/perm reload` sends nothing.

Command list (2.1+):

```json
{ "type": "commands_changed", "revision": "5942d380b60eaadb", "count": 182, "timestamp": "..." }
```

The plugin compares the command registry every 10 s and sends
`commands_changed` when a plugin or mod added or removed commands; fetch
`GET /api/commands` again for the new list.

Events sent by mods (2.1+, see [Integrating your mod](#integrating-your-mod)):

```json
{ "type": "mod_event", "modId": "kyuubisoft:pets", "event": "pet_level_up",
  "payload": { "player": "Steve", "petName": "Fox", "level": 10 }, "timestamp": "..." }
```

## Configuration

Config file (2.1+): `mods/KyuubiDDragon_KyuubiSoftAPI/config.json`, the
plugin's data directory (relative to the server's working directory; in the
panel's Docker setup `/opt/hytale/mods/KyuubiDDragon_KyuubiSoftAPI/config.json`).

Up to 2.0 the file was `config/kyuubisoft-api/config.json`. On the first start
2.1 moves it: its known keys go into the new file (keys the new file already
sets win, an empty `authToken` there does not hide the old token), then the
old file is deleted so the token is not left in two places.
`insecureDisableAuth` and `corsAllowedOrigins` only come along while there is
no new file yet, and an old location with a symbolic link in its path is not
moved. An empty or broken
file gives the defaults (API locked until a token is set).

```json
{
  "httpPort": 18085,
  "authToken": "<64 hex characters, written by the panel>",
  "corsAllowedOrigins": [],
  "positionBroadcastIntervalMs": 2000,
  "tpsBroadcastIntervalMs": 5000
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `httpPort` | `18085` | Port for HTTP and WebSocket |
| `authToken` | `""` | Bearer token. Empty = API locked (503) |
| `corsAllowedOrigins` | `[]` | Explicit browser origins allowed to call the API, e.g. `["https://panel.example.com"]`. Empty = no CORS headers. `*` is rejected |
| `positionBroadcastIntervalMs` | `2000` | Interval of the `player_position` frames; `0` disables the ticker (minimum 250) |
| `tpsBroadcastIntervalMs` | `5000` | Interval of the per-world `tps_update` frames; `0` disables them (minimum 250) |
| `insecureDisableAuth` | `false` | Turns authentication off and makes the API read-only: GET, HEAD and OPTIONS work without a token, every other method (commands, player and mod actions) gets `403`. For isolated development machines only; logs a security warning at every start. The panel never sets it |

The panel only touches `authToken` (and `authEnabled`, see below) when it
writes the file; all other keys you set stay as they are. It writes the new
file before every start and keeps the old one up to date only while a plugin
older than 2.1 is installed or the old file still exists.

## Upgrading from 1.4.x

**Breaking change.** What changes when 2.0.0 replaces 1.4.x:

- A token is always required. `authEnabled` is ignored (1.4.x wrote
  `authEnabled: false` into every config, so that switch can no longer
  disable auth). The panel still sets `authEnabled: true`, which only matters
  if a 1.4.x jar is still installed: it then checks the same token on HTTP.
- An empty token no longer means "open"; it means "locked".
- The WebSocket checks the token before the handshake (1.4.x accepted every
  connection, even with auth enabled).
- Only `Authorization: Bearer <token>` is accepted (1.4.x also took the bare
  token without the `Bearer` prefix).
- CORS is off by default. `corsEnabled` and `corsOrigin` are ignored; move an
  explicit origin into `corsAllowedOrigins`. The wildcard `*` is gone.

Panel users: update the plugin from the dashboard banner and restart the
server through the panel. The panel writes the token before the start.
Scripts or dashboards that call the API directly need the token from the
config file.

## Installation

1. Build the plugin (see below).
2. Copy `build/libs/KyuubiSoftAPI-2.1.1.jar` to your server's `mods/` folder
   (the KyuubiSoft Panel bundles this jar and can install it for you).
3. Put a token into the config (the panel does this for you) and restart the server.
4. API will be available at `http://localhost:18085`

## Building

The plugin compiles **against the running server's** `HytaleServer.jar`
(`compileOnly`); there are no other dependencies to shade, so a plain `jar` is
produced (not `shadowJar`). No Gradle wrapper is committed — use a local
Gradle 9, or the JDK directly.

1. Copy your server's `HytaleServer.jar` into `lib/`:
   `cp /path/to/Server/HytaleServer.jar plugins/kyuubisoft-api/lib/`
   (or pass `-PhytaleServerJar=/path/to/HytaleServer.jar` to Gradle)
2. Build:

```bash
cd plugins/kyuubisoft-api
gradle jar          # if Gradle is installed
```

Or with the JDK only (Java 21+):

```bash
cd plugins/kyuubisoft-api
javac --release 21 -encoding UTF-8 -cp lib/HytaleServer.jar -d build/classes \
    $(find src/main/java -name '*.java')
cp src/main/resources/manifest.json build/classes/
jar --create --file build/libs/KyuubiSoftAPI-2.1.1.jar -C build/classes .
```

Output: `build/libs/KyuubiSoftAPI-2.1.1.jar`. `gradle assemble` (or
`gradle panelApiJar`) also writes `build/libs/KyuubiSoftAPI-panel-api-2.1.1.jar`,
the compile-only jar for mods (see [Integrating your mod](#integrating-your-mod)).

The manifest targets server `0.7.0`, i.e. `>=0.7.0 <0.8.0`. Build against the
`HytaleServer.jar` of the server you run.

## Integration with KyuubiSoft Panel

The panel keeps one random token per server in its own data volume
(`plugin-tokens.json`), writes it into the plugin config before every start
and sends it with every request. If the plugin runs with an older token (for
example because the token was created while the server was already running),
the dashboard says so; a restart through the panel fixes it.
If the plugin is not installed or not reachable, the panel falls back to log parsing.

## Integrating your mod

Since 2.1 a mod can show a status page in the panel ("Mod Status"), offer
admin actions as buttons there and send its own events to the panel's event
stream, without running a web server of its own. The API lives in the package
`com.kyuubisoft.api.panel` and stays compatible across versions: additions do
not change `PanelRegistry.apiVersion()` (currently `1`).

### 1. Optional dependency

Declare KyuubiSoftAPI as an optional dependency, so it loads first when it is
installed and your mod still loads when it is not:

```json
"OptionalDependencies": { "KyuubiDDragon:KyuubiSoftAPI": "*" }
```

Compile against `KyuubiSoftAPI-panel-api-<version>.jar` (API classes only,
see [Building](#building)) as `compileOnly`; never bundle it. At runtime the
classes come from the installed plugin.

```kotlin
compileOnly(files("libs/KyuubiSoftAPI-panel-api.jar"))
```

### 2. Keep every API reference in a holder class

A `Class.forName` check alone is not enough: the JVM resolves referenced
classes when it verifies the class that uses them, so a class that mentions
`PanelRegistry` fails with `NoClassDefFoundError` when the plugin is missing.
Put every reference into a nested class that is only touched after the check:

```java
public final class PanelIntegration {
    private static volatile boolean registered;

    public static void register(MyPlugin plugin) {           // call in start()
        try {
            Class.forName("com.kyuubisoft.api.panel.PanelRegistry", false,
                    PanelIntegration.class.getClassLoader());
        } catch (ClassNotFoundException | LinkageError e) {
            return;                                           // no panel plugin: nothing to do
        }
        try {
            Holder.register(plugin);
            registered = true;
        } catch (Exception | LinkageError e) {
            plugin.getLogger().warning("Panel integration failed: " + e.getMessage());
        }
    }

    public static void unregister() {                         // call in shutdown()
        if (registered) { registered = false; Holder.unregister(); }
    }

    private static final class Holder {
        private static MyPanelProvider provider;              // implements PanelInfoProvider

        static void register(MyPlugin plugin) {
            provider = new MyPanelProvider(plugin);
            com.kyuubisoft.api.panel.PanelRegistry.register(provider);
        }

        static void unregister() {
            com.kyuubisoft.api.panel.PanelRegistry.unregister(provider);
        }
    }
}
```

`MyPanelProvider` itself may import the API freely; only the holder loads it.

### 3. The provider

```java
final class MyPanelProvider implements PanelInfoProvider {
    public String id() { return "mygroup:mymod"; }            // lowercase, a-z 0-9 . _ : -, max 64
    public String displayName() { return "My Mod"; }
    public String version() { return "1.2.0"; }

    public PanelSnapshot snapshot(PanelRequest request) {
        return PanelSnapshot.builder()
            .notice(PanelSnapshot.Tone.WARNING, "Database offline, nothing is saved")
            .section(PanelSnapshot.section("Overview")
                .metric("Active arenas", cache.activeArenas())
                .metric(PanelSnapshot.Metric.of("Queue", cache.queueSize()).unit("players"))
                .build())
            .section(PanelSnapshot.section("Arenas")
                .table(PanelSnapshot.table("Arena", "Players", "State")
                    .row("north", 4, "running")
                    .emptyText("No arena running")
                    .build())
                .build())
            .build();
    }

    public List<PanelAction> actions() {
        return List.of(
            PanelAction.builder("reload", "Reload configuration", req -> {
                    plugin.reload();
                    return PanelAction.Result.ok("Reloaded");
                })
                .confirm("Apply the files on disk now?")
                .build(),
            PanelAction.builder("close_arena", "Close an arena", req -> {
                    boolean closed = arenas.close(req.getString("arena"));
                    return closed ? PanelAction.Result.ok("Closed") : PanelAction.Result.failed("No such arena");
                })
                .param(PanelAction.Param.choice("arena", "Arena", "north", "south").required())
                .dangerous()
                .build());
    }
}
```

Rules:

- **Threads.** `snapshot()` and action handlers run on a KyuubiSoftAPI worker
  thread with a timeout (snapshot 3 s, action 10 s), at most one snapshot and
  one action per provider at a time. They never run on a world thread: read
  your own thread-safe cache. Whatever needs an ECS store, compute it on the
  world thread yourself (for example in a periodic `world.execute`) and keep
  the result. An action that has to change the world hops over with
  `world.execute` and waits for less than 10 s.
- **Errors** thrown by your code are caught and shown as an error of your
  provider; they never reach the server. The panel only gets the exception's
  class name, its message goes to the server log. Report expected failures
  with `Result.failed(message)`. A call that hangs answers `timeout`, further
  calls answer `busy` until it returns.
- **Metadata** (`displayName`, `description`, `version`, `actions`) is read
  once in `register()`. Register again to change it; the same id replaces the
  old entry, which also covers a reloaded mod.
- **Values** in metrics and table cells may be `null`, `Boolean`, `Number` or
  text. The panel shows text as plain text, never as HTML. Snapshots are cut to
  20 sections, 30 metrics and 10 tables per section, 16 columns, 200 rows per
  table, 20 notices and 500 characters per text; control characters are
  removed.
- **Actions** are only offered to panel accounts with the permission
  `mods.panel.action`, and every run lands in the panel's audit log. Mark
  anything destructive with `dangerous()` or `confirm(...)`: the plugin refuses
  such an action unless the panel confirmed it. An action marked
  `dangerous()` runs with the same rights as an admin console command, so the
  panel also requires `console.execute.admin` for it. Parameters (`text`, `number`,
  `bool`, `choice`) are checked before your handler runs: only declared ids,
  the declared type, required values present, text without control characters
  and within `maxLength` (default 200), numbers within `range`, choices from
  their list. Defaults have to pass the same checks, otherwise `register()`
  throws. `PanelRequest.actor()` and `locale()` tell you which panel account
  and UI language asked (informational).
- **Reloads.** Reloading your mod is fine: `shutdown()` unregisters, the new
  instance registers again. When KyuubiSoftAPI itself is reloaded, reload the
  mods that use it as well (or restart the server), because they still hold
  the classes of the old plugin instance.

### 4. Events

```java
PanelRegistry.publishEvent("mygroup:mymod", "arena_finished",
        Map.of("arena", "north", "winner", playerName, "durationSeconds", 312));
```

The panel receives `{"type":"mod_event","modId":…,"event":…,"payload":{…}}`
on the WebSocket (see [WebSocket](#websocket)) and puts it on its event bus as
`mod.event`, so webhooks, event actions and the replay recorder see it.
Top-level text, number and boolean payload fields are available as event
action placeholders (`{winner}`); `{modId}` and `{event}` are always set.

- Payloads may contain null, Boolean, Number, String, Map (String keys), List
  and arrays. They are cut to 4 levels, 50 entries per map or list, 1000
  characters per text and 2000 values or 32000 text characters per event;
  control characters are removed.
- Each mod id may send 20 events per second on average (bursts of 40); more
  are dropped and `publishEvent` returns `false`. Events only reach panels
  connected at that moment; nothing is buffered.
- Payload values end up in Discord/Slack webhooks and in event action
  commands. They are not escaped for commands: do not put secrets in them, and
  when you write event action rules, only use free text that players control
  (names they chose, chat text) in announcements, not in commands. The panel
  checks `{player}` and similar name fields against the player name format.

### HTTP endpoints

The panel uses these; they need the bearer token like every other route.

| Endpoint | Description |
|----------|-------------|
| `GET /api/mods/panel` | `{apiVersion, snapshotTimeoutMs, actionTimeoutMs, providers: [{id, displayName, description, version, actions}]}` |
| `GET /api/mods/panel/{id}` | Provider plus `{status: ok\|error\|timeout\|busy, error, generatedAt, durationMs, snapshot: {notices, sections, truncated}}` |
| `POST /api/mods/panel/{id}/actions/{actionId}` | Body `{params?, confirmed?}`; answers `{success, status: ok\|failed\|error\|timeout\|busy, message, data, durationMs}` |

Errors: `404 not_found` (unknown provider or action), `400 invalid_params` /
`invalid_body`, `409 confirmation_required`, `503 mod_panel_unavailable`. The
panel passes the account in `X-Panel-Actor` and its UI language in
`Accept-Language`.

## License

Part of the KyuubiSoft Panel project - GPL-3.0

## Author

KyuubiDDragon
