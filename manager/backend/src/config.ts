import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// Default insecure values that should be changed
const INSECURE_DEFAULTS = {
  passwords: ['changeme', 'admin', 'password', '123456', 'test', ''],
  jwtSecrets: ['please-change-this-secret-key', 'secret', 'your-secret-key', ''],
};

// Security mode: 'strict' blocks startup with insecure config, 'warn' only logs warnings
const securityMode = process.env.SECURITY_MODE || 'strict';

export const config = {
  // Manager Authentication
  managerUsername: process.env.MANAGER_USERNAME || '',
  managerPassword: process.env.MANAGER_PASSWORD || '',
  jwtSecret: process.env.JWT_SECRET || '',
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
  assetsPath: process.env.ASSETS_PATH || '/opt/hytale/assets', // Extracted assets cache (not backed up)

  // Server
  port: parseInt(process.env.MANAGER_PORT || '18080', 10),
  // CORS: No default - must be explicitly configured for security
  corsOrigins: process.env.CORS_ORIGINS || '',

  // Reverse Proxy Support
  // Set to true/1 when running behind a reverse proxy (nginx, traefik, etc.)
  // This enables proper handling of X-Forwarded-* headers
  trustProxy: process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1',

  // Timezone
  tz: process.env.TZ || 'Europe/Berlin',

  // Modtale Integration
  modtaleApiKey: process.env.MODTALE_API_KEY || '',

  // Host data path (for error messages - shows the actual host path)
  hostDataPath: process.env.HOST_DATA_PATH || '/opt/hytale',

  // Security mode: 'strict' (default) or 'warn'
  securityMode,
};

// SECURITY: Validate security configuration on startup
// In strict mode (default), critical issues will prevent startup
// In warn mode, only warnings are logged (for development/closed networks)
export function checkSecurityConfig(): void {
  const criticalErrors: string[] = [];
  const warnings: string[] = [];

  // Critical: Username must be set
  if (!config.managerUsername) {
    criticalErrors.push('MANAGER_USERNAME is not set!');
  }

  // Critical: Password must be set and not be a weak default
  if (!config.managerPassword) {
    criticalErrors.push('MANAGER_PASSWORD is not set!');
  } else if (INSECURE_DEFAULTS.passwords.includes(config.managerPassword)) {
    criticalErrors.push('MANAGER_PASSWORD is using a default/weak value!');
  } else if (config.managerPassword.length < 12) {
    warnings.push('MANAGER_PASSWORD should be at least 12 characters.');
  }

  // Critical: JWT secret must be set and not be a weak default
  if (!config.jwtSecret) {
    criticalErrors.push('JWT_SECRET is not set! Generate with: openssl rand -base64 48');
  } else if (INSECURE_DEFAULTS.jwtSecrets.includes(config.jwtSecret)) {
    criticalErrors.push('JWT_SECRET is using a default value! Generate with: openssl rand -base64 48');
  } else if (config.jwtSecret.length < 32) {
    criticalErrors.push('JWT_SECRET must be at least 32 characters!');
  }

  // Critical: CORS must be explicitly configured
  if (!config.corsOrigins) {
    criticalErrors.push('CORS_ORIGINS is not set! Set to specific origins (e.g., "https://panel.example.com")');
  } else if (config.corsOrigins === '*') {
    warnings.push('CORS_ORIGINS is set to "*" (allows all origins). Consider restricting in production.');
  }

  // Display warnings (always shown)
  if (warnings.length > 0) {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                    ⚠️  SECURITY WARNINGS ⚠️                    ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    for (const warning of warnings) {
      const lines = wrapText(warning, 56);
      for (const line of lines) {
        console.log(`║  • ${line.padEnd(58)}║`);
      }
    }
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('\n');
  }

  // Handle critical errors based on security mode
  if (criticalErrors.length > 0) {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                   🛑 SECURITY CONFIGURATION 🛑               ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    for (const error of criticalErrors) {
      const lines = wrapText(error, 56);
      for (const line of lines) {
        console.log(`║  ✗ ${line.padEnd(58)}║`);
      }
    }
    console.log('╠══════════════════════════════════════════════════════════════╣');

    if (config.securityMode === 'strict') {
      console.log('║  Mode: STRICT - Server will NOT start until fixed!          ║');
      console.log('║                                                              ║');
      console.log('║  Required environment variables:                             ║');
      console.log('║    MANAGER_USERNAME=your_admin_username                      ║');
      console.log('║    MANAGER_PASSWORD=your_secure_password_12_chars_min        ║');
      console.log('║    JWT_SECRET=$(openssl rand -base64 48)                     ║');
      console.log('║    CORS_ORIGINS=https://your-domain.com                      ║');
      console.log('║                                                              ║');
      console.log('║  To bypass (NOT recommended for production):                 ║');
      console.log('║    Set SECURITY_MODE=warn                                    ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('\n');
      process.exit(1);
    } else {
      console.log('║  Mode: WARN - Server starting despite security issues!       ║');
      console.log('║  ⚠️  DO NOT expose this server to the public internet! ⚠️     ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('\n');
    }
  }
}

// Helper to wrap long text
function wrapText(text: string, maxLength: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxLength) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

// Generate a secure random string for JWT secrets
export function generateSecureSecret(): string {
  return crypto.randomBytes(48).toString('base64');
}
