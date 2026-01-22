import { readFile, writeFile, mkdir, access, constants } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import * as dockerService from './docker.js';
import { runSystemChecks as runSystemChecksFromService, type SystemCheck, type SystemCheckResult } from './systemCheck.js';

// Re-export system check types and function
export type { SystemCheck, SystemCheckResult };
export { runSystemChecksFromService as runSystemChecks };

// Setup configuration interface
export interface SetupConfig {
  setupComplete: boolean;
  setupCompletedAt?: string;
  language: string;
  admin?: {
    username: string;
  };
  server?: {
    name: string;
    motd: string;
    maxPlayers: number;
    gameMode: string;
    password: string;
    whitelist: boolean;
    allowOp: boolean;
  };
  performance?: {
    minRam: string;
    maxRam: string;
    viewRadius: number;
  };
  automation?: {
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
  assets?: {
    extracted: boolean;
    extractedAt?: string;
    path?: string;
    sizeBytes?: number;
  };
  integrations?: {
    modtaleApiKey: string;
    stackmartApiKey: string;
    webmap: boolean;
  };
  network?: {
    accessMode: 'local' | 'lan' | 'domain';
    domain?: string;
    trustProxy: boolean;
  };
  plugin?: {
    kyuubiApiInstalled: boolean;
    version?: string;
  };
  downloadMethod?: 'official' | 'custom' | 'manual';
  autoUpdate?: boolean;
}

// Partial setup data for step-by-step saving
export interface PartialSetupData {
  [key: string]: unknown;
}

// Setup status response
export interface SetupStatus {
  setupComplete: boolean;
  currentStep: number;
  totalSteps: number;
  stepsCompleted: string[];
  config?: Partial<SetupConfig>;
}


// Extraction progress
export interface ExtractionProgress {
  status: 'idle' | 'extracting' | 'complete' | 'error';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  currentFile: string;
  estimatedSeconds: number;
  error?: string;
}

// Download progress
export interface DownloadProgress {
  status: 'idle' | 'downloading' | 'complete' | 'error';
  files: {
    name: string;
    bytesTotal: number;
    bytesDone: number;
    percent: number;
    complete: boolean;
  }[];
  overallPercent: number;
  speed: string;
  estimatedSeconds: number;
  error?: string;
}

// Paths
const DATA_DIR = config.dataPath;
const SETUP_CONFIG_FILE = path.join(DATA_DIR, 'setup-config.json');
const PANEL_CONFIG_FILE = path.join(DATA_DIR, 'panel-config.json');

// Step definitions
const SETUP_STEPS = [
  'system-check',
  'language',
  'admin-account',
  'download-method',
  'download',
  'assets-extract',
  'server-auth',
  'server-config',
  'automation',
  'performance',
  'plugin',
  'integrations',
  'network',
  'summary',
];

// In-memory state for extraction/download progress
let extractionProgress: ExtractionProgress = {
  status: 'idle',
  filesTotal: 0,
  filesDone: 0,
  bytesTotal: 0,
  bytesDone: 0,
  currentFile: '',
  estimatedSeconds: 0,
};

let downloadProgress: DownloadProgress = {
  status: 'idle',
  files: [],
  overallPercent: 0,
  speed: '0 MB/s',
  estimatedSeconds: 0,
};

// Ensure data directory exists
async function ensureDataDir(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

// Read setup config from file
async function readSetupConfig(): Promise<SetupConfig> {
  try {
    const content = await readFile(SETUP_CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as SetupConfig;
  } catch {
    // Return default config if file doesn't exist
    return {
      setupComplete: false,
      language: 'en',
    };
  }
}

// Write setup config to file
async function writeSetupConfig(setupConfig: SetupConfig): Promise<void> {
  await ensureDataDir();
  await writeFile(SETUP_CONFIG_FILE, JSON.stringify(setupConfig, null, 2), 'utf-8');
}

/**
 * Check if setup is complete
 * Returns true if config exists and has setupComplete=true
 */
export async function isSetupComplete(): Promise<boolean> {
  try {
    const setupConfig = await readSetupConfig();
    return setupConfig.setupComplete === true;
  } catch {
    return false;
  }
}

/**
 * Get current setup status
 * Returns complete status info including current step and completed steps
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  try {
    const setupConfig = await readSetupConfig();
    const stepsCompleted: string[] = [];

    // Determine which steps are completed based on config
    if (setupConfig.language) stepsCompleted.push('language');
    if (setupConfig.admin?.username) stepsCompleted.push('admin-account');
    if (setupConfig.downloadMethod) stepsCompleted.push('download-method');
    if (setupConfig.server) stepsCompleted.push('server-config');
    if (setupConfig.performance) stepsCompleted.push('performance');
    if (setupConfig.automation) stepsCompleted.push('automation');
    if (setupConfig.assets?.extracted) stepsCompleted.push('assets-extract');
    if (setupConfig.plugin !== undefined) stepsCompleted.push('plugin');
    if (setupConfig.integrations) stepsCompleted.push('integrations');
    if (setupConfig.network) stepsCompleted.push('network');

    // Find current step (first incomplete step)
    let currentStep = 0;
    for (let i = 0; i < SETUP_STEPS.length; i++) {
      if (!stepsCompleted.includes(SETUP_STEPS[i])) {
        currentStep = i;
        break;
      }
      currentStep = i + 1;
    }

    return {
      setupComplete: setupConfig.setupComplete,
      currentStep,
      totalSteps: SETUP_STEPS.length,
      stepsCompleted,
      config: setupConfig.setupComplete ? undefined : setupConfig,
    };
  } catch {
    return {
      setupComplete: false,
      currentStep: 0,
      totalSteps: SETUP_STEPS.length,
      stepsCompleted: [],
    };
  }
}

/**
 * Save step data to partial config
 * @param stepId - The step identifier
 * @param data - The data for this step
 */
export async function saveStepData(stepId: string, data: PartialSetupData): Promise<{ success: boolean; nextStep: string; error?: string }> {
  try {
    const setupConfig = await readSetupConfig();

    // Validate and process step data
    switch (stepId) {
      case 'language':
        if (!data.language || typeof data.language !== 'string') {
          return { success: false, nextStep: stepId, error: 'Language is required' };
        }
        setupConfig.language = data.language as string;
        break;

      case 'admin-account':
        if (!data.username || !data.password) {
          return { success: false, nextStep: stepId, error: 'Username and password are required' };
        }
        // Validate username format
        if (!/^[a-zA-Z0-9_-]{3,32}$/.test(data.username as string)) {
          return { success: false, nextStep: stepId, error: 'Username must be 3-32 characters, alphanumeric with _ or -' };
        }
        // Validate password strength
        if ((data.password as string).length < 12) {
          return { success: false, nextStep: stepId, error: 'Password must be at least 12 characters' };
        }

        // Store admin info (we'll create the user during finalization)
        setupConfig.admin = {
          username: data.username as string,
        };
        // Store hashed password temporarily in a separate field
        (setupConfig as any)._adminPasswordHash = await bcrypt.hash(data.password as string, 12);
        break;

      case 'download-method':
        if (!data.method || !['official', 'custom', 'manual'].includes(data.method as string)) {
          return { success: false, nextStep: stepId, error: 'Invalid download method' };
        }
        setupConfig.downloadMethod = data.method as 'official' | 'custom' | 'manual';
        setupConfig.autoUpdate = data.autoUpdate === true;
        if (data.customUrls) {
          (setupConfig as any)._customUrls = data.customUrls;
        }
        break;

      case 'server-config':
        setupConfig.server = {
          name: (data.serverName as string) || 'Hytale Server',
          motd: (data.motd as string) || 'Welcome to Hytale!',
          maxPlayers: (data.maxPlayers as number) || 20,
          gameMode: (data.gameMode as string) || 'Adventure',
          password: (data.password as string) || '',
          whitelist: data.whitelist === true,
          allowOp: data.allowOp === true,
        };
        break;

      case 'performance':
        setupConfig.performance = {
          minRam: (data.minRam as string) || '3G',
          maxRam: (data.maxRam as string) || '4G',
          viewRadius: (data.viewRadius as number) || 16,
        };
        break;

      case 'automation':
        setupConfig.automation = {
          backups: {
            enabled: data.backupsEnabled !== false,
            interval: (data.backupInterval as string) || '6h',
            retention: (data.backupRetention as number) || 7,
          },
          restart: {
            enabled: data.restartEnabled === true,
            schedule: (data.restartSchedule as string) || '0 4 * * *',
            warnMinutes: (data.restartWarnMinutes as number) || 5,
          },
        };
        break;

      case 'assets-extract':
        setupConfig.assets = {
          extracted: data.extract === true,
          extractedAt: data.extract === true ? new Date().toISOString() : undefined,
          path: data.extract === true ? config.assetsPath : undefined,
        };
        break;

      case 'plugin':
        setupConfig.plugin = {
          kyuubiApiInstalled: data.installPlugin === true,
          version: data.installPlugin === true ? (data.version as string) : undefined,
        };
        break;

      case 'integrations':
        setupConfig.integrations = {
          modtaleApiKey: (data.modtaleApiKey as string) || '',
          stackmartApiKey: (data.stackmartApiKey as string) || '',
          webmap: data.webmap === true,
        };
        break;

      case 'network':
        if (!data.accessMode || !['local', 'lan', 'domain'].includes(data.accessMode as string)) {
          return { success: false, nextStep: stepId, error: 'Invalid access mode' };
        }
        setupConfig.network = {
          accessMode: data.accessMode as 'local' | 'lan' | 'domain',
          domain: data.accessMode === 'domain' ? (data.domain as string) : undefined,
          trustProxy: data.trustProxy === true,
        };
        break;

      case 'system-check':
        // System check doesn't store data, just validates
        break;

      case 'download':
        // Download progress is handled separately
        break;

      case 'server-auth':
        // Server auth is handled by hytaleAuth service
        break;

      case 'summary':
        // Summary doesn't store data
        break;

      default:
        return { success: false, nextStep: stepId, error: 'Unknown step' };
    }

    await writeSetupConfig(setupConfig);

    // Find next step
    const currentIndex = SETUP_STEPS.indexOf(stepId);
    const nextStep = currentIndex < SETUP_STEPS.length - 1
      ? SETUP_STEPS[currentIndex + 1]
      : 'complete';

    return { success: true, nextStep };
  } catch (error) {
    return {
      success: false,
      nextStep: stepId,
      error: error instanceof Error ? error.message : 'Failed to save step data'
    };
  }
}

/**
 * Finalize setup - write final config and create admin user
 */
export async function finalizeSetup(): Promise<{ success: boolean; error?: string; jwtSecret?: string }> {
  try {
    const setupConfig = await readSetupConfig();

    // Validate required fields
    if (!setupConfig.admin?.username) {
      return { success: false, error: 'Admin account not configured' };
    }

    const adminPasswordHash = (setupConfig as any)._adminPasswordHash;
    if (!adminPasswordHash) {
      return { success: false, error: 'Admin password not set' };
    }

    // Generate new JWT secret
    const jwtSecret = crypto.randomBytes(48).toString('base64');

    // Create admin user using the users service
    try {
      // We need to create the user with the pre-hashed password
      // Since createUser hashes the password, we'll write directly to users.json
      const usersFile = path.join(DATA_DIR, 'users.json');
      const usersData = {
        users: [{
          username: setupConfig.admin.username,
          passwordHash: adminPasswordHash,
          roleId: 'admin',
          createdAt: new Date().toISOString(),
          tokenVersion: 1,
        }]
      };
      await writeFile(usersFile, JSON.stringify(usersData, null, 2), 'utf-8');
    } catch (error) {
      // User might already exist, which is fine
      console.log('Note: Admin user creation skipped (may already exist)');
    }

    // Write panel config
    const panelConfig = {
      patchline: 'release',
      acceptEarlyPlugins: false,
      disableSentry: false,
      allowOp: setupConfig.server?.allowOp ?? false,
    };
    await writeFile(PANEL_CONFIG_FILE, JSON.stringify(panelConfig, null, 2), 'utf-8');

    // Write server config.json if server path exists
    if (setupConfig.server) {
      const serverConfigPath = path.join(config.serverPath, 'config.json');
      try {
        // Check if server directory exists
        await access(config.serverPath, constants.W_OK);

        // Read existing config or create new
        let serverConfig: any = {};
        try {
          const existing = await readFile(serverConfigPath, 'utf-8');
          serverConfig = JSON.parse(existing);
        } catch {
          // File doesn't exist, start fresh
        }

        // Update with setup values
        serverConfig.ServerName = setupConfig.server.name;
        serverConfig.MOTD = setupConfig.server.motd;
        serverConfig.MaxPlayers = setupConfig.server.maxPlayers;
        serverConfig.Password = setupConfig.server.password;
        if (!serverConfig.Defaults) serverConfig.Defaults = {};
        serverConfig.Defaults.GameMode = setupConfig.server.gameMode;

        await writeFile(serverConfigPath, JSON.stringify(serverConfig, null, 2), 'utf-8');
      } catch {
        // Server directory might not exist yet, skip
        console.log('Note: Server config not written (server directory not ready)');
      }
    }

    // Mark setup as complete
    setupConfig.setupComplete = true;
    setupConfig.setupCompletedAt = new Date().toISOString();

    // Remove temporary password hash
    delete (setupConfig as any)._adminPasswordHash;
    delete (setupConfig as any)._customUrls;

    await writeSetupConfig(setupConfig);

    return { success: true, jwtSecret };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to finalize setup'
    };
  }
}


/**
 * Get extraction progress
 */
export function getExtractionProgress(): ExtractionProgress {
  return { ...extractionProgress };
}

/**
 * Set extraction progress (called by extraction process)
 */
export function setExtractionProgress(progress: Partial<ExtractionProgress>): void {
  extractionProgress = { ...extractionProgress, ...progress };
}

/**
 * Start assets extraction
 */
export async function startAssetsExtraction(): Promise<{ success: boolean; error?: string }> {
  try {
    const assetsZipPath = path.join(config.serverPath, 'Assets.zip');

    // Check if Assets.zip exists
    try {
      await access(assetsZipPath, constants.R_OK);
    } catch {
      return { success: false, error: 'Assets.zip not found. Download server files first.' };
    }

    // Check if already extracting
    if (extractionProgress.status === 'extracting') {
      return { success: false, error: 'Extraction already in progress' };
    }

    // Initialize progress
    extractionProgress = {
      status: 'extracting',
      filesTotal: 0,
      filesDone: 0,
      bytesTotal: 0,
      bytesDone: 0,
      currentFile: 'Starting extraction...',
      estimatedSeconds: 0,
    };

    // Start extraction in background via Docker exec
    // The actual extraction would be done by the game container or a worker
    const extractPath = config.assetsPath;

    // Ensure extract directory exists
    await mkdir(extractPath, { recursive: true }).catch(() => {});

    // Run unzip via docker exec (in the game container which has the tools)
    dockerService.execInContainer(
      `unzip -o "${assetsZipPath}" -d "${extractPath}" 2>&1`
    ).then(async (result) => {
      if (result.success) {
        // Get directory size
        const sizeResult = await dockerService.execInContainer(
          `du -sb "${extractPath}" | cut -f1`
        );
        const sizeBytes = sizeResult.success && sizeResult.output
          ? parseInt(sizeResult.output.trim(), 10)
          : 0;

        extractionProgress = {
          status: 'complete',
          filesTotal: 100,
          filesDone: 100,
          bytesTotal: sizeBytes,
          bytesDone: sizeBytes,
          currentFile: 'Extraction complete',
          estimatedSeconds: 0,
        };

        // Update setup config
        const setupConfig = await readSetupConfig();
        setupConfig.assets = {
          extracted: true,
          extractedAt: new Date().toISOString(),
          path: extractPath,
          sizeBytes,
        };
        await writeSetupConfig(setupConfig);
      } else {
        extractionProgress = {
          ...extractionProgress,
          status: 'error',
          error: result.error || 'Extraction failed',
        };
      }
    }).catch((error) => {
      extractionProgress = {
        ...extractionProgress,
        status: 'error',
        error: error instanceof Error ? error.message : 'Extraction failed',
      };
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start extraction'
    };
  }
}

/**
 * Get download progress
 */
export function getDownloadProgress(): DownloadProgress {
  return { ...downloadProgress };
}

/**
 * Set download progress (called by download process)
 */
export function setDownloadProgress(progress: Partial<DownloadProgress>): void {
  downloadProgress = { ...downloadProgress, ...progress };
}

/**
 * Get auth status for setup
 */
export async function getAuthStatusForSetup(): Promise<{
  downloaderAuth: { authenticated: boolean; username?: string };
  serverAuth: { authenticated: boolean; persistent: boolean };
}> {
  // This would integrate with hytaleAuth service
  // For now, return placeholder
  return {
    downloaderAuth: {
      authenticated: false,
    },
    serverAuth: {
      authenticated: false,
      persistent: false,
    },
  };
}

/**
 * Reset setup (for testing/development)
 */
export async function resetSetup(): Promise<{ success: boolean; error?: string }> {
  try {
    const setupConfig: SetupConfig = {
      setupComplete: false,
      language: 'en',
    };
    await writeSetupConfig(setupConfig);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset setup'
    };
  }
}
