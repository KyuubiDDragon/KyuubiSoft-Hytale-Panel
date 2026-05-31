# KyuubiSoft API Plugin

REST API and WebSocket plugin for KyuubiSoft Panel - provides accurate player data, server statistics, and real-time events.

> Built against the **Hytale 2026-05 server API**. Requires that API; older
> builds (≤ 1.2.2) no longer compile/run against the current server.

## Features

- **Accurate Player Data** - Direct access to server player list (no log parsing),
  incl. real gamemode (Adventure/Creative) and health via the entity-stats component
- **Player Actions** - heal, kill, respawn, teleport, gamemode and clear-inventory,
  executed in-process through the server's own commands (no console round-trip)
- **World Information** - List all worlds with live player counts / tick state
- **Server Statistics** - Real TPS/MSPT (sampled from `World.getTick()`), memory, uptime
- **Real-time Events** - WebSocket for player join/leave/chat and periodic
  `player_position` frames with real client latency (`PacketHandler.getPingInfo`)
- **Optional auth** - bearer-token gate + configurable CORS (off by default)

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
| `GET /api/worlds/{name}/stats` | World statistics |

### Player Actions (POST)

| Endpoint | Body | Description |
|----------|------|-------------|
| `POST /api/players/{name}/heal` | – | Restore stats to full |
| `POST /api/players/{name}/kill` | – | Kill the player |
| `POST /api/players/{name}/respawn` | – | Respawn at spawn point |
| `POST /api/players/{name}/teleport` | `{x,y,z}` or `{target}` | Teleport to coords/player |
| `POST /api/players/{name}/gamemode` | `{gamemode}` | `creative` or `adventure` only |
| `POST /api/players/{name}/inventory/clear` | – | Clear inventory |

Actions return `{ "success": true|false, "message": "..." }`. The plugin
dispatches the server's own commands as the console; on failure the panel falls
back to a console command.

### Server

| Endpoint | Description |
|----------|-------------|
| `GET /api/server/info` | Server version, uptime, real TPS/MSPT |
| `GET /api/server/performance` | CPU, threads, TPS (entities/chunks: -1 = unknown) |
| `GET /api/server/memory` | Heap usage, memory stats |
| `GET /metrics` | Prometheus exposition format |

### WebSocket

Connect to `ws://localhost:18085/ws` to receive real-time events:

```json
{ "type": "player_join", "player": "Steve", "uuid": "...", "timestamp": "..." }
{ "type": "player_leave", "player": "Steve", "uuid": "...", "timestamp": "..." }
{ "type": "tps_update", "tps": 19.8, "mspt": 51.2, "timestamp": "..." }
{ "type": "player_position",
  "player": "Steve", "uuid": "...",
  "world": "overworld",
  "x": 12.5, "y": 64.0, "z": -32.25,
  "yaw": 90.0, "pitch": 0.0,
  "latencyMs": 42,
  "timestamp": "..." }
```

`player_position` is emitted periodically (default every 2 s) for every
online player while at least one WebSocket client is connected. `latencyMs`
is read from the connection's ping metrics
(`PlayerRef.getPacketHandler().getPingInfo(...)`) and is `null` only when no
sample exists yet (e.g. the player just connected). Set the JVM system
property `-DKYUUBI_DEBUG_POSITIONS=1` to log every tick on stdout for debugging.

## Configuration

Config file: `config/kyuubisoft-api/config.json`

```json
{
  "httpPort": 18085,
  "authEnabled": false,
  "authToken": "",
  "corsEnabled": true,
  "corsOrigin": "*",
  "wsHeartbeatSeconds": 30,
  "logRequests": false,
  "positionBroadcastIntervalMs": 2000
}
```

`positionBroadcastIntervalMs` controls how often the plugin emits a
`player_position` WebSocket frame per online player. Set to `0` to disable
the ticker entirely (useful for headless test setups).

## Installation

1. Build the plugin (see below).
2. Copy `build/libs/KyuubiSoftAPI-1.4.1.jar` to your server's `mods/` folder
   (the KyuubiSoft Panel bundles this jar and can install it for you).
3. Restart the server
4. API will be available at `http://localhost:18085`

## Building

The plugin compiles **against the running server's** `HytaleServer.jar`
(`compileOnly`); there are no other dependencies to shade, so a plain `jar` is
produced (not `shadowJar`). No Gradle wrapper is committed — use a local Gradle,
or the JDK directly.

1. Copy your server's `HytaleServer.jar` into `lib/`:
   `cp /path/to/Server/HytaleServer.jar plugins/kyuubisoft-api/lib/`
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
jar --create --file build/libs/KyuubiSoftAPI-1.4.1.jar -C build/classes .
```

Output: `build/libs/KyuubiSoftAPI-1.4.1.jar`

## Integration with KyuubiSoft Panel

The panel will automatically detect and use this API when available on port 18085.
If the plugin is not installed, the panel falls back to log parsing.

## License

Part of the KyuubiSoft Panel project - GPL-3.0

## Author

KyuubiDDragon
