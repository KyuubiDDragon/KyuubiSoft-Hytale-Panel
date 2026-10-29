# KyuubiSoft API Plugin

REST API and WebSocket plugin for KyuubiSoft Panel - provides accurate player data, server statistics, and real-time events.

> **2.0.0: every request needs a token.** The plugin refuses HTTP requests and
> WebSocket connections without `Authorization: Bearer <token>`. The
> KyuubiSoft Panel creates the token and writes it into the plugin config
> before each server start, so panel users don't have to do anything. See
> [Upgrading from 1.4.x](#upgrading-from-14x) if you call the API yourself.

## Features

- **Accurate Player Data** - Direct access to server player list (no log parsing),
  incl. real gamemode (Adventure/Creative) and health via the entity-stats component
- **Player Actions** - heal, kill, respawn, teleport, gamemode and clear-inventory,
  executed in-process through the server's own commands (no console round-trip)
- **World Information** - List all worlds with live player counts / tick state
- **Server Statistics** - TPS/MSPT (sampled from `World.getTick()`), memory, uptime
- **Real-time Events** - WebSocket for player join/leave/chat and periodic
  `player_position` frames with real client latency (`PacketHandler.getPingInfo`)
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

1. `authToken` in `config/kyuubisoft-api/config.json`
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
| `GET /api/server/info` | Server version, uptime, TPS/MSPT |
| `GET /api/server/performance` | CPU, threads, TPS (entities/chunks: -1 = unknown) |
| `GET /api/server/memory` | Heap usage, memory stats |
| `GET /metrics` | Prometheus exposition format |

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

### WebSocket

Connect to `ws://localhost:18085/ws` with the `Authorization` header on the
upgrade request (Node `ws`: `new WebSocket(url, { headers: { Authorization: 'Bearer …' } })`).
The token is not accepted in the URL, so it never ends up in access logs.

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

Config file: `config/kyuubisoft-api/config.json` (relative to the server's
working directory; in the panel's Docker setup `/opt/hytale/server/config/kyuubisoft-api/config.json`)

```json
{
  "httpPort": 18085,
  "authToken": "<64 hex characters, written by the panel>",
  "corsAllowedOrigins": [],
  "positionBroadcastIntervalMs": 2000
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `httpPort` | `18085` | Port for HTTP and WebSocket |
| `authToken` | `""` | Bearer token. Empty = API locked (503) |
| `corsAllowedOrigins` | `[]` | Explicit browser origins allowed to call the API, e.g. `["https://panel.example.com"]`. Empty = no CORS headers. `*` is rejected |
| `positionBroadcastIntervalMs` | `2000` | Interval of the `player_position` frames; `0` disables the ticker |
| `insecureDisableAuth` | `false` | Turns authentication off. For isolated development machines only; logs a security warning at every start. The panel never sets it |

The panel only touches `authToken` (and `authEnabled`, see below) when it
writes the file; all other keys you set stay as they are.

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
2. Copy `build/libs/KyuubiSoftAPI-2.0.0.jar` to your server's `mods/` folder
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
jar --create --file build/libs/KyuubiSoftAPI-2.0.0.jar -C build/classes .
```

Output: `build/libs/KyuubiSoftAPI-2.0.0.jar`

## Integration with KyuubiSoft Panel

The panel keeps one random token per server in its own data volume
(`plugin-tokens.json`), writes it into the plugin config before every start
and sends it with every request. If the plugin runs with an older token (for
example because the token was created while the server was already running),
the dashboard says so; a restart through the panel fixes it.
If the plugin is not installed or not reachable, the panel falls back to log parsing.

## License

Part of the KyuubiSoft Panel project - GPL-3.0

## Author

KyuubiDDragon
