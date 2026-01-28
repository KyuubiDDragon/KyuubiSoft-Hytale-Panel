/**
 * Config Service for the Hytale Panel Setup Wizard
 *
 * Handles config.json management, including:
 * - Loading and saving configuration
 * - Generating secure JWT secrets
 * - Password hashing with bcrypt
 * - Migration from .env values
 */

import { readFile, writeFile, mkdir, rename, access, constants } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// ============================================================
// Configuration Interface
// ============================================================

export interface PanelConfig {
  setupComplete: boolean;
  setupCompletedAt?: string;
  language: string;
  admin: {
    username: string;
    passwordHash: string;
  };
  jwtSecret: string;
  corsOrigins: string[];
  server: {
    name: string;
    motd: string;
    maxPlayers: number;
    gameMode: string;
    password: string;
    whitelist: boolean;
    allowOp: boolean;
  };
  performance: {
    minRam: string;
    maxRam: string;
    viewRadius: number;
  };
  automation: {
    backups: {
      enabled: boolean;
      interval: string;
      retention: number;
    };
    restart: {
      enabled: boolean;
      schedule: string;
      warnMinutes: number;
    };
  };
  assets: {
    extracted: boolean;
    extractedAt?: string;
    path: string;
    sizeBytes?: number;
  };
  integrations: {
    modtaleApiKey: string;
    stackmartApiKey: string;
    webmap: boolean;
  };
  network: {
    trustProxy: boolean;
  };
  plugin: {
    kyuubiApiInstalled: boolean;
    version?: string;
  };
}

// ============================================================
// Constants
// ============================================================

// Config file location inside container (persistent volume)
const DATA_PATH = process.env.MANAGER_DATA_PATH || '/app/data';
const CONFIG_FILENAME = 'config.json';
const CONFIG_TEMP_SUFFIX = '.tmp';

// Bcrypt cost factor (same as users.ts for consistency)
const BCRYPT_ROUNDS = 12;

// JWT secret length (64 characters = 48 bytes base64)
const JWT_SECRET_BYTES = 48;

// ============================================================
// Default Configuration
// ============================================================

/**
 * Returns the default configuration with sensible defaults
 */
export function getDefaultConfig(): PanelConfig {
  return {
    setupComplete: false,
    language: 'en',
    admin: {
      username: '',
      passwordHash: '',
    },
    jwtSecret: '',
    corsOrigins: [],
    server: {
      name: 'My Hytale Server',
      motd: 'Welcome to Hytale!',
      maxPlayers: 20,
      gameMode: 'Adventure',
      password: '',
      whitelist: false,
      allowOp: true,
    },
    performance: {
      minRam: '3G',
      maxRam: '4G',
      viewRadius: 16,
    },
    automation: {
      backups: {
        enabled: true,
        interval: '6h',
        retention: 7,
      },
      restart: {
        enabled: false,
        schedule: '0 4 * * *',
        warnMinutes: 5,
      },
    },
    assets: {
      extracted: false,
      path: process.env.ASSETS_PATH || '/opt/hytale/assets',
    },
    integrations: {
      modtaleApiKey: '',
      stackmartApiKey: '',
      webmap: false,
    },
    network: {
      trustProxy: false,
    },
    plugin: {
      kyuubiApiInstalled: false,
    },
  };
}

// ============================================================
// Path Functions
// ============================================================

/**
 * Returns the path to the config.json file
 */
export function getConfigPath(): string {
  return path.join(DATA_PATH, CONFIG_FILENAME);
}

/**
 * Returns the path for temporary config file (used for atomic writes)
 */
function getTempConfigPath(): string {
  return path.join(DATA_PATH, CONFIG_FILENAME + CONFIG_TEMP_SUFFIX);
}

// ============================================================
// Config File Operations
// ============================================================

/**
 * Ensures the data directory exists
 */
async function ensureDataDir(): Promise<void> {
  try {
    await mkdir(DATA_PATH, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

/**
 * Checks if config.json exists
 */
export async function configExists(): Promise<boolean> {
  try {
    await access(getConfigPath(), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads config.json or returns default configuration
 *
 * @returns The loaded configuration or defaults if file doesn't exist
 */
export async function loadConfig(): Promise<PanelConfig> {
  const configPath = getConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const loadedConfig = JSON.parse(content) as Partial<PanelConfig>;

    // Merge with defaults to ensure all fields exist (handles migrations)
    const defaults = getDefaultConfig();
    const config = deepMerge(defaults, loadedConfig);

    return config;
  } catch (error) {
    // File doesn't exist or is invalid - return defaults
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('[ConfigService] config.json not found, using defaults');
    } else {
      console.error('[ConfigService] Error loading config.json:', error);
    }
    return getDefaultConfig();
  }
}

/**
 * Saves config.json atomically (write to temp file, then rename)
 *
 * This prevents data corruption if the process crashes during write
 *
 * @param config - The configuration to save
 */
export async function saveConfig(config: PanelConfig): Promise<void> {
  await ensureDataDir();

  const configPath = getConfigPath();
  const tempPath = getTempConfigPath();

  // Write to temporary file first
  const content = JSON.stringify(config, null, 2);
  await writeFile(tempPath, content, 'utf-8');

  // Atomically rename temp file to actual config file
  await rename(tempPath, configPath);

  console.log('[ConfigService] Configuration saved successfully');
}

/**
 * Updates specific fields in the configuration
 *
 * @param updates - Partial configuration to merge
 * @returns The updated configuration
 */
export async function updateConfig(updates: Partial<PanelConfig>): Promise<PanelConfig> {
  const current = await loadConfig();
  const updated = deepMerge(current, updates);
  await saveConfig(updated);
  return updated;
}

// ============================================================
// Security Functions
// ============================================================

/**
 * Generates a cryptographically secure 64-character JWT secret
 *
 * Uses crypto.randomBytes for secure random generation
 *
 * @returns A 64-character base64-encoded secret
 */
export function generateJwtSecret(): string {
  return crypto.randomBytes(JWT_SECRET_BYTES).toString('base64');
}

/**
 * Hashes a password using bcrypt
 *
 * Uses async bcrypt to prevent blocking the event loop
 *
 * @param password - The plain text password to hash
 * @returns The bcrypt hash
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Validates a password against a bcrypt hash
 *
 * Uses async bcrypt to prevent blocking the event loop
 *
 * @param password - The plain text password to verify
 * @param hash - The bcrypt hash to compare against
 * @returns True if the password matches
 */
export async function validatePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ============================================================
// Migration Functions
// ============================================================

/**
 * Migrates configuration from .env environment variables
 *
 * Reads existing .env values and uses them as defaults for the new config.json
 * This provides a smooth upgrade path for existing installations.
 *
 * @returns Configuration with values from environment variables
 */
export async function migrateFromEnv(): Promise<PanelConfig> {
  const config = getDefaultConfig();

  // Admin credentials from env
  const envUsername = process.env.MANAGER_USERNAME;
  const envPassword = process.env.MANAGER_PASSWORD;

  if (envUsername && envPassword) {
    config.admin.username = envUsername;
    // Hash the password from env
    config.admin.passwordHash = await hashPassword(envPassword);
  }

  // JWT Secret - use existing or generate new
  const envJwtSecret = process.env.JWT_SECRET;
  if (envJwtSecret && envJwtSecret.length >= 32) {
    config.jwtSecret = envJwtSecret;
  } else {
    config.jwtSecret = generateJwtSecret();
  }

  // CORS Origins
  const envCors = process.env.CORS_ORIGINS;
  if (envCors) {
    if (envCors === '*') {
      config.corsOrigins = ['*'];
    } else {
      config.corsOrigins = envCors.split(',').map(origin => origin.trim());
    }
  }

  // Trust Proxy
  config.network.trustProxy =
    process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';

  // Performance settings from Java RAM env vars
  const minRam = process.env.JAVA_MIN_RAM;
  const maxRam = process.env.JAVA_MAX_RAM;
  if (minRam) config.performance.minRam = minRam;
  if (maxRam) config.performance.maxRam = maxRam;

  // Modtale API Key
  const modtaleKey = process.env.MODTALE_API_KEY;
  if (modtaleKey) {
    config.integrations.modtaleApiKey = modtaleKey;
  }

  // Assets path
  const assetsPath = process.env.ASSETS_PATH;
  if (assetsPath) {
    config.assets.path = assetsPath;
  }

  // Check if assets are already extracted
  try {
    await access(config.assets.path, constants.R_OK);
    // If assets directory exists and is readable, mark as extracted
    // (This is a basic check - the setup wizard can do more thorough validation)
    config.assets.extracted = true;
  } catch {
    config.assets.extracted = false;
  }

  console.log('[ConfigService] Migrated configuration from environment variables');

  return config;
}

/**
 * Checks if this is a first-time setup (no config.json or setupComplete is false)
 *
 * @returns True if setup wizard should be shown
 */
export async function isFirstRun(): Promise<boolean> {
  const exists = await configExists();

  if (!exists) {
    return true;
  }

  try {
    const config = await loadConfig();
    return !config.setupComplete;
  } catch {
    return true;
  }
}

/**
 * Marks the setup as complete
 *
 * @returns The updated configuration
 */
export async function completeSetup(): Promise<PanelConfig> {
  const config = await loadConfig();
  config.setupComplete = true;
  config.setupCompletedAt = new Date().toISOString();
  await saveConfig(config);
  return config;
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Deep merges two objects, with source values overwriting target values
 *
 * @param target - The target object (defaults)
 * @param source - The source object (loaded values)
 * @returns The merged object
 */
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target } as T;

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== null &&
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      targetValue !== undefined &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      // Recursively merge nested objects
      result[key] = deepMerge(
        targetValue as object,
        sourceValue as object
      ) as T[keyof T];
    } else if (sourceValue !== undefined) {
      // Use source value if defined
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * Validates that required configuration fields are set
 *
 * @param config - The configuration to validate
 * @returns Array of validation error messages (empty if valid)
 */
export function validateConfig(config: PanelConfig): string[] {
  const errors: string[] = [];

  // Admin validation
  if (!config.admin.username || config.admin.username.length < 3) {
    errors.push('Admin username must be at least 3 characters');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(config.admin.username)) {
    errors.push('Admin username can only contain letters, numbers, underscores, and hyphens');
  }
  if (!config.admin.passwordHash) {
    errors.push('Admin password is required');
  }

  // JWT validation
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    errors.push('JWT secret must be at least 32 characters');
  }

  // CORS validation
  if (!config.corsOrigins || config.corsOrigins.length === 0) {
    errors.push('At least one CORS origin must be configured');
  }

  // Server validation
  if (!config.server.name || config.server.name.trim().length === 0) {
    errors.push('Server name is required');
  }
  if (config.server.maxPlayers < 1 || config.server.maxPlayers > 100) {
    errors.push('Max players must be between 1 and 100');
  }

  // Performance validation
  const ramPattern = /^\d+[GM]$/i;
  if (!ramPattern.test(config.performance.minRam)) {
    errors.push('Min RAM must be in format like "3G" or "2048M"');
  }
  if (!ramPattern.test(config.performance.maxRam)) {
    errors.push('Max RAM must be in format like "4G" or "4096M"');
  }
  if (config.performance.viewRadius < 4 || config.performance.viewRadius > 32) {
    errors.push('View radius must be between 4 and 32');
  }

  return errors;
}

// ============================================================
// Cache for Runtime Configuration
// ============================================================

// In-memory cache of the current configuration
let cachedConfig: PanelConfig | null = null;

/**
 * Gets the cached configuration or loads it from disk
 *
 * @returns The current configuration
 */
export async function getConfig(): Promise<PanelConfig> {
  if (!cachedConfig) {
    cachedConfig = await loadConfig();
  }
  return cachedConfig;
}

/**
 * Reloads the configuration from disk and updates the cache
 *
 * Call this after setup completes or when config.json is modified externally
 *
 * @returns The reloaded configuration
 */
export async function reloadConfig(): Promise<PanelConfig> {
  cachedConfig = await loadConfig();
  console.log('[ConfigService] Configuration reloaded');
  return cachedConfig;
}

/**
 * Clears the cached configuration (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
