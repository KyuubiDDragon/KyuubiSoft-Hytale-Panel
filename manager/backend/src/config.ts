import dotenv from 'dotenv';

dotenv.config();

// Default insecure values that should be changed
const INSECURE_DEFAULTS = {
  passwords: ['changeme', 'admin', 'password', '123456', 'test'],
  jwtSecrets: ['please-change-this-secret-key', 'secret', 'your-secret-key'],
};

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

  // Modtale Integration
  modtaleApiKey: process.env.MODTALE_API_KEY || '',
};

// SECURITY: Check for insecure default credentials on startup
export function checkSecurityConfig(): void {
  const warnings: string[] = [];

  if (INSECURE_DEFAULTS.passwords.includes(config.managerPassword)) {
    warnings.push('MANAGER_PASSWORD is using a default/weak value!');
  }

  if (config.managerPassword.length < 8) {
    warnings.push('MANAGER_PASSWORD is too short (minimum 8 characters recommended)!');
  }

  if (INSECURE_DEFAULTS.jwtSecrets.includes(config.jwtSecret)) {
    warnings.push('JWT_SECRET is using a default value! Generate a secure one with: openssl rand -base64 32');
  }

  if (config.jwtSecret.length < 32) {
    warnings.push('JWT_SECRET is too short (minimum 32 characters recommended)!');
  }

  if (config.corsOrigins === '*') {
    warnings.push('CORS_ORIGINS is set to "*" (allows all origins). Consider restricting in production.');
  }

  if (warnings.length > 0) {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                    ⚠️  SECURITY WARNINGS ⚠️                    ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    for (const warning of warnings) {
      console.log(`║  • ${warning.padEnd(58)}║`);
    }
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  Please update your .env file or environment variables!      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('\n');
  }
}
