# KyuubiSoft API Plugin

REST API and WebSocket plugin for KyuubiSoft Panel - provides accurate player data, server statistics, and real-time events.

## Features

- **Accurate Player Data** - Direct access to server player list (no log parsing)
- **World Information** - List all worlds with player counts
- **Server Statistics** - TPS, memory, uptime, and more
- **Real-time Events** - WebSocket for instant player join/leave notifications

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

### Server

| Endpoint | Description |
|----------|-------------|
| `GET /api/server/info` | Server version, uptime, TPS |
| `GET /api/server/performance` | CPU, entities, chunks |
| `GET /api/server/memory` | Heap usage, memory stats |

### WebSocket

Connect to `ws://localhost:18085/ws` to receive real-time events:

```json
{ "type": "player_join", "player": "Steve", "uuid": "...", "timestamp": "..." }
{ "type": "player_leave", "player": "Steve", "uuid": "...", "timestamp": "..." }
{ "type": "tps_update", "tps": 19.8, "mspt": 51.2, "timestamp": "..." }
```

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
  "logRequests": false
}
```

## Installation

1. Build the plugin: `./gradlew shadowJar`
2. Copy `build/libs/KyuubiSoftAPI-1.0.0.jar` to your server's `mods/` folder
3. Restart the server
4. API will be available at `http://localhost:18085`

## Building

```bash
cd plugins/kyuubisoft-api
./gradlew shadowJar
```

Output: `build/libs/KyuubiSoftAPI-1.0.0.jar`

## Integration with KyuubiSoft Panel

The panel will automatically detect and use this API when available on port 18085.
If the plugin is not installed, the panel falls back to log parsing.

## License

Part of the KyuubiSoft Panel project - GPL-3.0

## Author

KyuubiDDragon
