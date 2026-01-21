# API Documentation

Complete REST API reference for the KyuubiSoft Hytale Panel.

---

## Authentication

All API endpoints (except login) require a JWT Bearer Token:

```http
Authorization: Bearer <access_token>
```

### Get Token

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "your-password"
}
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "abc123...",
  "token_type": "bearer",
  "role": "administrator",
  "permissions": ["*"]
}
```

### Refresh Token

```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refresh_token": "abc123..."
}
```

### Token Lifetime
- **Access Token:** 15 minutes
- **Refresh Token:** 7 days

---

## Rate Limiting

| Endpoint | Limit |
|----------|-------|
| `/api/auth/login` | 5 attempts / 15 min (failed only) |
| `/api/auth/refresh` | 10 requests / minute |
| `/api/auth/ws-ticket` | 30 requests / minute |
| `/api/assets/item-icon/*` | 100 requests / minute / IP |

---

## Authentication (`/api/auth`)

### POST /api/auth/login
Login and get tokens.

**Request:**
```json
{
  "username": "string",
  "password": "string"
}
```

**Response:** Token object

---

### POST /api/auth/logout
Invalidate tokens (requires auth).

**Response:**
```json
{
  "message": "Logged out successfully"
}
```

---

### POST /api/auth/ws-ticket
Get WebSocket ticket for secure connection.

**Permission:** `console.view`

**Response:**
```json
{
  "ticket": "abc123...",
  "expiresIn": 30
}
```

---

### GET /api/auth/me
Get current user.

**Response:**
```json
{
  "username": "admin",
  "role": "administrator",
  "permissions": ["*"]
}
```

---

### GET /api/auth/users
List all users.

**Permission:** `users.view`

**Response:**
```json
{
  "users": [
    {
      "username": "admin",
      "roleId": "administrator",
      "created": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

### POST /api/auth/users
Create new user.

**Permission:** `users.create`

**Request:**
```json
{
  "username": "newuser",
  "password": "securepassword",
  "roleId": "moderator"
}
```

---

### PUT /api/auth/users/:username
Update user.

**Permission:** `users.edit`

**Request:**
```json
{
  "password": "newpassword",
  "roleId": "operator"
}
```

---

### DELETE /api/auth/users/:username
Delete user.

**Permission:** `users.delete`

---

## Server (`/api/server`)

### GET /api/server/status
Get server status.

**Permission:** `server.view_status`

**Response:**
```json
{
  "running": true,
  "status": "online",
  "uptime": 3600
}
```

---

### GET /api/server/stats
Get server statistics.

**Permission:** `server.view_status`

**Response:**
```json
{
  "cpu": 25.5,
  "memory": 2048,
  "players": 5
}
```

---

### GET /api/server/memory
Get detailed memory information.

**Permission:** `performance.view`

**Response:**
```json
{
  "available": true,
  "physical": {
    "total": 16.0,
    "free": 8.5
  },
  "heap": {
    "init": 3.0,
    "used": 2.1,
    "committed": 3.5,
    "max": 4.0
  }
}
```

---

### GET /api/server/quick-settings
Get Quick Settings.

**Permission:** `config.view`

**Response:**
```json
{
  "serverName": "My Server",
  "motd": "Welcome!",
  "password": "",
  "maxPlayers": 20,
  "maxViewRadius": 32,
  "defaultGameMode": "adventure"
}
```

---

### PUT /api/server/quick-settings
Update Quick Settings.

**Permission:** `config.edit`

**Request:**
```json
{
  "serverName": "New Name",
  "maxPlayers": 50
}
```

---

### POST /api/server/start
Start server.

**Permission:** `server.start`

---

### POST /api/server/stop
Stop server.

**Permission:** `server.stop`

---

### POST /api/server/restart
Restart server.

**Permission:** `server.restart`

---

## Console (`/api/console`)

### GET /api/console/logs
Get server logs.

**Permission:** `console.view`

**Query Parameters:**
- `tail` (optional): Number of lines (0-10000, default: 100)

**Response:**
```json
{
  "logs": [
    {
      "timestamp": "2024-01-01T12:00:00Z",
      "level": "INFO",
      "message": "Server started"
    }
  ],
  "count": 100
}
```

---

### POST /api/console/command
Execute command.

**Permission:** `console.execute`

**Request:**
```json
{
  "command": "/say Hello World!"
}
```

**Response:**
```json
{
  "success": true,
  "command": "/say Hello World!",
  "output": "Message sent"
}
```

---

## Players (`/api/players`)

### GET /api/players
List online players.

**Permission:** `players.view`

**Response:**
```json
{
  "players": [
    {
      "name": "Player1",
      "uuid": "abc123...",
      "online": true,
      "joinedAt": "2024-01-01T10:00:00Z"
    }
  ],
  "count": 1
}
```

---

### GET /api/players/all
All players (online + offline).

**Permission:** `players.view`

---

### GET /api/players/count
Player count.

**Permission:** `players.view`

**Response:**
```json
{
  "count": 5
}
```

---

### POST /api/players/:name/kick
Kick player.

**Permission:** `players.kick`

**Request:**
```json
{
  "reason": "Rule violation"
}
```

---

### POST /api/players/:name/ban
Ban player.

**Permission:** `players.ban`

**Request:**
```json
{
  "reason": "Cheating"
}
```

---

### DELETE /api/players/:name/ban
Unban player.

**Permission:** `players.unban`

---

### POST /api/players/:name/teleport
Teleport player.

**Permission:** `players.teleport`

**To coordinates:**
```json
{
  "x": 100,
  "y": 64,
  "z": -200
}
```

**To player:**
```json
{
  "target": "OtherPlayer"
}
```

---

### POST /api/players/:name/gamemode
Change game mode.

**Permission:** `players.gamemode`

**Request:**
```json
{
  "gamemode": "creative"
}
```

Allowed values: `creative`, `adventure`, `c`, `a`

---

### POST /api/players/:name/give
Give item.

**Permission:** `players.give`

**Request:**
```json
{
  "item": "Cobalt_Sword",
  "amount": 1
}
```

---

### POST /api/players/:name/heal
Heal player.

**Permission:** `players.heal`

---

### POST /api/players/:name/effect
Apply/remove effect.

**Permission:** `players.effects`

**Request:**
```json
{
  "effect": "speed",
  "action": "apply"
}
```

---

### GET /api/players/:name/deaths
Get death positions.

**Permission:** `players.view`

**Response:**
```json
{
  "player": "Player1",
  "positions": [
    {
      "world": "world",
      "day": 15,
      "position": {"x": 100, "y": 50, "z": -200}
    }
  ],
  "count": 1
}
```

---

### GET /api/players/chat
Get global chat.

**Permission:** `chat.view`

**Query Parameters:**
- `limit` (optional): Max results (default: 100)
- `offset` (optional): Pagination
- `days` (optional): Days back (default: 7, 0 = all)

---

## Backups (`/api/backups`)

### GET /api/backups
List all backups.

**Permission:** `backups.view`

**Response:**
```json
{
  "backups": [
    {
      "id": "backup_20240101_120000",
      "name": "Manual Backup",
      "timestamp": "2024-01-01T12:00:00Z",
      "size": 1048576
    }
  ],
  "storage": {
    "used": 5242880,
    "total": 10737418240,
    "percentage": 0.05
  }
}
```

---

### POST /api/backups
Create new backup.

**Permission:** `backups.create`

**Request:**
```json
{
  "name": "Before Update"
}
```

---

### POST /api/backups/:id/restore
Restore backup.

**Permission:** `backups.restore`

---

### GET /api/backups/:id/download
Download backup.

**Permission:** `backups.download`

**Response:** `.tar.gz` file

---

### DELETE /api/backups/:id
Delete backup.

**Permission:** `backups.delete`

---

## Roles (`/api/roles`)

### GET /api/roles
List all roles.

**Permission:** `roles.view`

**Response:**
```json
{
  "roles": [
    {
      "id": "administrator",
      "name": "Administrator",
      "description": "Full access",
      "permissions": ["*"],
      "color": "#FF0000",
      "isSystem": true
    }
  ]
}
```

---

### GET /api/roles/permissions
List available permissions.

**Permission:** `roles.view`

---

### POST /api/roles
Create new role.

**Permission:** `roles.manage`

**Request:**
```json
{
  "name": "Helper",
  "description": "Helps players",
  "permissions": ["players.view", "chat.view"],
  "color": "#00FF00"
}
```

---

### PUT /api/roles/:id
Update role.

**Permission:** `roles.manage`

---

### DELETE /api/roles/:id
Delete role.

**Permission:** `roles.manage`

> **Note:** System roles cannot be deleted.

---

## Scheduler (`/api/scheduler`)

### GET /api/scheduler/config
Get scheduler configuration.

**Permission:** `scheduler.view`

---

### PUT /api/scheduler/config
Update scheduler configuration.

**Permission:** `scheduler.edit`

---

### POST /api/scheduler/backup/run
Run backup immediately.

**Permission:** `scheduler.edit`

---

### GET /api/scheduler/quick-commands
List Quick Commands.

**Permission:** `scheduler.view`

---

### POST /api/scheduler/quick-commands
Create Quick Command.

**Permission:** `scheduler.edit`

**Request:**
```json
{
  "name": "Set Day",
  "command": "/time set day",
  "icon": "sun",
  "category": "Time"
}
```

---

### POST /api/scheduler/broadcast
Broadcast to all players.

**Permission:** `scheduler.edit`

**Request:**
```json
{
  "message": "Server restarting in 5 minutes!"
}
```

---

## Assets (`/api/assets`)

### GET /api/assets/status
Asset extraction status.

**Permission:** `assets.view`

---

### POST /api/assets/extract
Extract assets.

**Permission:** `assets.manage`

---

### GET /api/assets/browse
Browse asset directory.

**Permission:** `assets.view`

**Query Parameters:**
- `path` (optional): Path to browse

---

### GET /api/assets/search
Search assets.

**Permission:** `assets.view`

**Query Parameters:**
- `q` (required): Search term (min 2 characters)
- `content` (optional): Search file content
- `ext` (optional): File extensions (`.json,.lua`)
- `limit` (optional): Max results (default: 100)
- `regex` (optional): Regex search
- `glob` (optional): Glob pattern

---

### GET /api/assets/item-icon/:itemId
Get item icon (public, rate-limited).

**Response:** PNG image

---

## Health Check

### GET /api/health
Check service status.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

---

### GET /api/health/permissions
Check directory permissions.

**Response:**
```json
{
  "status": "ok",
  "directories": {
    "/opt/hytale/data": {"readable": true, "writable": true},
    "/opt/hytale/backups": {"readable": true, "writable": true}
  }
}
```

---

## WebSocket API

### Establish Connection

1. Get WebSocket ticket:
```http
POST /api/auth/ws-ticket
Authorization: Bearer <token>
```

2. Connect WebSocket:
```javascript
const ws = new WebSocket('ws://server:3000/ws?ticket=<ticket>');
```

### Receive Messages

```javascript
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data.type: 'log' | 'status' | 'player_join' | 'player_leave' | etc.
  console.log(data);
};
```

### Send Commands

```javascript
ws.send(JSON.stringify({
  type: 'command',
  command: '/say Hello!'
}));
```

---

## Error Handling

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 429 | Rate Limited |
| 500 | Server Error |

### Error Response

```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired token",
  "statusCode": 401
}
```

---

## Next Steps

- [[Security]] - Understand API security
- [[User-Management]] - Configure permissions
