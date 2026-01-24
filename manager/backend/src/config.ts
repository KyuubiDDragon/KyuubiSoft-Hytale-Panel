import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config();

// ============================================================
// Config.json Integration
// ============================================================

// Path to config.json (same as in configService.ts)
const DATA_PATH = process.env.DATA_PATH || '/opt/hytale/data';
const CONFIG_FILE_PATH = path.join(DATA_PATH, 'config.json');

// Interface for config.json (simplified for this module)
interface ConfigJson {
  setupComplete?: boolean;
  jwtSecret?: string;
  corsOrigins?: string[];
  network?: {
    trustProxy?: boolean;
    accessMode?: string;
    domain?: string;
  };
  integrations?: {
    modtaleApiKey?: string;
    stackmartApiKey?: string;
    webmap?: boolean;
  };
  automation?: {
    backups?: {
      enabled?: boolean;
      interval?: string;
      retention?: number;
    };
    restart?: {
      enabled?: boolean;
      schedule?: string;
      warnMinutes?: number;
    };
  };
  plugin?: {
    kyuubiApiInstalled?: boolean;
    version?: string;
  };
}

// Try to load config.json synchronously at startup
let configJson: ConfigJson | null = null;
try {
  if (fs.existsSync(CONFIG_FILE_PATH)) {
    const content = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    configJson = JSON.parse(content);
    console.log('[Config] Loaded configuration from config.json');
  }
} catch (error) {
  console.log('[Config] Could not load config.json, using environment variables');
}

// Helper to get value from config.json or fall back to env
function getConfigValue<T>(
  configJsonValue: T | undefined,
  envValue: T
): T {
  return configJsonValue !== undefined ? configJsonValue : envValue;
}

// ============================================================
// Security Defaults
// ============================================================

// Default insecure values that should be changed
const INSECURE_DEFAULTS = {
  passwords: ['changeme', 'admin', 'password', '123456', 'test', ''],
  jwtSecrets: ['please-change-this-secret-key', 'secret', 'your-secret-key', ''],
};

// Security mode: 'strict' blocks startup with insecure config, 'warn' only logs warnings
const securityMode = process.env.SECURITY_MODE || 'strict';

// ============================================================
// Configuration Object
// ============================================================

// Determine JWT secret: prefer config.json, then env, then empty
const jwtSecretFromConfig = configJson?.jwtSecret;
const jwtSecretFromEnv = process.env.JWT_SECRET || '';
const effectiveJwtSecret = jwtSecretFromConfig || jwtSecretFromEnv;

// Determine CORS origins: prefer config.json, then env
const corsFromConfig = configJson?.corsOrigins;
const corsFromEnv = process.env.CORS_ORIGINS || '';
const effectiveCors = corsFromConfig
  ? corsFromConfig.join(',')
  : corsFromEnv;

// Determine trust proxy: prefer config.json, then env
const trustProxyFromConfig = configJson?.network?.trustProxy;
const trustProxyFromEnv = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';
const effectiveTrustProxy = trustProxyFromConfig !== undefined
  ? trustProxyFromConfig
  : trustProxyFromEnv;

// Determine modtale API key: prefer config.json, then env
const modtaleApiKeyFromConfig = configJson?.integrations?.modtaleApiKey;
const modtaleApiKeyFromEnv = process.env.MODTALE_API_KEY || '';
const effectiveModtaleApiKey = modtaleApiKeyFromConfig || modtaleApiKeyFromEnv;

export const config = {
  // ============================================================
  // Values that can come from config.json (after setup)
  // ============================================================

  // JWT Secret - from config.json if available, otherwise from env
  // Note: After setup, this comes from config.json and MANAGER_PASSWORD is not used
  jwtSecret: effectiveJwtSecret,
  jwtExpiresIn: '15m',
  refreshExpiresIn: '7d',

  // CORS Origins - from config.json if available, otherwise from env
  corsOrigins: effectiveCors,

  // Reverse Proxy Support - from config.json if available, otherwise from env
  trustProxy: effectiveTrustProxy,

  // Modtale Integration - from config.json if available, otherwise from env
  modtaleApiKey: effectiveModtaleApiKey,

  // WebMap enabled - from config.json after setup
  webmapEnabled: configJson?.integrations?.webmap ?? false,

  // ============================================================
  // Legacy values (kept for backward compatibility during migration)
  // These are only used if config.json doesn't exist (pre-setup)
  // ============================================================

  // Manager Authentication (only used before setup completes)
  // After setup, authentication is handled via users.json
  managerUsername: process.env.MANAGER_USERNAME || '',
  managerPassword: process.env.MANAGER_PASSWORD || '',

  // ============================================================
  // Docker/Infrastructure values (always from env)
  // These cannot be changed via the UI as they affect Docker setup
  // ============================================================

  // Game Server Container name (Docker-only, cannot change via UI)
  gameContainerName: process.env.GAME_CONTAINER_NAME || 'hytale',

  // Host data path (base path for all data directories)
  hostDataPath: process.env.HOST_DATA_PATH || '/opt/hytale',

  // Paths (inside manager container - Docker volume mounts)
  // Derived from HOST_DATA_PATH if individual path variables are not set
  serverPath: process.env.SERVER_PATH || `${process.env.HOST_DATA_PATH || '/opt/hytale'}/server`,
  backupsPath: process.env.BACKUPS_PATH || `${process.env.HOST_DATA_PATH || '/opt/hytale'}/backups`,
  dataPath: process.env.DATA_PATH || `${process.env.HOST_DATA_PATH || '/opt/hytale'}/data`,
  modsPath: process.env.MODS_PATH || `${process.env.HOST_DATA_PATH || '/opt/hytale'}/mods`,
  pluginsPath: process.env.PLUGINS_PATH || `${process.env.HOST_DATA_PATH || '/opt/hytale'}/plugins`,
  assetsPath: process.env.ASSETS_PATH || `${process.env.HOST_DATA_PATH || '/opt/hytale'}/assets`,

  // Server port - internal port is always 18080, external port from MANAGER_PORT
  // Internal port is what Express listens on inside the container
  // External port is what users access from the host (for display purposes)
  port: 18080,  // Always 18080 inside container
  externalPort: parseInt(process.env.MANAGER_PORT || '18080', 10),  // Host-mapped port

  // Game server port (for display in setup wizard)
  serverPort: parseInt(process.env.SERVER_PORT || '5520', 10),

  // WebMap ports (for display in setup wizard)
  webMapPort: parseInt(process.env.WEBMAP_PORT || '18081', 10),
  webMapWsPort: parseInt(process.env.WEBMAP_WS_PORT || '18082', 10),

  // Timezone
  tz: process.env.TZ || 'Europe/Berlin',

  // Security mode: 'strict' (default) or 'warn'
  securityMode,

  // ============================================================
  // Setup state
  // ============================================================

  // Whether setup has been completed (config.json exists and setupComplete is true)
  setupComplete: configJson?.setupComplete || false,
};

// ============================================================
// Config Reload Function
// ============================================================

/**
 * Reloads the configuration from config.json
 *
 * Call this after setup completes to update the in-memory config
 * with the new values from config.json without restarting the server.
 */
export function reloadConfigFromFile(): void {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const content = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      const newConfigJson = JSON.parse(content) as ConfigJson;

      // Update mutable config values
      if (newConfigJson.jwtSecret) {
        (config as { jwtSecret: string }).jwtSecret = newConfigJson.jwtSecret;
      }
      if (newConfigJson.corsOrigins) {
        (config as { corsOrigins: string }).corsOrigins = newConfigJson.corsOrigins.join(',');
      }
      if (newConfigJson.network?.trustProxy !== undefined) {
        (config as { trustProxy: boolean }).trustProxy = newConfigJson.network.trustProxy;
      }
      if (newConfigJson.integrations?.modtaleApiKey !== undefined) {
        (config as { modtaleApiKey: string }).modtaleApiKey = newConfigJson.integrations.modtaleApiKey;
      }
      if (newConfigJson.integrations?.webmap !== undefined) {
        (config as { webmapEnabled: boolean }).webmapEnabled = newConfigJson.integrations.webmap;
      }
      if (newConfigJson.setupComplete !== undefined) {
        (config as { setupComplete: boolean }).setupComplete = newConfigJson.setupComplete;
      }

      console.log('[Config] Configuration reloaded from config.json');
    }
  } catch (error) {
    console.error('[Config] Failed to reload config.json:', error);
  }
}

// ============================================================
// Security Configuration Check
// ============================================================

/**
 * Validates security configuration on startup
 *
 * In strict mode (default), critical issues will prevent startup.
 * In warn mode, only warnings are logged (for development/closed networks).
 *
 * If no config.json exists, we're in setup mode - skip security check.
 * If setup is complete (config.json exists with setupComplete: true),
 * security validation is skipped as credentials are managed differently.
 */
export function checkSecurityConfig(): void {
  // Check if config.json exists (regardless of setupComplete status)
  const configJsonExists = fs.existsSync(CONFIG_FILE_PATH);

  // If no config.json exists, we're in SETUP MODE - skip security check
  // The setup wizard will handle initial configuration
  if (!configJsonExists) {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                   🚀 SETUP MODE 🚀                           ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  No configuration found. Starting in setup mode.             ║');
    console.log('║                                                              ║');
    console.log('║  Open the panel in your browser to complete the setup:       ║');
    console.log(`║  → http://localhost:${config.externalPort.toString().padEnd(38)}║`);
    console.log('║                                                              ║');
    console.log('║  The setup wizard will guide you through:                    ║');
    console.log('║    • Creating an admin account                               ║');
    console.log('║    • Downloading server files                                ║');
    console.log('║    • Configuring your server                                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('\n');
    return;
  }

  // Skip security check if setup is complete
  // After setup, credentials are stored in config.json (hashed) and users.json
  if (config.setupComplete) {
    console.log('[Security] Setup complete - using config.json for security settings');
    return;
  }

  const criticalErrors: string[] = [];
  const warnings: string[] = [];

  // Critical: Username must be set (only required before setup)
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

// ============================================================
// Utility Functions
// ============================================================

/**
 * Helper to wrap long text for console output
 */
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

/**
 * Generate a secure random string for JWT secrets
 *
 * @deprecated Use configService.generateJwtSecret() instead
 */
export function generateSecureSecret(): string {
  return crypto.randomBytes(48).toString('base64');
}

/**
 * Check if setup wizard should be shown
 *
 * @returns True if config.json doesn't exist or setupComplete is false
 */
export function isSetupRequired(): boolean {
  return !config.setupComplete;
}

/**
 * Get the path to config.json
 */
export function getConfigFilePath(): string {
  return CONFIG_FILE_PATH;
}
