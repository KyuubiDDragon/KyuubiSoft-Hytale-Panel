# User Management

Guide for managing users, roles, and permissions.

---

## Overview

The KyuubiSoft Hytale Panel provides a comprehensive user management system:

- **Multi-User Support** - Multiple administrators possible
- **Role-Based Access Control (RBAC)** - 60+ granular permissions
- **Custom Roles** - Create roles with specific permissions
- **Audit Trail** - All actions are logged

---

## Users

### Create User

1. Navigate to **Users** in the panel
2. Click **New User**
3. Fill out the form:
   - **Username:** Unique name
   - **Password:** At least 8 characters
   - **Role:** Assigned role

### Edit User

1. Click on the user in the list
2. Change password or role
3. Save

### Delete User

1. Click the delete icon
2. Confirm deletion

> **Note:** You cannot delete yourself.

### Password Requirements

- At least 8 characters
- For admins: 12+ characters recommended
- Cannot be `admin`, `password`, `123456`

---

## Roles

### System Roles

These roles are predefined and cannot be deleted:

#### Administrator
- **Description:** Full access to all features
- **Permissions:** `*` (Wildcard - all permissions)
- **Color:** Red

#### Moderator
- **Description:** Player management and chat moderation
- **Permissions:**
  - View dashboard
  - View, kick, ban, unban players
  - View chat
  - Manage whitelist
- **Color:** Blue

#### Operator
- **Description:** Server management and technical tasks
- **Permissions:**
  - View dashboard
  - Start, stop, restart server
  - View console and execute commands
  - View performance
  - Manage backups
  - Manage scheduler
  - Edit configuration
- **Color:** Green

#### Viewer
- **Description:** Read-only access
- **Permissions:**
  - View dashboard
  - View server status
  - View players
  - View chat
  - View performance
- **Color:** Gray

### Custom Roles

You can create custom roles with any permission combinations.

#### Create Role

1. Navigate to **Roles** in the panel
2. Click **New Role**
3. Fill out the form:
   - **Name:** Role name
   - **Description:** What the role does
   - **Color:** Badge color (hex code)
   - **Permissions:** Select permissions

#### Example: Helper Role

```
Name: Helper
Description: Helps players with questions
Color: #00FF00
Permissions:
  - dashboard.view
  - players.view
  - players.message
  - chat.view
```

#### Example: Builder Role

```
Name: Builder
Description: Can edit worlds
Color: #FFA500
Permissions:
  - dashboard.view
  - server.view_status
  - console.view
  - console.execute
  - worlds.view
  - assets.view
```

---

## Permissions

### Permission Categories

#### Dashboard
| Permission | Description |
|------------|-------------|
| `dashboard.view` | View dashboard |

#### Server
| Permission | Description |
|------------|-------------|
| `server.view_status` | View server status |
| `server.start` | Start server |
| `server.stop` | Stop server |
| `server.restart` | Restart server |

#### Console
| Permission | Description |
|------------|-------------|
| `console.view` | View console/logs |
| `console.execute` | Execute commands |

#### Performance
| Permission | Description |
|------------|-------------|
| `performance.view` | View performance metrics |

#### Players
| Permission | Description |
|------------|-------------|
| `players.view` | View player list |
| `players.kick` | Kick players |
| `players.ban` | Ban players |
| `players.unban` | Unban players |
| `players.teleport` | Teleport players |
| `players.gamemode` | Change game mode |
| `players.give` | Give items |
| `players.heal` | Heal players |
| `players.kill` | Kill players |
| `players.respawn` | Respawn players |
| `players.effects` | Apply effects |
| `players.clear_inventory` | Clear inventory |
| `players.message` | Send private message |
| `players.op` | Manage operator status |
| `players.whitelist` | Manage whitelist |
| `players.edit` | Edit player data |

#### Chat
| Permission | Description |
|------------|-------------|
| `chat.view` | View chat history |
| `chat.delete` | Delete chat messages |

#### Backups
| Permission | Description |
|------------|-------------|
| `backups.view` | View backups |
| `backups.create` | Create backups |
| `backups.restore` | Restore backups |
| `backups.delete` | Delete backups |
| `backups.download` | Download backups |

#### Scheduler
| Permission | Description |
|------------|-------------|
| `scheduler.view` | View scheduler |
| `scheduler.edit` | Edit scheduler |

#### Worlds
| Permission | Description |
|------------|-------------|
| `worlds.view` | View worlds |

#### Mods
| Permission | Description |
|------------|-------------|
| `mods.view` | View mods |
| `mods.install` | Install mods |
| `mods.delete` | Delete mods |
| `mods.config` | Edit mod configuration |

#### Plugins
| Permission | Description |
|------------|-------------|
| `plugins.view` | View plugins |
| `plugins.install` | Install plugins |
| `plugins.delete` | Delete plugins |
| `plugins.config` | Edit plugin configuration |

#### Configuration
| Permission | Description |
|------------|-------------|
| `config.view` | View configuration |
| `config.edit` | Edit configuration |

#### Assets
| Permission | Description |
|------------|-------------|
| `assets.view` | Browse assets |
| `assets.manage` | Manage assets (extract) |

#### Users
| Permission | Description |
|------------|-------------|
| `users.view` | View users |
| `users.create` | Create users |
| `users.edit` | Edit users |
| `users.delete` | Delete users |

#### Roles
| Permission | Description |
|------------|-------------|
| `roles.view` | View roles |
| `roles.manage` | Create/edit/delete roles |

#### Activity
| Permission | Description |
|------------|-------------|
| `activity.view` | View activity log |
| `activity.clear` | Clear activity log |

#### Hytale Auth
| Permission | Description |
|------------|-------------|
| `hytale_auth.manage` | Manage Hytale authentication |

#### Settings
| Permission | Description |
|------------|-------------|
| `settings.view` | View settings |
| `settings.edit` | Edit settings |

---

## Wildcard Permission

The `*` permission grants access to ALL features:

```
permissions: ["*"]
```

> **Warning:** Only use for trusted administrators!

---

## Best Practices

### Principle of Least Privilege

Give users only the permissions they actually need:

```
❌ Bad: Give all helpers Administrator role
✅ Good: Custom Helper role with specific permissions
```

### Role Planning

Plan your roles before creation:

| Role | Purpose | Permissions |
|------|---------|-------------|
| Admin | Server management | `*` |
| Moderator | Player moderation | players.*, chat.* |
| Helper | Player support | players.view, chat.view, players.message |
| Builder | World design | console.execute, worlds.view |

### Regular Review

- Regularly review the user list
- Remove inactive users
- Update roles as needed

---

## Activity Log

All user actions are logged:

### View

1. Navigate to **Activity Log**
2. Filter by:
   - Category (player, server, backup, etc.)
   - User
   - Time period

### Logged Actions

- Login/Logout
- Player actions (Kick, Ban, etc.)
- Server Start/Stop
- Configuration changes
- User/Role management
- Backup operations

### Example Entry

```
2024-01-01 12:00:00 | admin | Player kicked | Player1 | Reason: AFK
```

---

## API Usage

### Create User via API

```bash
curl -X POST http://localhost:18080/api/auth/users \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "newuser",
    "password": "securepassword123",
    "roleId": "moderator"
  }'
```

### Create Role via API

```bash
curl -X POST http://localhost:18080/api/roles \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Helper",
    "description": "Helps players",
    "permissions": ["players.view", "chat.view", "players.message"],
    "color": "#00FF00"
  }'
```

---

## Troubleshooting

### Cannot Login

1. Check username/password
2. Check if user exists
3. Check rate limiting (5 attempts / 15 min)

### Permission Denied

1. Check assigned role
2. Check role permissions
3. Check if permission is spelled correctly

### Cannot Delete Role

- System roles (Administrator, Moderator, Operator, Viewer) cannot be deleted
- Role must not be assigned to any user

---

## Next Steps

- [[Security]] - More about security
- [[Features]] - All panel features
- [[API-Documentation]] - API for user management
