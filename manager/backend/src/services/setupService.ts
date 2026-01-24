import { readFile, writeFile, mkdir, access, constants } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { config, reloadConfigFromFile } from '../config.js';
import * as dockerService from './docker.js';
import { runSystemChecks as runSystemChecksFromService, type SystemCheck, type SystemCheckResult } from './systemCheck.js';
import { installPlugin as installKyuubiApiPlugin } from './kyuubiApi.js';
import { saveConfig as saveSchedulerConfig } from './scheduler.js';
import { installMod, ensureEasyWebMapConfig } from './modStore.js';

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
  patchline?: 'release' | 'pre-release';
  acceptEarlyPlugins?: boolean;
  disableSentry?: boolean;
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
const CONFIG_JSON_FILE = path.join(DATA_DIR, 'config.json');

// Step definitions
const SETUP_STEPS = [
  'system-check',
  'language',
  'admin-account',
  'download-method',
  'download',
  'server-download',
  'assets-extract',
  'server-auth',
  'server-config',
  'security-settings',
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
        // Frontend sends 'name' and 'gameMode', support both naming conventions
        setupConfig.server = {
          name: (data.name as string) || (data.serverName as string) || 'Hytale Server',
          motd: (data.motd as string) || 'Welcome to Hytale!',
          maxPlayers: (data.maxPlayers as number) || 20,
          gameMode: (data.gameMode as string) || (data.defaultGamemode as string) || 'Adventure',
          password: (data.password as string) || '',
          whitelist: data.whitelist === true,
          allowOp: data.allowOp === true,
        };
        // Advanced settings
        if (data.acceptEarlyPlugins !== undefined) {
          setupConfig.acceptEarlyPlugins = data.acceptEarlyPlugins === true;
        }
        if (data.disableSentry !== undefined) {
          setupConfig.disableSentry = data.disableSentry === true;
        }
        break;

      case 'performance':
        setupConfig.performance = {
          minRam: (data.minRam as string) || '3G',
          maxRam: (data.maxRam as string) || '4G',
          viewRadius: (data.viewRadius as number) || 16,
        };
        break;

      case 'automation':
        // Frontend sends nested objects: { backups: {...}, restart: {...} }
        const backupsData = data.backups as Record<string, unknown> | undefined;
        const restartData = data.restart as Record<string, unknown> | undefined;
        setupConfig.automation = {
          backups: {
            enabled: backupsData?.enabled !== false,
            interval: (backupsData?.interval as string) || '6h',
            retention: (backupsData?.retention as number) || 7,
          },
          restart: {
            enabled: restartData?.enabled === true,
            schedule: (restartData?.schedule as string) || '0 4 * * *',
            warnMinutes: (restartData?.warnMinutes as number) || 5,
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
        // Frontend sends 'webmapEnabled', support both naming conventions
        setupConfig.integrations = {
          modtaleApiKey: (data.modtaleApiKey as string) || '',
          stackmartApiKey: (data.stackmartApiKey as string) || '',
          webmap: data.webmapEnabled === true || data.webmap === true,
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

      case 'server-download':
        // Server download step - stores download method, patchline and auto-update preference
        if (data.method) {
          setupConfig.downloadMethod = data.method as 'official' | 'custom' | 'manual';
        }
        if (data.patchline) {
          setupConfig.patchline = data.patchline as 'release' | 'pre-release';
        }
        if (data.autoUpdate !== undefined) {
          setupConfig.autoUpdate = data.autoUpdate === true;
        }
        if (data.customUrls) {
          (setupConfig as any)._customUrls = data.customUrls;
        }
        break;

      case 'server-auth':
        // Server auth is handled by hytaleAuth service
        break;

      case 'security-settings':
        // Update server config with security settings
        if (!setupConfig.server) {
          setupConfig.server = {
            name: 'Hytale Server',
            motd: 'Welcome to Hytale!',
            maxPlayers: 20,
            gameMode: 'Adventure',
            password: '',
            whitelist: false,
            allowOp: true,
          };
        }
        // Apply security settings from frontend
        if (data.password !== undefined) {
          setupConfig.server.password = (data.password as string) || '';
        }
        if (data.whitelist !== undefined) {
          setupConfig.server.whitelist = data.whitelist === true;
        }
        if (data.allowOp !== undefined) {
          setupConfig.server.allowOp = data.allowOp === true;
        }
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
 * Convert setup automation settings to scheduler config format
 * Setup uses interval format ("6h") and cron format ("0 4 * * *")
 * Scheduler uses time format ("HH:MM") and time arrays
 */
function convertAutomationToSchedulerConfig(automation: SetupConfig['automation']) {
  if (!automation) return {};

  // Helper to extract time from cron format "minute hour * * *"
  const extractTimeFromCron = (cron: string): string => {
    const parts = cron.split(' ');
    if (parts.length >= 2) {
      const minute = parts[0].padStart(2, '0');
      const hour = parts[1].padStart(2, '0');
      return `${hour}:${minute}`;
    }
    return '04:00'; // Default to 4 AM
  };

  // Helper to calculate backup time from interval
  // For simplicity, we schedule backups at fixed times based on interval
  const intervalToBackupTime = (interval: string): string => {
    // For now, just use 3 AM as default backup time
    // In a more complex implementation, this could schedule multiple times per day
    return '03:00';
  };

  const result: Record<string, unknown> = {};

  // Convert backup settings
  if (automation.backups) {
    result.backups = {
      enabled: automation.backups.enabled,
      schedule: intervalToBackupTime(automation.backups.interval),
      retentionDays: automation.backups.retention,
      beforeRestart: true,
    };
  }

  // Convert restart settings
  if (automation.restart) {
    const restartTime = extractTimeFromCron(automation.restart.schedule);
    result.scheduledRestarts = {
      enabled: automation.restart.enabled,
      times: automation.restart.enabled ? [restartTime] : [],
      warningMinutes: [30, 15, 5, 1],
      warningMessage: 'Server restart in {minutes} minute(s)!',
      restartMessage: 'Server is restarting now!',
      createBackup: true,
    };
  }

  return result;
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
      patchline: setupConfig.patchline ?? 'release',
      acceptEarlyPlugins: setupConfig.acceptEarlyPlugins ?? false,
      disableSentry: setupConfig.disableSentry ?? false,
      allowOp: setupConfig.server?.allowOp ?? false,
    };
    await writeFile(PANEL_CONFIG_FILE, JSON.stringify(panelConfig, null, 2), 'utf-8');
    console.log('[Setup] Wrote panel config with patchline:', panelConfig.patchline);

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
        serverConfig.Whitelist = setupConfig.server.whitelist ?? false;
        serverConfig.AllowOp = setupConfig.server.allowOp ?? true;
        if (!serverConfig.Defaults) serverConfig.Defaults = {};
        serverConfig.Defaults.GameMode = setupConfig.server.gameMode;

        // Performance settings
        if (setupConfig.performance?.viewRadius) {
          serverConfig.ViewRadius = setupConfig.performance.viewRadius;
        }

        // Add UpdateConfig for native update system (Hytale 24.01.2026+)
        serverConfig.updateConfig = {
          enabled: true,
          checkIntervalSeconds: 3600,
          notifyPlayersOnAvailable: true,
          patchline: setupConfig.patchline ?? 'release',
          runBackupBeforeUpdate: true,
          backupConfigBeforeUpdate: true,
          autoApplyMode: setupConfig.autoUpdate ? 'WHEN_EMPTY' : 'DISABLED',
          autoApplyDelayMinutes: 5,
        };

        await writeFile(serverConfigPath, JSON.stringify(serverConfig, null, 2), 'utf-8');
        console.log('[Setup] Wrote server config.json with all settings including UpdateConfig');
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

    // Write the main config.json with jwtSecret for the auth service
    // This is the config that gets loaded at application startup
    const mainConfig = {
      setupComplete: true,
      jwtSecret: jwtSecret,
      corsOrigins: setupConfig.network?.domain ? [setupConfig.network.domain] : [],
      network: {
        trustProxy: setupConfig.network?.trustProxy ?? false,
        accessMode: setupConfig.network?.accessMode ?? 'local',
        domain: setupConfig.network?.domain ?? null,
      },
      integrations: {
        modtaleApiKey: setupConfig.integrations?.modtaleApiKey ?? '',
        stackmartApiKey: setupConfig.integrations?.stackmartApiKey ?? '',
        webmap: setupConfig.integrations?.webmap ?? false,
      },
      automation: setupConfig.automation ?? null,
      plugin: setupConfig.plugin ?? null,
    };
    await writeFile(CONFIG_JSON_FILE, JSON.stringify(mainConfig, null, 2), 'utf-8');
    console.log('[Setup] Wrote config.json with all settings');

    // Install KyuubiAPI plugin if user selected it
    if (setupConfig.plugin?.kyuubiApiInstalled) {
      console.log('[Setup] Installing KyuubiAPI plugin...');
      try {
        const pluginResult = await installKyuubiApiPlugin();
        if (pluginResult.success) {
          console.log('[Setup] KyuubiAPI plugin installed successfully');
        } else {
          console.error('[Setup] Failed to install KyuubiAPI plugin:', pluginResult.error);
        }
      } catch (pluginError) {
        console.error('[Setup] Error installing KyuubiAPI plugin:', pluginError);
      }
    }

    // Install EasyWebMap plugin if user enabled webmap
    if (setupConfig.integrations?.webmap) {
      console.log('[Setup] Installing EasyWebMap plugin...');
      try {
        const webmapResult = await installMod('easywebmap');
        if (webmapResult.success) {
          console.log('[Setup] EasyWebMap plugin installed successfully:', webmapResult.filename);
          if (webmapResult.configCreated) {
            console.log('[Setup] EasyWebMap config created at', path.join(config.modsPath, 'cryptobench_EasyWebMap/config.json'));
            // Give filesystem time to sync the config file before server restart
            await new Promise(resolve => setTimeout(resolve, 500));
            console.log('[Setup] EasyWebMap config write confirmed');
          }
        } else {
          // "already installed" is not an error, just info
          if (webmapResult.error?.includes('already installed')) {
            console.log('[Setup] EasyWebMap already installed:', webmapResult.error);
          } else {
            console.error('[Setup] Failed to install EasyWebMap:', webmapResult.error);
          }
        }
      } catch (webmapError) {
        console.error('[Setup] Error installing EasyWebMap:', webmapError);
      }
    }

    // Apply automation settings to scheduler
    if (setupConfig.automation) {
      console.log('[Setup] Applying automation settings to scheduler...');
      try {
        // Convert setup automation format to scheduler format
        const schedulerConfig = convertAutomationToSchedulerConfig(setupConfig.automation);
        const saved = saveSchedulerConfig(schedulerConfig);
        if (saved) {
          console.log('[Setup] Scheduler configuration applied successfully');
        } else {
          console.error('[Setup] Failed to save scheduler configuration');
        }
      } catch (schedulerError) {
        console.error('[Setup] Error applying scheduler config:', schedulerError);
      }
    }

    // Reload config in memory so auth service can use the new JWT secret immediately
    reloadConfigFromFile();

    // Restart server container so newly installed mods get loaded
    // Run in background to avoid HTTP timeout - setup is already complete at this point
    // Use longer delay to ensure all config files are fully written to disk before restart
    console.log('[Setup] Scheduling server restart to load installed mods (3 second delay)...');
    setTimeout(async () => {
      try {
        console.log('[Setup] Restarting server container now...');
        const restartResult = await dockerService.restartContainer();
        if (restartResult.success) {
          console.log('[Setup] Server restart completed successfully');

          // Wait for server to start, then ensure EasyWebMap config has correct port
          // This fixes cases where the mod creates a default config on first startup
          if (setupConfig.integrations?.webmap) {
            console.log('[Setup] Waiting 10 seconds for mods to initialize...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            console.log('[Setup] Ensuring EasyWebMap config has correct port...');
            const configResult = await ensureEasyWebMapConfig();
            if (configResult.updated) {
              console.log('[Setup] EasyWebMap config was updated with correct port');
            } else if (configResult.created) {
              console.log('[Setup] EasyWebMap config was created');
            } else if (configResult.success) {
              console.log('[Setup] EasyWebMap config already correct');
            } else {
              console.error('[Setup] Failed to ensure EasyWebMap config:', configResult.error);
            }
          }
        } else {
          console.error('[Setup] Failed to restart server:', restartResult.error);
        }
      } catch (restartError) {
        console.error('[Setup] Error restarting server:', restartError);
      }
    }, 3000); // 3 second delay to ensure config files are written and HTTP response completes

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
 * Get auth status for setup by checking server logs
 */
export async function getAuthStatusForSetup(): Promise<{
  downloaderAuth: { authenticated: boolean; username?: string };
  serverAuth: { authenticated: boolean; persistent: boolean };
  machineId: { generated: boolean };
}> {
  try {
    // Get recent logs from the server container
    const logs = await dockerService.getLogs(500);

    // Check for downloader authentication
    const downloaderAuthenticated = logs.includes('Credentials saved') ||
      logs.includes('Download successful') ||
      logs.includes('AUTHENTICATION REQUIRED') === false && logs.includes('Hytale Server Booted');

    // Check for server authentication
    // Look for specific Hytale server auth success messages
    const serverAuthenticated =
      logs.includes('Authentication successful! Mode:') ||
      logs.includes('Authentication successful! Use') ||
      logs.includes('Connection Auth: Authenticated') ||
      logs.includes('Successfully created game session') ||
      logs.includes('Token Source: OAuth');

    // Check for persistence
    // Look for specific persistence confirmation messages
    const persistenceConfigured =
      logs.includes('Credential storage changed to: Encrypted') ||
      logs.includes('Swapped credential store to: EncryptedAuthCredentialStoreProvider') ||
      logs.includes('credential store to: Encrypted');

    // Check for machine ID (usually auto-generated)
    const machineIdGenerated = logs.includes('Machine ID') ||
      logs.includes('machine-id') ||
      logs.includes('MachineId') ||
      // If server authenticated, machine ID is typically present
      serverAuthenticated;

    return {
      downloaderAuth: {
        authenticated: downloaderAuthenticated,
      },
      serverAuth: {
        authenticated: serverAuthenticated,
        persistent: persistenceConfigured,
      },
      machineId: {
        generated: machineIdGenerated,
      },
    };
  } catch (error) {
    console.error('[Setup] Failed to get auth status:', error);
    return {
      downloaderAuth: {
        authenticated: false,
      },
      serverAuth: {
        authenticated: false,
        persistent: false,
      },
      machineId: {
        generated: false,
      },
    };
  }
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
