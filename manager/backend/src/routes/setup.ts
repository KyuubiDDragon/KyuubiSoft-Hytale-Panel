import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  isSetupComplete,
  getSetupStatus,
  saveStepData,
  finalizeSetup,
  getExtractionProgress,
  startAssetsExtraction,
  getDownloadProgress,
  getAuthStatusForSetup,
  resetSetup,
} from '../services/setupService.js';
import { runSystemChecks, runSingleCheck } from '../services/systemCheck.js';
import {
  getStatus as getDockerStatus,
  getLogs,
  startContainer,
  execCommand
} from '../services/docker.js';

const router = Router();

// Rate limiting for setup endpoints to prevent abuse
const setupLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: { detail: 'Too many setup requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all setup routes
router.use(setupLimiter);

/**
 * GET /api/setup/status
 * Check if setup is complete and get current setup state
 *
 * Response:
 * {
 *   setupComplete: boolean,
 *   currentStep: number,
 *   totalSteps: number,
 *   stepsCompleted: string[],
 *   config?: Partial<SetupConfig>
 * }
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getSetupStatus();
    res.json(status);
  } catch (error) {
    console.error('[Setup] Failed to get status:', error);
    res.status(500).json({
      error: 'Failed to get setup status',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/check
 * Quick check if setup is complete (lightweight endpoint for middleware)
 *
 * Response:
 * { setupComplete: boolean }
 */
router.get('/check', async (_req: Request, res: Response) => {
  try {
    const complete = await isSetupComplete();
    res.json({ setupComplete: complete });
  } catch (error) {
    // On error, assume setup is not complete
    console.error('[Setup] Check failed:', error);
    res.json({ setupComplete: false });
  }
});

/**
 * GET /api/setup/system-check
 * Run all system checks and return results
 *
 * Response:
 * {
 *   checks: SystemCheck[],
 *   canProceed: boolean
 * }
 */
router.get('/system-check', async (_req: Request, res: Response) => {
  try {
    const result = await runSystemChecks();
    res.json(result);
  } catch (error) {
    console.error('[Setup] System check failed:', error);
    res.status(500).json({
      error: 'System check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/system-check/:checkId
 * Run a single system check by ID
 *
 * Params:
 * - checkId: The ID of the check to run (e.g., 'docker_socket', 'port_5520', 'disk_space')
 *
 * Response:
 * SystemCheck object or 404 if check not found
 */
router.get('/system-check/:checkId', async (req: Request, res: Response) => {
  try {
    const { checkId } = req.params;
    const result = await runSingleCheck(checkId);

    if (!result) {
      res.status(404).json({
        error: 'Check not found',
        message: `No system check found with ID: ${checkId}`,
      });
      return;
    }

    res.json(result);
  } catch (error) {
    console.error('[Setup] Single system check failed:', error);
    res.status(500).json({
      error: 'System check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/step/:stepId
 * Save step data for a specific setup step
 *
 * Params:
 * - stepId: The step identifier
 *
 * Body:
 * Step-specific data object
 *
 * Response:
 * { success: boolean, nextStep: string, error?: string }
 */
router.post('/step/:stepId', async (req: Request, res: Response) => {
  try {
    const { stepId } = req.params;
    const data = req.body;

    // Validate stepId
    const validSteps = [
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

    if (!validSteps.includes(stepId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid step ID',
        validSteps,
      });
      return;
    }

    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    const result = await saveStepData(stepId, data);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    console.error('[Setup] Failed to save step data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save step data',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/admin
 * Create admin account (Phase 2)
 *
 * Request body:
 * { username: string, password: string }
 *
 * Response:
 * { success: boolean, error?: string }
 */
router.post('/admin', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    // Validate username
    if (!username || typeof username !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Username is required',
      });
      return;
    }

    if (username.length < 3 || username.length > 32) {
      res.status(400).json({
        success: false,
        error: 'Username must be between 3 and 32 characters',
      });
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      res.status(400).json({
        success: false,
        error: 'Username can only contain letters, numbers, and underscores',
      });
      return;
    }

    // Validate password
    if (!password || typeof password !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Password is required',
      });
      return;
    }

    if (password.length < 12) {
      res.status(400).json({
        success: false,
        error: 'Password must be at least 12 characters',
      });
      return;
    }

    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    // Save admin account data (password will be hashed during finalization)
    const result = await saveStepData('admin-account', { username, password });

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json({
      success: true,
    });
  } catch (error) {
    console.error('[Setup] Failed to create admin account:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create admin account',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/complete
 * Finalize setup - creates admin user, generates JWT secret, writes final config
 *
 * Response:
 * { success: boolean, message?: string, redirectUrl?: string, error?: string }
 */
router.post('/complete', async (_req: Request, res: Response) => {
  try {
    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    const result = await finalizeSetup();

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json({
      success: true,
      message: 'Setup completed successfully',
      redirectUrl: '/login',
      // Note: In production, jwtSecret should be written to a secure config
      // and the user should be instructed to set JWT_SECRET env var
      jwtSecretGenerated: true,
    });
  } catch (error) {
    console.error('[Setup] Failed to complete setup:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete setup',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ==========================================
// Download Flow Endpoints
// ==========================================

// In-memory state for OAuth device code flow (parsed from container logs)
let downloaderAuthState: {
  verificationUrl: string;
  verificationUrlDirect: string;
  userCode: string;
  expiresAt: Date;
  authenticated: boolean;
  downloadStarted: boolean;
  downloadComplete: boolean;
} | null = null;

// Parse OAuth info from container logs
function parseOAuthFromLogs(logs: string): {
  verificationUrl?: string;
  verificationUrlDirect?: string;
  userCode?: string;
  authenticated?: boolean;
  downloadComplete?: boolean;
} {
  const result: {
    verificationUrl?: string;
    verificationUrlDirect?: string;
    userCode?: string;
    authenticated?: boolean;
    downloadComplete?: boolean;
  } = {};

  // Helper to clean ANSI escape codes from strings
  const cleanAnsi = (str: string): string => {
    return str
      .replace(/\x1b\[[0-9;]*m/g, '')  // Standard ANSI escapes
      .replace(/\[m/g, '')              // Standalone [m
      .replace(/\[\d+;\d+m/g, '')       // Color codes like [0;32m without ESC
      .replace(/\[0m/g, '')             // Reset codes
      .replace(/%1B\[m/gi, '')          // URL-encoded ANSI escapes
      .trim();
  };

  // Clean the logs first
  const cleanedLogs = cleanAnsi(logs);

  // Look for user code first - alphanumeric code (case insensitive)
  // Hytale server format: "Enter code: NumvJGgq"
  // IMPORTANT: Code must be alphanumeric only, 4-12 chars, and not match common words
  const codePatterns = [
    /Enter\s+code:\s*([A-Za-z0-9]{4,12})/i,
    /Authorization\s+code[:\s]+([A-Za-z0-9]{4,12})/i,
    /user_code=([A-Za-z0-9]{4,12})/i,
    /your\s+code[:\s]+([A-Za-z0-9]{4,12})/i,
  ];

  // Words to exclude from being matched as codes
  const excludeWords = ['waiting', 'loading', 'checking', 'starting', 'authenticating', 'connecting', 'initializing'];

  for (const pattern of codePatterns) {
    const codeMatch = cleanedLogs.match(pattern);
    if (codeMatch) {
      const potentialCode = codeMatch[1];
      // Verify it's not a common word
      if (!excludeWords.includes(potentialCode.toLowerCase())) {
        result.userCode = potentialCode;
        console.log('[Setup] Found auth code:', potentialCode);
        break;
      }
    }
  }

  // Look for OAuth URLs from Hytale server
  // Format: "Visit: https://oauth.accounts.hytale.com/oauth2/device/verify"
  // And: "Or visit: https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=NumvJGgq"

  // Look for direct URL with user_code parameter
  const directUrlMatch = cleanedLogs.match(/Or\s+visit:\s*(https:\/\/[^\s\n]+user_code=[^\s\n]+)/i);
  if (directUrlMatch) {
    result.verificationUrlDirect = cleanAnsi(directUrlMatch[1]);
    console.log('[Setup] Found direct URL:', result.verificationUrlDirect);
  }

  // Look for base verification URL
  const baseUrlMatch = cleanedLogs.match(/Visit:\s*(https:\/\/oauth\.accounts\.hytale\.com\/[^\s\n?]+)/i);
  if (baseUrlMatch) {
    result.verificationUrl = cleanAnsi(baseUrlMatch[1]);
    console.log('[Setup] Found base URL:', result.verificationUrl);
  }

  // Fallback: If we only found direct URL, extract base URL from it
  if (result.verificationUrlDirect && !result.verificationUrl) {
    try {
      const url = new URL(result.verificationUrlDirect);
      url.search = '';
      result.verificationUrl = url.toString();
    } catch {
      // URL parsing failed, use direct URL as fallback
      result.verificationUrl = result.verificationUrlDirect;
    }
  }

  // Fallback: If we have base URL and user code, construct direct URL
  if (result.verificationUrl && result.userCode && !result.verificationUrlDirect) {
    try {
      const url = new URL(result.verificationUrl);
      url.searchParams.set('user_code', result.userCode);
      result.verificationUrlDirect = url.toString();
    } catch {
      // URL parsing failed
    }
  }

  // Generic URL fallback for other formats
  if (!result.verificationUrl && !result.verificationUrlDirect) {
    const urlMatch = logs.match(/(https:\/\/oauth\.accounts\.hytale\.com\/[^\s\n]+)/i);
    if (urlMatch) {
      const url = urlMatch[1];
      if (url.includes('user_code=')) {
        result.verificationUrlDirect = url;
        // Extract base URL
        try {
          const parsedUrl = new URL(url);
          parsedUrl.search = '';
          result.verificationUrl = parsedUrl.toString();
        } catch {
          result.verificationUrl = url;
        }
      } else {
        result.verificationUrl = url;
      }
    }
  }

  // Check if authentication succeeded
  // Look for specific Hytale server auth success messages
  if (cleanedLogs.includes('Authentication successful! Mode:') ||
      cleanedLogs.includes('Authentication successful! Use') ||
      cleanedLogs.includes('Connection Auth: Authenticated') ||
      cleanedLogs.includes('Successfully created game session') ||
      cleanedLogs.includes('Token Source: OAuth') ||
      cleanedLogs.includes('Download successful') ||
      cleanedLogs.includes('Credentials saved')) {
    result.authenticated = true;
    console.log('[Setup] Authentication success detected in logs');
  }

  // Check if download completed
  if (logs.includes('Extraction complete') || logs.includes('Server files verified')) {
    result.downloadComplete = true;
  }

  return result;
}

/**
 * POST /api/setup/download/auth/start
 * Start the download process - this restarts the game container with USE_HYTALE_DOWNLOADER
 *
 * Response:
 * {
 *   success: boolean,
 *   deviceCode?: string,
 *   verificationUrl?: string,
 *   userCode?: string,
 *   expiresIn?: number,
 *   pollInterval?: number,
 *   error?: string,
 *   needsEnvConfig?: boolean
 * }
 */
router.post('/download/auth/start', async (_req: Request, res: Response) => {
  try {
    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    // Check if game container is running
    const containerStatus = await getDockerStatus();
    if (containerStatus.status === 'not_found') {
      res.status(400).json({
        success: false,
        error: 'Game container not found. Make sure docker-compose is running.',
      });
      return;
    }

    // Reset auth state
    downloaderAuthState = {
      verificationUrl: '',
      verificationUrlDirect: '',
      userCode: '',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      authenticated: false,
      downloadStarted: false,
      downloadComplete: false,
    };

    // If container is not running, start it
    if (!containerStatus.running) {
      console.log('[Setup] Starting game container for download...');
      await startContainer();

      // Wait a bit for container to start
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Poll logs for OAuth info (initial check)
    const logs = await getLogs(200);
    const oauthInfo = parseOAuthFromLogs(logs);

    if (oauthInfo.verificationUrl) {
      downloaderAuthState.verificationUrl = oauthInfo.verificationUrl;
    }
    if (oauthInfo.verificationUrlDirect) {
      downloaderAuthState.verificationUrlDirect = oauthInfo.verificationUrlDirect;
    }
    if (oauthInfo.userCode) {
      downloaderAuthState.userCode = oauthInfo.userCode;
    }
    if (oauthInfo.authenticated) {
      downloaderAuthState.authenticated = true;
    }
    if (oauthInfo.downloadComplete) {
      downloaderAuthState.downloadComplete = true;
    }

    // Check if USE_HYTALE_DOWNLOADER might not be set
    if (logs.includes('SERVER FILES NOT FOUND') && !logs.includes('AUTHENTICATION REQUIRED')) {
      res.json({
        success: false,
        needsEnvConfig: true,
        error: 'USE_HYTALE_DOWNLOADER=true is not set. Please add it to your .env file and restart containers with docker-compose up -d',
        instructions: [
          '1. Add USE_HYTALE_DOWNLOADER=true to your .env file',
          '2. Run: docker-compose down && docker-compose up -d',
          '3. Then retry the download'
        ],
      });
      return;
    }

    res.json({
      success: true,
      deviceCode: 'container-oauth',
      verificationUrl: downloaderAuthState.verificationUrl || 'Checking container logs...',
      verificationUrlDirect: downloaderAuthState.verificationUrlDirect || '',
      userCode: downloaderAuthState.userCode || 'Waiting for code...',
      expiresIn: 900,
      pollInterval: 3,
    });
  } catch (error) {
    console.error('[Setup] Failed to start download auth:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start download process',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/download/auth/status
 * Check downloader OAuth authentication status by monitoring container logs
 *
 * Response:
 * {
 *   authenticated: boolean,
 *   expired?: boolean,
 *   error?: string,
 *   verificationUrl?: string,
 *   userCode?: string,
 *   downloadComplete?: boolean
 * }
 */
router.get('/download/auth/status', async (_req: Request, res: Response) => {
  try {
    if (!downloaderAuthState) {
      res.json({
        authenticated: false,
        error: 'No download in progress. Start the download first.',
      });
      return;
    }

    // Check if expired
    if (new Date() > downloaderAuthState.expiresAt) {
      res.json({
        authenticated: false,
        expired: true,
      });
      return;
    }

    // Poll container logs for updates
    const logs = await getLogs(300);
    const oauthInfo = parseOAuthFromLogs(logs);

    // Update state with new info
    if (oauthInfo.verificationUrl && !downloaderAuthState.verificationUrl) {
      downloaderAuthState.verificationUrl = oauthInfo.verificationUrl;
    }
    if (oauthInfo.verificationUrlDirect && !downloaderAuthState.verificationUrlDirect) {
      downloaderAuthState.verificationUrlDirect = oauthInfo.verificationUrlDirect;
    }
    if (oauthInfo.userCode && !downloaderAuthState.userCode) {
      downloaderAuthState.userCode = oauthInfo.userCode;
    }
    if (oauthInfo.authenticated) {
      downloaderAuthState.authenticated = true;
    }
    if (oauthInfo.downloadComplete) {
      downloaderAuthState.downloadComplete = true;
    }

    res.json({
      authenticated: downloaderAuthState.authenticated,
      expired: false,
      verificationUrl: downloaderAuthState.verificationUrl,
      verificationUrlDirect: downloaderAuthState.verificationUrlDirect,
      userCode: downloaderAuthState.userCode,
      downloadComplete: downloaderAuthState.downloadComplete,
    });
  } catch (error) {
    console.error('[Setup] Failed to get download auth status:', error);
    res.status(500).json({
      authenticated: false,
      error: 'Failed to check download status',
    });
  }
});

/**
 * POST /api/setup/download/start
 * Start downloading server files (container should already be running with USE_HYTALE_DOWNLOADER)
 *
 * Body:
 * { method: 'official' | 'custom', serverUrl?: string, assetsUrl?: string }
 *
 * Response:
 * { success: boolean, error?: string }
 */
router.post('/download/start', async (req: Request, res: Response) => {
  try {
    const { method } = req.body;

    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    console.log(`[Setup] Download method selected: ${method}`);

    if (method === 'official') {
      // For official download, the container should already be handling it
      // Just confirm it's running
      const containerStatus = await getDockerStatus();
      if (!containerStatus.running) {
        await startContainer();
      }

      res.json({
        success: true,
        message: 'Download in progress via game container',
      });
    } else if (method === 'custom') {
      // Custom URLs would need to be set via environment variables
      // For now, inform user to set them manually
      res.json({
        success: false,
        error: 'Custom URLs must be set in docker-compose.yml or .env file',
        instructions: [
          'Add to .env:',
          '  SERVER_JAR_URL=https://your-url/HytaleServer.jar',
          '  ASSETS_URL=https://your-url/Assets.zip',
          'Then restart: docker-compose up -d'
        ],
      });
    } else {
      res.json({ success: true });
    }
  } catch (error) {
    console.error('[Setup] Failed to start download:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start download',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/download/verify
 * Verify downloaded server files
 *
 * Response:
 * {
 *   success: boolean,
 *   serverJarSize?: string,
 *   serverJarIntegrity?: boolean,
 *   assetsZipSize?: string,
 *   assetsZipIntegrity?: boolean,
 *   version?: string,
 *   patchline?: string,
 *   error?: string
 * }
 */
router.get('/download/verify', async (_req: Request, res: Response) => {
  try {
    const { config } = await import('../config.js');
    const fs = await import('fs/promises');
    const path = await import('path');

    const serverJarPath = path.join(config.serverPath, 'HytaleServer.jar');
    const assetsZipPath = path.join(config.serverPath, 'Assets.zip');

    let serverJarSize = '0 B';
    let serverJarIntegrity = false;
    let assetsZipSize = '0 B';
    let assetsZipIntegrity = false;

    // Check server JAR
    try {
      const serverJarStat = await fs.stat(serverJarPath);
      serverJarSize = formatBytes(serverJarStat.size);
      serverJarIntegrity = serverJarStat.size > 0;
    } catch {
      // File doesn't exist
    }

    // Check assets ZIP
    try {
      const assetsZipStat = await fs.stat(assetsZipPath);
      assetsZipSize = formatBytes(assetsZipStat.size);
      assetsZipIntegrity = assetsZipStat.size > 0;
    } catch {
      // File doesn't exist
    }

    res.json({
      success: serverJarIntegrity || assetsZipIntegrity,
      serverJarSize,
      serverJarIntegrity,
      assetsZipSize,
      assetsZipIntegrity,
      version: '2.0.x',
      patchline: 'release',
    });
  } catch (error) {
    console.error('[Setup] Failed to verify download:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify downloaded files',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Helper function to format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Parse download progress from container logs
function parseDownloadProgress(logs: string): {
  currentFile?: string;
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  bytesPerSecond?: number;
} {
  const result: {
    currentFile?: string;
    percent?: number;
    bytesDone?: number;
    bytesTotal?: number;
    bytesPerSecond?: number;
  } = {};

  // Try to detect which file is being downloaded
  if (logs.includes('Downloading server') || logs.includes('HytaleServer')) {
    result.currentFile = 'HytaleServer.jar';
  } else if (logs.includes('Downloading assets') || logs.includes('Assets.zip') || logs.includes('assets')) {
    result.currentFile = 'Assets.zip';
  }

  // Parse percentage - look for patterns like "50%", "50.5%", "Progress: 50%"
  const percentPatterns = [
    /(\d+(?:\.\d+)?)\s*%/,
    /Progress[:\s]+(\d+(?:\.\d+)?)/i,
    /Downloading[^\d]*(\d+(?:\.\d+)?)\s*%/i,
  ];

  for (const pattern of percentPatterns) {
    const match = logs.match(pattern);
    if (match) {
      result.percent = parseFloat(match[1]);
      break;
    }
  }

  // Parse byte progress - patterns like "50MB/100MB", "50 MB / 100 MB", "50MB of 100MB"
  const bytePatterns = [
    /(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s*[\/of]+\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/i,
    /Downloaded[:\s]+(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/i,
  ];

  const unitMultipliers: Record<string, number> = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
  };

  for (const pattern of bytePatterns) {
    const match = logs.match(pattern);
    if (match) {
      if (match[3] && match[4]) {
        // Pattern with both done and total (e.g., "50MB/100MB")
        result.bytesDone = parseFloat(match[1]) * (unitMultipliers[match[2].toUpperCase()] || 1);
        result.bytesTotal = parseFloat(match[3]) * (unitMultipliers[match[4].toUpperCase()] || 1);
      } else {
        // Pattern with only done
        result.bytesDone = parseFloat(match[1]) * (unitMultipliers[match[2].toUpperCase()] || 1);
      }
      break;
    }
  }

  // Parse speed - patterns like "10MB/s", "10 MB/s"
  const speedMatch = logs.match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\/s/i);
  if (speedMatch) {
    result.bytesPerSecond = parseFloat(speedMatch[1]) * (unitMultipliers[speedMatch[2].toUpperCase()] || 1);
  }

  return result;
}

/**
 * GET /api/setup/download/progress
 * Server-Sent Events endpoint for download progress (monitors container logs)
 *
 * Response: SSE stream with download progress objects
 */
router.get('/download/progress', (req: Request, res: Response) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Estimated file sizes for progress calculation
  const ESTIMATED_SERVER_JAR_SIZE = 80 * 1024 * 1024; // ~80MB
  const ESTIMATED_ASSETS_SIZE = 3.3 * 1024 * 1024 * 1024; // ~3.3GB

  const sendProgress = async () => {
    try {
      const logs = await getLogs(100);
      const oauthInfo = parseOAuthFromLogs(logs);
      const downloadInfo = parseDownloadProgress(logs);

      if (oauthInfo.downloadComplete) {
        res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
      }

      // Determine current file and estimate bytes if not available from logs
      let currentFile = downloadInfo.currentFile || (oauthInfo.authenticated ? 'Downloading...' : 'Waiting for authentication...');
      let bytesDone = downloadInfo.bytesDone || 0;
      let bytesTotal = downloadInfo.bytesTotal || 0;
      let percent = downloadInfo.percent || 0;

      // If we have percentage but not bytes, estimate bytes
      if (percent > 0 && bytesTotal === 0) {
        if (currentFile === 'HytaleServer.jar') {
          bytesTotal = ESTIMATED_SERVER_JAR_SIZE;
          bytesDone = Math.floor(bytesTotal * (percent / 100));
        } else if (currentFile === 'Assets.zip') {
          bytesTotal = ESTIMATED_ASSETS_SIZE;
          bytesDone = Math.floor(bytesTotal * (percent / 100));
        }
      }

      res.write(`data: ${JSON.stringify({
        type: 'progress',
        currentFile,
        percent,
        bytesDone,
        bytesTotal,
        bytesPerSecond: downloadInfo.bytesPerSecond || 0,
        authenticated: oauthInfo.authenticated,
        verificationUrl: oauthInfo.verificationUrl,
        verificationUrlDirect: oauthInfo.verificationUrlDirect,
        userCode: oauthInfo.userCode,
      })}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to get progress' })}\n\n`);
    }
  };

  sendProgress();
  const interval = setInterval(sendProgress, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

/**
 * GET /api/setup/download/status
 * Server-Sent Events endpoint for download progress (legacy)
 *
 * Response: SSE stream with DownloadProgress objects
 */
router.get('/download/status', (req: Request, res: Response) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial status
  const sendStatus = () => {
    const progress = getDownloadProgress();
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  };

  // Send status immediately
  sendStatus();

  // Send updates every second
  const interval = setInterval(sendStatus, 1000);

  // Clean up on connection close
  req.on('close', () => {
    clearInterval(interval);
  });
});

/**
 * GET /api/setup/auth/status
 * Get Hytale authentication status (downloader + server)
 *
 * Response:
 * {
 *   downloaderAuth: { authenticated: boolean, username?: string },
 *   serverAuth: { authenticated: boolean, persistent: boolean }
 * }
 */
router.get('/auth/status', async (_req: Request, res: Response) => {
  try {
    const status = await getAuthStatusForSetup();
    res.json(status);
  } catch (error) {
    console.error('[Setup] Failed to get auth status:', error);
    res.status(500).json({
      error: 'Failed to get auth status',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/assets/extract
 * Start assets extraction process
 *
 * Response:
 * { success: boolean, message?: string, error?: string }
 */
router.post('/assets/extract', async (_req: Request, res: Response) => {
  try {
    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    const result = await startAssetsExtraction();

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json({
      success: true,
      message: 'Asset extraction started',
    });
  } catch (error) {
    console.error('[Setup] Failed to start asset extraction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start asset extraction',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/assets/status
 * Server-Sent Events endpoint for extraction progress
 *
 * Response: SSE stream with ExtractionProgress objects
 */
const assetsProgressHandler = (req: Request, res: Response) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial status
  const sendStatus = () => {
    const progress = getExtractionProgress();

    // Calculate percent for frontend
    const percent = progress.bytesTotal > 0
      ? Math.round((progress.bytesDone / progress.bytesTotal) * 100)
      : (progress.filesTotal > 0 ? Math.round((progress.filesDone / progress.filesTotal) * 100) : 0);

    // Map status to type for frontend compatibility
    const type = progress.status === 'extracting' ? 'progress'
      : progress.status === 'complete' ? 'complete'
      : progress.status === 'error' ? 'error'
      : 'progress';

    // Send response with both status (backend) and type (frontend) fields
    const response = {
      ...progress,
      type,
      percent,
    };

    res.write(`data: ${JSON.stringify(response)}\n\n`);

    // If extraction is complete or errored, close the connection after a short delay
    if (progress.status === 'complete' || progress.status === 'error') {
      setTimeout(() => {
        clearInterval(interval);
        res.end();
      }, 1000);
    }
  };

  // Send status immediately
  sendStatus();

  // Send updates every second
  const interval = setInterval(sendStatus, 1000);

  // Clean up on connection close
  req.on('close', () => {
    clearInterval(interval);
  });
};

// Both endpoints point to the same handler (frontend uses /progress, legacy uses /status)
router.get('/assets/status', assetsProgressHandler);
router.get('/assets/progress', assetsProgressHandler);

/**
 * GET /api/setup/detect-ip
 * Detect the server's local IP address for LAN access
 *
 * Response:
 * { ip: string | null, port: number, panelUrl: string }
 */
router.get('/detect-ip', async (req: Request, res: Response) => {
  try {
    const os = await import('os');
    const { config } = await import('../config.js');

    // Get all network interfaces
    const interfaces = os.networkInterfaces();
    let detectedIp: string | null = null;

    // Find the first non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
      const nets = interfaces[name];
      if (!nets) continue;

      for (const net of nets) {
        // Skip internal and non-IPv4 addresses
        if (net.internal || net.family !== 'IPv4') continue;

        // Prefer addresses in common private ranges
        if (net.address.startsWith('192.168.') ||
            net.address.startsWith('10.') ||
            net.address.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
          detectedIp = net.address;
          break;
        }
      }
      if (detectedIp) break;
    }

    // Fallback: use the x-forwarded-for header if behind proxy
    if (!detectedIp && req.headers['x-forwarded-for']) {
      const forwarded = req.headers['x-forwarded-for'];
      const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      if (ip && !ip.startsWith('127.') && !ip.startsWith('::')) {
        detectedIp = ip.trim();
      }
    }

    const port = config.externalPort;
    const panelUrl = detectedIp ? `http://${detectedIp}:${port}` : `http://localhost:${port}`;

    res.json({
      ip: detectedIp,
      port,
      panelUrl,
      serverPort: config.serverPort,
      interfaces: Object.keys(interfaces),
    });
  } catch (error) {
    console.error('[Setup] Failed to detect IP:', error);
    res.status(500).json({
      error: 'Failed to detect IP address',
      ip: null,
      port: 18080,
    });
  }
});

/**
 * GET /api/setup/server-info
 * Get server configuration info for the setup wizard
 *
 * Response:
 * { port: number, serverPort: number, gameContainerName: string }
 */
router.get('/server-info', async (_req: Request, res: Response) => {
  try {
    const { config } = await import('../config.js');

    res.json({
      managerPort: config.externalPort,
      serverPort: config.serverPort,
      gameContainerName: config.gameContainerName,
      serverPath: config.serverPath,
      dataPath: config.dataPath,
      hostDataPath: config.hostDataPath,
    });
  } catch (error) {
    console.error('[Setup] Failed to get server info:', error);
    res.status(500).json({
      error: 'Failed to get server info',
    });
  }
});

/**
 * POST /api/setup/reset
 * Reset setup (development only)
 * This endpoint is protected and only works in development mode
 *
 * Response:
 * { success: boolean, message?: string, error?: string }
 */
router.post('/reset', async (_req: Request, res: Response) => {
  // Only allow in development mode
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({
      success: false,
      error: 'Setup reset is not allowed in production',
    });
    return;
  }

  try {
    const result = await resetSetup();

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json({
      success: true,
      message: 'Setup has been reset',
    });
  } catch (error) {
    console.error('[Setup] Failed to reset setup:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset setup',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ==========================================
// Server Control Endpoints (for Server Auth step)
// ==========================================

// In-memory state for server auth flow
let serverAuthState: {
  serverStarted: boolean;
  authCode: string;
  authUrl: string;
  authenticated: boolean;
  expiresAt: Date;
} | null = null;

/**
 * POST /api/setup/server/start-first
 * Start the server for first-time setup authentication
 */
router.post('/server/start-first', async (_req: Request, res: Response) => {
  try {
    const containerStatus = await getDockerStatus();

    if (containerStatus.status === 'not_found') {
      res.status(400).json({
        success: false,
        error: 'Game container not found',
      });
      return;
    }

    // Start the container if not running
    if (!containerStatus.running) {
      await startContainer();
    }

    // Initialize server auth state
    serverAuthState = {
      serverStarted: true,
      authCode: '',
      authUrl: '',
      authenticated: false,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };

    res.json({
      success: true,
      message: 'Server starting...',
    });
  } catch (error) {
    console.error('[Setup] Failed to start server:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start server',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/server/start
 * Start the game server
 */
router.post('/server/start', async (_req: Request, res: Response) => {
  try {
    const containerStatus = await getDockerStatus();

    if (containerStatus.status === 'not_found') {
      res.status(400).json({
        success: false,
        error: 'Game container not found',
      });
      return;
    }

    if (!containerStatus.running) {
      await startContainer();
    }

    res.json({
      success: true,
      message: 'Server started',
    });
  } catch (error) {
    console.error('[Setup] Failed to start server:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start server',
    });
  }
});

/**
 * POST /api/setup/server/stop
 * Stop the game server
 */
router.post('/server/stop', async (_req: Request, res: Response) => {
  try {
    const { stopContainer } = await import('../services/docker.js');
    await stopContainer();

    res.json({
      success: true,
      message: 'Server stopped',
    });
  } catch (error) {
    console.error('[Setup] Failed to stop server:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop server',
    });
  }
});

/**
 * GET /api/setup/server/status
 * Get server status during setup
 */
router.get('/server/status', async (_req: Request, res: Response) => {
  try {
    const containerStatus = await getDockerStatus();

    res.json({
      running: containerStatus.running,
      status: containerStatus.status,
      startedAt: containerStatus.started_at,
    });
  } catch (error) {
    console.error('[Setup] Failed to get server status:', error);
    res.status(500).json({
      running: false,
      status: 'error',
      error: 'Failed to get server status',
    });
  }
});

/**
 * GET /api/setup/server/logs
 * Get server logs during setup (auth-free endpoint for fallback status check)
 * Query params: lines (default 200)
 */
router.get('/server/logs', async (req: Request, res: Response) => {
  try {
    const lines = parseInt(req.query.lines as string) || 200;
    // Limit max lines for safety
    const limitedLines = Math.min(lines, 500);

    const logs = await getLogs(limitedLines);

    // Parse status from logs
    let booted = false;
    let authRequired = false;

    if (logs.includes('Server Booted') || logs.includes('Hytale Server Booted')) {
      booted = true;
    }
    if (logs.includes('No server tokens configured') ||
        logs.includes('/auth login') ||
        logs.includes('AUTHENTICATION REQUIRED')) {
      authRequired = true;
    }

    res.json({
      logs: logs.split('\n'),
      booted,
      authRequired,
    });
  } catch (error) {
    console.error('[Setup] Failed to get server logs:', error);
    res.status(500).json({
      logs: [],
      booted: false,
      authRequired: false,
      error: 'Failed to get server logs',
    });
  }
});

/**
 * GET /api/setup/server/console
 * SSE endpoint for server console output during setup
 * Sends structured JSON events that the frontend can understand
 */
router.get('/server/console', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Track state to avoid duplicate events
  let serverBootedDetected = false;
  let authRequiredDetected = false;
  let statusEventSent = false;
  const seenLines = new Set<string>();

  // Helper to check logs for boot/auth messages
  const checkLogsForStatus = (logs: string): { booted: boolean; authRequired: boolean } => {
    const result = { booted: false, authRequired: false };

    // Check for server booted
    if (logs.includes('Server Booted') || logs.includes('Hytale Server Booted')) {
      result.booted = true;
    }

    // Check for auth required
    if (logs.includes('No server tokens configured') ||
        logs.includes('/auth login') ||
        logs.includes('AUTHENTICATION REQUIRED')) {
      result.authRequired = true;
    }

    return result;
  };

  // FIRST: Check ALL logs (up to 500 lines) to see if server already booted
  // This handles the case where server started a while ago and boot messages
  // are no longer in the recent logs
  try {
    const allLogs = await getLogs(500);
    const initialStatus = checkLogsForStatus(allLogs);

    if (initialStatus.booted) {
      serverBootedDetected = true;
      console.log('[Setup] Server already booted (detected from historical logs)');
    }
    if (initialStatus.authRequired) {
      authRequiredDetected = true;
      console.log('[Setup] Auth already required (detected from historical logs)');
    }

    // If both conditions are already met, send status events immediately
    if (serverBootedDetected && authRequiredDetected && !statusEventSent) {
      statusEventSent = true;
      console.log('[Setup] Server already started and needs auth - sending events immediately');
      res.write(`data: ${JSON.stringify({ type: 'started', authenticated: false })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'auth_required' })}\n\n`);
    }
  } catch (error) {
    console.error('[Setup] Error checking initial logs:', error);
  }

  const sendLogs = async () => {
    try {
      const logs = await getLogs(50);
      const lines = logs.split('\n');

      // Process last 30 lines to keep UI responsive
      const recentLines = lines.slice(-30);

      for (const line of recentLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // Clean ANSI escape codes for display - be more aggressive
        let cleanLine = trimmedLine
          .replace(/\x1b\[[0-9;]*m/g, '')  // Standard ANSI escapes
          .replace(/\[m/g, '')              // Standalone [m
          .replace(/\[\d+;\d+m/g, '')       // Color codes like [0;32m without ESC
          .replace(/\[0m/g, '');            // Reset codes

        // Skip if we've already sent this line (use hash of content)
        const lineHash = cleanLine.substring(0, 100);
        if (seenLines.has(lineHash)) continue;
        seenLines.add(lineHash);

        // Keep seen lines set manageable
        if (seenLines.size > 200) {
          const toDelete = Array.from(seenLines).slice(0, 100);
          toDelete.forEach(h => seenLines.delete(h));
        }

        // Determine log level from content
        let level: 'info' | 'warning' | 'error' = 'info';
        if (cleanLine.includes('WARN]') || cleanLine.includes('WARNING')) {
          level = 'warning';
        } else if (cleanLine.includes('ERROR]') || cleanLine.includes('Exception')) {
          level = 'error';
        }

        // Send log line event
        res.write(`data: ${JSON.stringify({ type: 'log', message: cleanLine, level })}\n\n`);

        // Check for server booted - look for the actual boot message
        if (!serverBootedDetected && (
          cleanLine.includes('Server Booted') ||
          cleanLine.includes('Hytale Server Booted')
        )) {
          serverBootedDetected = true;
          console.log('[Setup] Server boot detected from live logs');
        }

        // Check for authentication required
        if (!authRequiredDetected && (
          cleanLine.includes('No server tokens configured') ||
          cleanLine.includes('/auth login') ||
          cleanLine.includes('AUTHENTICATION REQUIRED')
        )) {
          authRequiredDetected = true;
          console.log('[Setup] Auth required detected from live logs');
        }
      }

      // Send status events (only once) when both conditions are met
      if (serverBootedDetected && authRequiredDetected && !statusEventSent) {
        statusEventSent = true;
        console.log('[Setup] Sending server started + auth required events');
        res.write(`data: ${JSON.stringify({ type: 'started', authenticated: false })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'auth_required' })}\n\n`);
      } else if (serverBootedDetected && serverAuthState?.authenticated && !statusEventSent) {
        statusEventSent = true;
        console.log('[Setup] Sending server started (authenticated) event');
        res.write(`data: ${JSON.stringify({ type: 'started', authenticated: true })}\n\n`);
      }
    } catch (error) {
      console.error('[Setup] Error in sendLogs:', error);
    }
  };

  // Initial send
  await sendLogs();

  // Send updates every 2 seconds
  const interval = setInterval(sendLogs, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ==========================================
// Server Auth Endpoints
// ==========================================

/**
 * POST /api/setup/auth/server/start
 * Start server OAuth device code flow by sending /auth login device command
 */
router.post('/auth/server/start', async (_req: Request, res: Response) => {
  try {
    // Initialize auth state
    serverAuthState = {
      serverStarted: true,
      authCode: '',
      authUrl: '',
      authenticated: false,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };

    // Send the /auth login device command to initiate authentication
    console.log('[Setup] Sending /auth login device command...');
    const cmdResult = await execCommand('/auth login device');
    if (!cmdResult.success) {
      console.error('[Setup] Failed to send auth command:', cmdResult.error);
    } else {
      console.log('[Setup] Auth command sent successfully');
    }

    // Wait a moment for the server to process the command
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Poll for auth code in logs with timeout (max 30 seconds, check every 2 seconds)
    let oauthInfo: ReturnType<typeof parseOAuthFromLogs> = {};
    const maxAttempts = 15;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const logs = await getLogs(200);
      oauthInfo = parseOAuthFromLogs(logs);

      // Check if we found a valid auth code (must be alphanumeric, 4-12 chars)
      if (oauthInfo.userCode && /^[A-Za-z0-9]{4,12}$/.test(oauthInfo.userCode)) {
        console.log(`[Setup] Found auth code after ${attempt + 1} attempts: ${oauthInfo.userCode}`);
        break;
      }

      // Check if already authenticated
      if (oauthInfo.authenticated) {
        console.log('[Setup] Server already authenticated');
        break;
      }

      // Wait 2 seconds before next attempt
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (oauthInfo.userCode && /^[A-Za-z0-9]{4,12}$/.test(oauthInfo.userCode)) {
      serverAuthState.authCode = oauthInfo.userCode;
    }
    if (oauthInfo.verificationUrl) {
      serverAuthState.authUrl = oauthInfo.verificationUrl;
    }
    if (oauthInfo.authenticated) {
      serverAuthState.authenticated = true;
    }

    // If no valid code found after polling, return error
    if (!serverAuthState.authCode && !serverAuthState.authenticated) {
      console.log('[Setup] No auth code found in logs after polling');
      res.json({
        success: false,
        error: 'Auth code not found in server logs. Please ensure the server is running and needs authentication.',
      });
      return;
    }

    res.json({
      success: true,
      deviceCode: serverAuthState.authCode, // Frontend expects deviceCode to be truthy
      userCode: serverAuthState.authCode,
      verificationUrl: serverAuthState.authUrl,
      expiresIn: 900,
      pollInterval: 5,
    });
  } catch (error) {
    console.error('[Setup] Failed to start server auth:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start server authentication',
    });
  }
});

/**
 * GET /api/setup/auth/server/status
 * Check server authentication status
 */
router.get('/auth/server/status', async (_req: Request, res: Response) => {
  try {
    if (!serverAuthState) {
      res.json({
        authenticated: false,
        error: 'No auth in progress',
      });
      return;
    }

    // Check container logs for auth status
    const logs = await getLogs(200);
    const oauthInfo = parseOAuthFromLogs(logs);

    if (oauthInfo.authenticated) {
      serverAuthState.authenticated = true;
    }
    if (oauthInfo.userCode && !serverAuthState.authCode) {
      serverAuthState.authCode = oauthInfo.userCode;
    }
    if (oauthInfo.verificationUrl && !serverAuthState.authUrl) {
      serverAuthState.authUrl = oauthInfo.verificationUrl;
    }

    res.json({
      authenticated: serverAuthState.authenticated,
      authCode: serverAuthState.authCode,
      authUrl: serverAuthState.authUrl,
      expired: new Date() > serverAuthState.expiresAt,
    });
  } catch (error) {
    console.error('[Setup] Failed to check server auth status:', error);
    res.status(500).json({
      authenticated: false,
      error: 'Failed to check authentication status',
    });
  }
});

/**
 * POST /api/setup/auth/initiate
 * Initiate server authentication (legacy endpoint)
 */
router.post('/auth/initiate', async (_req: Request, res: Response) => {
  try {
    const logs = await getLogs(200);
    const oauthInfo = parseOAuthFromLogs(logs);

    res.json({
      success: true,
      authCode: oauthInfo.userCode || '',
      authUrl: oauthInfo.verificationUrl || '',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to initiate authentication',
    });
  }
});

/**
 * POST /api/setup/auth/verify
 * Verify authentication with device code (legacy endpoint)
 */
router.post('/auth/verify', async (_req: Request, res: Response) => {
  try {
    const logs = await getLogs(200);
    const oauthInfo = parseOAuthFromLogs(logs);

    res.json({
      success: oauthInfo.authenticated || false,
      authenticated: oauthInfo.authenticated || false,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to verify authentication',
    });
  }
});

/**
 * POST /api/setup/auth/persistence
 * Setup token persistence by sending /auth persistence Encrypted command
 */
router.post('/auth/persistence', async (_req: Request, res: Response) => {
  try {
    // Send the /auth persistence Encrypted command to make tokens persistent
    console.log('[Setup] Sending /auth persistence Encrypted command...');
    const cmdResult = await execCommand('/auth persistence Encrypted');

    if (!cmdResult.success) {
      console.error('[Setup] Failed to send persistence command:', cmdResult.error);
      res.status(500).json({
        success: false,
        error: 'Failed to send persistence command: ' + cmdResult.error,
      });
      return;
    }

    console.log('[Setup] Persistence command sent successfully');
    res.json({
      success: true,
      message: 'Persistence configured',
    });
  } catch (error) {
    console.error('[Setup] Failed to setup persistence:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to setup persistence',
    });
  }
});

// ==========================================
// Plugin & Utility Endpoints
// ==========================================

/**
 * POST /api/setup/plugins/install/:pluginId
 * Install a plugin during setup
 */
router.post('/plugins/install/:pluginId', async (req: Request, res: Response) => {
  try {
    const { pluginId } = req.params;

    // For now, just acknowledge the request
    // Actual plugin installation would happen here
    console.log(`[Setup] Plugin installation requested: ${pluginId}`);

    res.json({
      success: true,
      message: `Plugin ${pluginId} installation initiated`,
      pluginId,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to install plugin',
    });
  }
});

/**
 * POST /api/setup/skip
 * Skip setup (development only)
 */
router.post('/skip', async (_req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({
      success: false,
      error: 'Cannot skip setup in production',
    });
    return;
  }

  try {
    res.json({
      success: true,
      message: 'Setup skipped',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to skip setup',
    });
  }
});

export default router;
