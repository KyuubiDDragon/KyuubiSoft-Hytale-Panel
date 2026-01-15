# Mod Configurations

This folder contains example configurations for optional mods.

## EasyWebMap

EasyWebMap is a live web map mod for Hytale servers.

### Installation

1. Download EasyWebMap from [CurseForge](https://www.curseforge.com/hytale/mods/easywebmap)
2. Place the JAR file in `/opt/hytale/mods/`
3. Copy the config:
   ```bash
   mkdir -p /opt/hytale/server/config/EasyWebMap
   cp configs/EasyWebMap/config.json /opt/hytale/server/config/EasyWebMap/
   ```
4. Restart the server

### Access

- Web Map: `http://your-server:18081`
- WebSocket: `ws://your-server:18082`

### API Endpoints

- `GET /api/worlds` - List all worlds
- `GET /api/players/{world}` - Get players in a world
- `GET /api/tiles/{world}/{zoom}/{x}/{y}` - Get map tile
