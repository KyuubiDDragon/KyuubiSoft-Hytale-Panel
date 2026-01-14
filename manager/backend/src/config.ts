import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Manager Authentication
  managerUsername: process.env.MANAGER_USERNAME || 'admin',
  managerPassword: process.env.MANAGER_PASSWORD || 'changeme',
  jwtSecret: process.env.JWT_SECRET || 'please-change-this-secret-key',
  jwtExpiresIn: '15m',
  refreshExpiresIn: '7d',

  // Game Server Container
  gameContainerName: process.env.GAME_CONTAINER_NAME || 'hytale',

  // Paths (inside manager container)
  serverPath: process.env.SERVER_PATH || '/opt/hytale/server',
  backupsPath: process.env.BACKUPS_PATH || '/opt/hytale/backups',
  dataPath: process.env.DATA_PATH || '/opt/hytale/data',
  modsPath: process.env.MODS_PATH || '/opt/hytale/mods',
  pluginsPath: process.env.PLUGINS_PATH || '/opt/hytale/plugins',

  // Server
  port: parseInt(process.env.MANAGER_PORT || '18080', 10),
  corsOrigins: process.env.CORS_ORIGINS || '*',

  // Timezone
  tz: process.env.TZ || 'Europe/Berlin',
};
